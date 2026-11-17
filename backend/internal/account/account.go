// Package account exports a person's data and deletes their account, as Settings > Account offers. Both run as jobs in
// the account function (cmd/account): a five-year history with its photos outlasts an API request, and a deletion has to
// carry on by itself after the person's sign-in is gone. Every step works only in the caller's own partition, under
// their own prefix in the bucket, and on their own sign-in, all named by the sub the gateway verified.
//
// A deletion, as docs/retention.md says:
//  1. The API writes meta#deleted in the person's partition, which refuses their devices' syncs from then on, and an
//     entry under account#deleting, which is how the schedule finds a deletion to carry on.
//  2. The job ends their Google connection, deletes their sign-in, their files and every item in their partition but
//     the mark. Each step is safe to run again, so a run that fails part way is simply run again.
//  3. The schedule runs it again every few minutes. Once every token issued before the sign-in went has lapsed, the run
//     that finds nothing left removes the mark and the entry, and nothing of the person stays.
package account

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

const (
	// pendingPK holds an entry per deletion under way, by sub, so the schedule can find them without reading the table.
	pendingPK = "account#deleting"
	// Settle is how long a deletion's mark stays after it starts: Cognito's access tokens last an hour, and none can be
	// issued once the sign-in is gone, so by then no device can reach the API as the person. Until then a device that
	// still holds one is refused, and each run removes anything written meanwhile, such as a file whose upload link was
	// granted just before.
	Settle = 70 * time.Minute
	// batchSize is the most deletes BatchWriteItem takes at once.
	batchSize   = 25
	maxBatchTry = 8
)

// DB is the part of DynamoDB the jobs use.
type DB interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	BatchWriteItem(context.Context, *dynamodb.BatchWriteItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error)
}

// Records reads every record a person has. *sync.Store implements it.
type Records interface {
	Each(ctx context.Context, sub string, fn func(sync.Change) error) error
}

// Objects is the files bucket. *S3Objects and the local stack's stand-in implement it.
type Objects interface {
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Put(ctx context.Context, key string, body io.Reader, contentType, disposition string) error
	List(ctx context.Context, prefix string) ([]string, error)
	// DeleteAll removes keys, and succeeds for keys already gone.
	DeleteAll(ctx context.Context, keys []string) error
}

// Identity is the user pool. *CognitoIdentity and the local stack's stand-in implement it.
type Identity interface {
	// Exists reports whether a sign-in with this sub exists.
	Exists(ctx context.Context, sub string) (bool, error)
	// Delete removes the sign-in with this sub, which ends every refresh token it has, and succeeds when there is none.
	Delete(ctx context.Context, sub string) error
}

// Google ends a person's Google connection: access revoked at Google and the stored connection deleted. *gcal.Google
// implements it.
type Google interface {
	Forget(ctx context.Context, sub string) error
}

// Job is what the account function is asked to do: build an export or carry on a deletion for one person, or, from the
// schedule with no kind, carry on every deletion under way.
type Job struct {
	Kind string `json:"job,omitempty"`
	Sub  string `json:"sub,omitempty"`
}

const (
	JobExport = "export"
	JobDelete = "delete"
)

// Service runs both jobs, and answers the API's routes for them.
type Service struct {
	DB      DB
	Table   string
	Records Records
	// Objects is nil where the environment stores no files, so there are none to delete, and in the API, which only
	// signs links to what the account function built.
	Objects  Objects
	Identity Identity
	// Google is nil where the environment has no calendar.
	Google Google
	// Sign makes a download link for an export's key that works until expires. Nil where no files are stored, which has
	// nowhere to put an export, and in the account function.
	Sign func(ctx context.Context, key string, expires time.Time) (string, error)
	// Start runs a job in the account function without waiting for it. Nil runs nothing: the schedule carries
	// deletions on, as tests do by calling Run.
	Start func(ctx context.Context, job Job) error
	Now   func() time.Time
	Log   *slog.Logger
	Env   string
	// Settle overrides the package's Settle, for tests.
	Settle time.Duration
}

// Run does a job in the account function.
func (s *Service) Run(ctx context.Context, job Job) error {
	switch job.Kind {
	case JobExport:
		return s.BuildExport(ctx, job.Sub)
	case JobDelete:
		return s.Continue(ctx, job.Sub)
	case "":
		return s.Resume(ctx)
	}
	return fmt.Errorf("account: no job %q", job.Kind)
}

// Delete starts deleting the caller's account: from now their devices are refused, and the job does the rest. Asking
// again, as when the first answer was lost, changes nothing.
func (s *Service) Delete(ctx context.Context, sub string) error {
	if sub == "" {
		return errors.New("account: no user")
	}
	now := s.Now()
	// The entry first: a mark with no entry would refuse the devices with nothing to delete their data.
	if err := s.setStarted(ctx, pendingPK, sub, now); err != nil {
		return err
	}
	if err := s.setStarted(ctx, userKey(sub), sync.DeletedKey, now); err != nil {
		return err
	}
	s.start(ctx, Job{Kind: JobDelete, Sub: sub})
	return nil
}

// start runs a job now. If it can't start, the schedule picks a deletion up within minutes, and the app asks for an
// export again.
func (s *Service) start(ctx context.Context, job Job) {
	if s.Start == nil {
		return
	}
	if err := s.Start(ctx, job); err != nil {
		s.Log.Info("account_job", "job", job.Kind, "outcome", "not_started", "error_type", "start")
	}
}

// setStarted writes an item's started_at unless it has one, so asking again keeps the first time.
func (s *Service) setStarted(ctx context.Context, pk, sk string, now time.Time) error {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       key(pk, sk),
		UpdateExpression:          aws.String("SET started_at = if_not_exists(started_at, :now)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":now": str(now.UTC().Format(time.RFC3339))},
	})
	if err != nil {
		return fmt.Errorf("account: start: %w", err)
	}
	return nil
}

// Deleted reports whether the person's account is being deleted, which refuses every route but the one that asks again.
func (s *Service) Deleted(ctx context.Context, sub string) (bool, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table), Key: key(userKey(sub), sync.DeletedKey), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return false, fmt.Errorf("account: read: %w", err)
	}
	return out.Item != nil, nil
}

// Gone reports whether an account was deleted, or is being deleted: what a device whose token has lapsed asks, so it
// wipes its copy rather than waiting to sign in again. Once the mark has gone, the sign-in's absence says so.
func (s *Service) Gone(ctx context.Context, sub string) (bool, error) {
	deleted, err := s.Deleted(ctx, sub)
	if err != nil || deleted {
		return deleted, err
	}
	exists, err := s.Identity.Exists(ctx, sub)
	return !exists, err
}

// Resume carries on every deletion under way, as the schedule asks every few minutes. One person's failure doesn't stop
// the rest, and their next run tries again.
func (s *Service) Resume(ctx context.Context) error {
	var start map[string]types.AttributeValue
	var failed error
	for {
		out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
			TableName:                 aws.String(s.Table),
			ConsistentRead:            aws.Bool(true),
			ExclusiveStartKey:         start,
			KeyConditionExpression:    aws.String("pk = :pending"),
			ExpressionAttributeValues: map[string]types.AttributeValue{":pending": str(pendingPK)},
		})
		if err != nil {
			return fmt.Errorf("account: resume: %w", err)
		}
		for _, item := range out.Items {
			if err := s.Continue(ctx, stringAttr(item["sk"])); err != nil {
				failed = errors.Join(failed, err)
			}
		}
		if len(out.LastEvaluatedKey) == 0 {
			return failed
		}
		start = out.LastEvaluatedKey
	}
}

// Continue runs one person's deletion as far as it can go. Every step is safe to run again.
func (s *Service) Continue(ctx context.Context, sub string) error {
	if sub == "" {
		return errors.New("account: no user")
	}
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table), Key: key(pendingPK, sub), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return fmt.Errorf("account: read: %w", err)
	}
	// Finished already, or never asked for: nothing of anyone is touched without the entry the caller's request wrote.
	if out.Item == nil {
		return nil
	}
	started, err := time.Parse(time.RFC3339, stringAttr(out.Item["started_at"]))
	if err != nil {
		return errors.New("account: entry has no start")
	}
	step, err := s.deleteAll(ctx, sub, started)
	if err != nil {
		// Counted, never who.
		attrs := append([]any{"outcome", "failed", "step", step}, sync.ErrorAttrs(err)...)
		s.Log.Info("account_delete", append(attrs, obs.Metrics(s.Env, s.Now(), map[string]int{"AccountDeletionFailures": 1})...)...)
		return fmt.Errorf("account: delete: %s: %w", step, err)
	}
	return nil
}

// deleteAll is the deletion's steps in order, and the step that failed. Google goes first, while the calendar record
// still says which calendar it made there.
func (s *Service) deleteAll(ctx context.Context, sub string, started time.Time) (string, error) {
	// The mark again, in case the request that wrote the entry stopped before it.
	if err := s.setStarted(ctx, userKey(sub), sync.DeletedKey, started); err != nil {
		return "mark", err
	}
	if s.Google != nil {
		if err := s.Google.Forget(ctx, sub); err != nil {
			return "google", err
		}
	}
	if err := s.Identity.Delete(ctx, sub); err != nil {
		return "sign_in", err
	}
	if s.Objects != nil {
		for _, prefix := range Prefixes(sub) {
			keys, err := s.Objects.List(ctx, prefix)
			if err == nil && len(keys) > 0 {
				err = s.Objects.DeleteAll(ctx, keys)
			}
			if err != nil {
				return "files", err
			}
		}
	}
	if err := s.purge(ctx, sub); err != nil {
		return "records", err
	}
	settle := s.Settle
	if settle == 0 {
		settle = Settle
	}
	if s.Now().Before(started.Add(settle)) {
		return "", nil
	}
	// Nothing is left and no token can reach the API as them, so the mark goes, then the entry: a failure between them
	// leaves the entry, and the next run finds nothing to do but remove it.
	for _, k := range []map[string]types.AttributeValue{key(userKey(sub), sync.DeletedKey), key(pendingPK, sub)} {
		if _, err := s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: aws.String(s.Table), Key: k}); err != nil {
			return "finish", err
		}
	}
	s.Log.Info("account_delete", append([]any{"outcome", "deleted"}, obs.Metrics(s.Env, s.Now(), map[string]int{"AccountsDeleted": 1})...)...)
	return "", nil
}

// Prefixes are where a person's objects are in the files bucket: their attachments' files, which internal/files puts
// under their hashed sub, and their exports. Each ends in a slash, so no one else's is a match.
func Prefixes(sub string) []string {
	hash := obs.HashSub(sub)
	return []string{"u/" + hash + "/", "exports/" + hash + "/"}
}

// purge deletes every item in the person's partition but the mark, a page at a time.
func (s *Service) purge(ctx context.Context, sub string) error {
	var start map[string]types.AttributeValue
	for {
		out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
			TableName:                 aws.String(s.Table),
			ConsistentRead:            aws.Bool(true),
			ExclusiveStartKey:         start,
			KeyConditionExpression:    aws.String("pk = :user"),
			ProjectionExpression:      aws.String("pk, sk"),
			ExpressionAttributeValues: map[string]types.AttributeValue{":user": str(userKey(sub))},
		})
		if err != nil {
			return err
		}
		var keys []map[string]types.AttributeValue
		for _, item := range out.Items {
			if stringAttr(item["sk"]) != sync.DeletedKey {
				keys = append(keys, key(userKey(sub), stringAttr(item["sk"])))
			}
		}
		for i := 0; i < len(keys); i += batchSize {
			if err := s.deleteBatch(ctx, keys[i:min(i+batchSize, len(keys))]); err != nil {
				return err
			}
		}
		if len(out.LastEvaluatedKey) == 0 {
			return nil
		}
		start = out.LastEvaluatedKey
	}
}

// deleteBatch deletes up to 25 items, sending again what DynamoDB left unprocessed, as it does past a partition's write
// rate, with a growing wait.
func (s *Service) deleteBatch(ctx context.Context, keys []map[string]types.AttributeValue) error {
	requests := make([]types.WriteRequest, len(keys))
	for i, k := range keys {
		requests[i] = types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: k}}
	}
	for try := 0; ; try++ {
		out, err := s.DB.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: map[string][]types.WriteRequest{s.Table: requests}})
		if err != nil {
			return err
		}
		requests = out.UnprocessedItems[s.Table]
		if len(requests) == 0 {
			return nil
		}
		if try == maxBatchTry {
			return errors.New("account: deletes still unprocessed")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(try+1) * 100 * time.Millisecond):
		}
	}
}

func userKey(sub string) string { return "user#" + sub }

func key(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": str(pk), "sk": str(sk)}
}

func str(s string) types.AttributeValue { return &types.AttributeValueMemberS{Value: s} }

func stringAttr(value types.AttributeValue) string {
	if s, ok := value.(*types.AttributeValueMemberS); ok {
		return s.Value
	}
	return ""
}
