package gcal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	gosync "sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

// SSMSecrets keeps secrets in SSM SecureString parameters under a prefix.
type SSMSecrets struct {
	Client *ssm.Client
	Prefix string
}

func (s *SSMSecrets) Get(ctx context.Context, name string) (string, error) {
	out, err := s.Client.GetParameter(ctx, &ssm.GetParameterInput{
		Name: aws.String(s.Prefix + "/" + name), WithDecryption: aws.Bool(true),
	})
	var missing *ssmtypes.ParameterNotFound
	if errors.As(err, &missing) {
		return "", ErrNoSecret
	}
	if err != nil {
		return "", err
	}
	return aws.ToString(out.Parameter.Value), nil
}

func (s *SSMSecrets) Put(ctx context.Context, name, value string) error {
	_, err := s.Client.PutParameter(ctx, &ssm.PutParameterInput{
		Name: aws.String(s.Prefix + "/" + name), Value: aws.String(value),
		Type: ssmtypes.ParameterTypeSecureString, Overwrite: aws.Bool(true),
	})
	return err
}

func (s *SSMSecrets) Delete(ctx context.Context, name string) error {
	_, err := s.Client.DeleteParameter(ctx, &ssm.DeleteParameterInput{Name: aws.String(s.Prefix + "/" + name)})
	var missing *ssmtypes.ParameterNotFound
	if errors.As(err, &missing) {
		return nil
	}
	return err
}

// DynamoStates keeps the pending consent's nonce beside the user's records. It has no seq, so it's never pulled, and a
// new consent replaces it, so only one item per user ever exists.
type DynamoStates struct {
	DB    *dynamodb.Client
	Table string
}

func (s *DynamoStates) key(sub string) map[string]dynamotypes.AttributeValue {
	return map[string]dynamotypes.AttributeValue{
		"pk": &dynamotypes.AttributeValueMemberS{Value: "user#" + sub},
		"sk": &dynamotypes.AttributeValueMemberS{Value: "meta#calendar_state"},
	}
}

func (s *DynamoStates) Put(ctx context.Context, sub, nonce string) error {
	item := s.key(sub)
	item["nonce"] = &dynamotypes.AttributeValueMemberS{Value: nonce}
	_, err := s.DB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.Table), Item: item})
	return err
}

func (s *DynamoStates) Consume(ctx context.Context, sub, nonce string) (bool, error) {
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       s.key(sub),
		UpdateExpression:          aws.String("REMOVE nonce"),
		ConditionExpression:       aws.String("nonce = :nonce"),
		ExpressionAttributeValues: map[string]dynamotypes.AttributeValue{":nonce": &dynamotypes.AttributeValueMemberS{Value: nonce}},
	})
	var refused *dynamotypes.ConditionalCheckFailedException
	if errors.As(err, &refused) {
		return false, nil
	}
	return err == nil, err
}

// DynamoConnections keeps each person's connection in the table, with the refresh token encrypted by KMS under an
// encryption context naming the person, so a token copied to another person's item doesn't decrypt. Two kinds of item,
// outside every user's partition so neither sync nor retention ever reads them:
//   - google#connection / <sub>: the sealed token, the Google account's id and when it connected. One partition, so the
//     schedule finds everyone connected with one paged query. It's read once a run, well under a partition's limit.
//   - google#account / <account id>: who holds that Google account, so a second person can't connect it.
//
// A token is encrypted directly by KMS rather than under a data key of our own: it's under KMS's 4 KB limit, and each
// person's context then shows in CloudTrail for every decrypt. A decrypt names the key, so nothing sealed by another key
// opens, even with this person's context.
type DynamoConnections struct {
	DB    ConnectionsDB
	Table string
	KMS   KMSClient
	// KeyID is the KMS key tokens are encrypted with.
	KeyID string
	// Env is in every token's encryption context, so one environment's grants never open another's tokens.
	Env string
	Now func() time.Time
}

// ConnectionsDB is the part of DynamoDB that DynamoConnections uses.
type ConnectionsDB interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

// KMSClient is the part of KMS that DynamoConnections uses.
type KMSClient interface {
	Encrypt(context.Context, *kms.EncryptInput, ...func(*kms.Options)) (*kms.EncryptOutput, error)
	Decrypt(context.Context, *kms.DecryptInput, ...func(*kms.Options)) (*kms.DecryptOutput, error)
}

const (
	connectionPK = "google#connection"
	accountPK    = "google#account"
	// tokenPurpose is in every token's encryption context, so the key's grants can be limited to this use.
	tokenPurpose = "google-refresh-token"
)

func connectionKey(sub string) map[string]dynamotypes.AttributeValue {
	return map[string]dynamotypes.AttributeValue{
		"pk": &dynamotypes.AttributeValueMemberS{Value: connectionPK},
		"sk": &dynamotypes.AttributeValueMemberS{Value: sub},
	}
}

func accountKey(account string) map[string]dynamotypes.AttributeValue {
	return map[string]dynamotypes.AttributeValue{
		"pk": &dynamotypes.AttributeValueMemberS{Value: accountPK},
		"sk": &dynamotypes.AttributeValueMemberS{Value: account},
	}
}

// tokenContext binds a sealed token to its environment and person.
func (c *DynamoConnections) tokenContext(sub string) map[string]string {
	return map[string]string{"purpose": tokenPurpose, "env": c.Env, "sub": sub}
}

func (c *DynamoConnections) Peek(ctx context.Context, sub string) (connection, error) {
	out, err := c.DB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(c.Table), Key: connectionKey(sub), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return connection{}, fmt.Errorf("gcal: read connection: %w", err)
	}
	sealed, ok := out.Item["token"].(*dynamotypes.AttributeValueMemberB)
	if !ok {
		return connection{}, ErrNotConnected
	}
	conn := connection{Sub: sub, sealed: sealed.Value}
	if account, ok := out.Item["account"].(*dynamotypes.AttributeValueMemberS); ok {
		conn.Account = account.Value
	}
	_, conn.Revoked = out.Item["revoked_at"]
	return conn, nil
}

func (c *DynamoConnections) Get(ctx context.Context, sub string) (connection, error) {
	conn, err := c.Peek(ctx, sub)
	if err != nil {
		return conn, err
	}
	opened, err := c.KMS.Decrypt(ctx, &kms.DecryptInput{CiphertextBlob: conn.sealed, KeyId: aws.String(c.KeyID), EncryptionContext: c.tokenContext(sub)})
	var invalid *kmstypes.InvalidCiphertextException
	var otherKey *kmstypes.IncorrectKeyException
	if errors.As(err, &invalid) || errors.As(err, &otherKey) {
		return connection{}, fmt.Errorf("%w: %w", errUnreadable, err)
	}
	if err != nil {
		return connection{}, fmt.Errorf("gcal: connection doesn't decrypt for this person: %w", err)
	}
	conn.RefreshToken = string(opened.Plaintext)
	return conn, nil
}

func (c *DynamoConnections) Has(ctx context.Context, sub string) (bool, error) {
	out, err := c.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(c.Table), Key: connectionKey(sub), ConsistentRead: aws.Bool(true), ProjectionExpression: aws.String("pk, revoked_at"),
	})
	if err != nil {
		return false, fmt.Errorf("gcal: read connection: %w", err)
	}
	_, revoked := out.Item["revoked_at"]
	return out.Item != nil && !revoked, nil
}

func (c *DynamoConnections) MarkRevoked(ctx context.Context, conn connection) error {
	_, err := c.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(c.Table), Key: connectionKey(conn.Sub),
		UpdateExpression:         aws.String("SET revoked_at = :now"),
		ConditionExpression:      aws.String("#token = :token"),
		ExpressionAttributeNames: map[string]string{"#token": "token"},
		ExpressionAttributeValues: map[string]dynamotypes.AttributeValue{
			":token": &dynamotypes.AttributeValueMemberB{Value: conn.sealed},
			":now":   &dynamotypes.AttributeValueMemberS{Value: instant(c.Now())},
		},
	})
	var replaced *dynamotypes.ConditionalCheckFailedException
	if errors.As(err, &replaced) {
		// They connected again, or disconnected, since the run read it.
		return nil
	}
	if err != nil {
		return fmt.Errorf("gcal: mark connection revoked: %w", err)
	}
	return nil
}

func (c *DynamoConnections) Holder(ctx context.Context, account string) (string, error) {
	out, err := c.DB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(c.Table), Key: accountKey(account), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return "", fmt.Errorf("gcal: read account: %w", err)
	}
	holder, _ := out.Item["sub"].(*dynamotypes.AttributeValueMemberS)
	if holder == nil {
		return "", nil
	}
	return holder.Value, nil
}

func (c *DynamoConnections) Put(ctx context.Context, conn connection, previous connection) error {
	_, err := c.put(ctx, conn, previous)
	return err
}

func (c *DynamoConnections) put(ctx context.Context, conn connection, previous connection) ([]byte, error) {
	sealed, err := c.KMS.Encrypt(ctx, &kms.EncryptInput{KeyId: aws.String(c.KeyID), Plaintext: []byte(conn.RefreshToken), EncryptionContext: c.tokenContext(conn.Sub)})
	if err != nil {
		// Only the error's type: its request held the token.
		return nil, fmt.Errorf("gcal: seal connection: %T", err)
	}
	item := connectionKey(conn.Sub)
	item["token"] = &dynamotypes.AttributeValueMemberB{Value: sealed.CiphertextBlob}
	item["connected_at"] = &dynamotypes.AttributeValueMemberS{Value: instant(c.Now())}
	stored := &dynamotypes.Put{TableName: aws.String(c.Table), Item: item, ConditionExpression: aws.String("attribute_not_exists(pk)")}
	if previous.sealed != nil {
		stored.ConditionExpression = aws.String("#token = :previous")
		stored.ExpressionAttributeNames = map[string]string{"#token": "token"}
		stored.ExpressionAttributeValues = map[string]dynamotypes.AttributeValue{":previous": &dynamotypes.AttributeValueMemberB{Value: previous.sealed}}
	}
	writes := []dynamotypes.TransactWriteItem{{Put: stored}}
	if conn.Account != "" {
		item["account"] = &dynamotypes.AttributeValueMemberS{Value: conn.Account}
		claim := accountKey(conn.Account)
		claim["sub"] = &dynamotypes.AttributeValueMemberS{Value: conn.Sub}
		writes = append(writes, dynamotypes.TransactWriteItem{Put: &dynamotypes.Put{
			TableName: aws.String(c.Table), Item: claim,
			ConditionExpression:       aws.String("attribute_not_exists(pk) OR #sub = :sub"),
			ExpressionAttributeNames:  map[string]string{"#sub": "sub"},
			ExpressionAttributeValues: map[string]dynamotypes.AttributeValue{":sub": &dynamotypes.AttributeValueMemberS{Value: conn.Sub}},
		}})
	}
	if previous.Account != "" && previous.Account != conn.Account {
		writes = append(writes, c.release(previous.Account, conn.Sub))
	}
	_, err = c.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: writes})
	switch failed, _ := cancelledAt(err); failed {
	case 0:
		return nil, errConnectionChanged
	case 1:
		return nil, api.ErrAccountTaken
	}
	if err != nil {
		return nil, fmt.Errorf("gcal: store connection: %w", err)
	}
	return sealed.CiphertextBlob, nil
}

func (c *DynamoConnections) Delete(ctx context.Context, conn connection) error {
	remove := &dynamotypes.Delete{TableName: aws.String(c.Table), Key: connectionKey(conn.Sub)}
	if conn.sealed != nil {
		remove.ConditionExpression = aws.String("attribute_not_exists(pk) OR #token = :token")
		remove.ExpressionAttributeNames = map[string]string{"#token": "token"}
		remove.ExpressionAttributeValues = map[string]dynamotypes.AttributeValue{":token": &dynamotypes.AttributeValueMemberB{Value: conn.sealed}}
	}
	writes := []dynamotypes.TransactWriteItem{{Delete: remove}}
	if conn.Account != "" {
		writes = append(writes, c.release(conn.Account, conn.Sub))
	}
	_, err := c.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: writes})
	if failed, _ := cancelledAt(err); failed == 0 {
		return errConnectionChanged
	}
	if err != nil {
		return fmt.Errorf("gcal: delete connection: %w", err)
	}
	return nil
}

// release gives up a Google account's claim, only if sub holds it.
func (c *DynamoConnections) release(account, sub string) dynamotypes.TransactWriteItem {
	return dynamotypes.TransactWriteItem{Delete: &dynamotypes.Delete{
		TableName: aws.String(c.Table), Key: accountKey(account),
		ConditionExpression:       aws.String("attribute_not_exists(pk) OR #sub = :sub"),
		ExpressionAttributeNames:  map[string]string{"#sub": "sub"},
		ExpressionAttributeValues: map[string]dynamotypes.AttributeValue{":sub": &dynamotypes.AttributeValueMemberS{Value: sub}},
	}}
}

// cancelledAt says which write of a cancelled transaction failed its condition, or -1.
func cancelledAt(err error) (int, bool) {
	var cancelled *dynamotypes.TransactionCanceledException
	if !errors.As(err, &cancelled) {
		return -1, false
	}
	for i, reason := range cancelled.CancellationReasons {
		if aws.ToString(reason.Code) == "ConditionalCheckFailed" {
			return i, true
		}
	}
	return -1, false
}

func (c *DynamoConnections) Each(ctx context.Context, fn func(sub string) error) error {
	var start map[string]dynamotypes.AttributeValue
	for {
		out, err := c.DB.Query(ctx, &dynamodb.QueryInput{
			TableName:                 aws.String(c.Table),
			KeyConditionExpression:    aws.String("pk = :pk"),
			ExpressionAttributeValues: map[string]dynamotypes.AttributeValue{":pk": &dynamotypes.AttributeValueMemberS{Value: connectionPK}},
			FilterExpression:          aws.String("attribute_not_exists(revoked_at)"),
			ProjectionExpression:      aws.String("sk"),
			ExclusiveStartKey:         start,
		})
		if err != nil {
			return fmt.Errorf("gcal: list connections: %w", err)
		}
		for _, item := range out.Items {
			if sub, ok := item["sk"].(*dynamotypes.AttributeValueMemberS); ok {
				if err := fn(sub.Value); err != nil {
					return err
				}
			}
		}
		if out.LastEvaluatedKey == nil {
			return nil
		}
		start = out.LastEvaluatedKey
	}
}

// cachedSecrets keeps the Google client's secrets for a while, since every person's run needs them and SSM allows 40
// reads a second across the account. Never the legacy connection, which a disconnect can delete at any time.
type cachedSecrets struct {
	Secrets
	ttl time.Duration
	now func() time.Time

	mu     gosync.Mutex
	values map[string]cachedSecret
}

type cachedSecret struct {
	value string
	until time.Time
}

func (c *cachedSecrets) Get(ctx context.Context, name string) (string, error) {
	if name == SecretRefreshToken {
		return c.Secrets.Get(ctx, name)
	}
	c.mu.Lock()
	held, ok := c.values[name]
	c.mu.Unlock()
	if ok && c.now().Before(held.until) {
		return held.value, nil
	}
	value, err := c.Secrets.Get(ctx, name)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.values[name] = cachedSecret{value, c.now().Add(c.ttl)}
	c.mu.Unlock()
	return value, nil
}

// SQSQueue starts people's runs through the worker's queue, ten to a request.
type SQSQueue struct {
	Client SQSClient
	URL    string
}

// SQSClient is the part of SQS that SQSQueue uses.
type SQSClient interface {
	SendMessageBatch(context.Context, *sqs.SendMessageBatchInput, ...func(*sqs.Options)) (*sqs.SendMessageBatchOutput, error)
}

// sendWorkers is how many batches go at once, so the schedule's ten thousand jobs take seconds, not minutes.
const sendWorkers = 8

func (q *SQSQueue) Send(ctx context.Context, jobs []Job) error {
	batches := make(chan []Job)
	errs := make(chan error, sendWorkers)
	var wg gosync.WaitGroup
	for range sendWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for batch := range batches {
				if err := q.sendBatch(ctx, batch); err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	for start := 0; start < len(jobs); start += 10 {
		select {
		case batches <- jobs[start:min(start+10, len(jobs))]:
		case err := <-errs:
			close(batches)
			wg.Wait()
			return err
		}
	}
	close(batches)
	wg.Wait()
	select {
	case err := <-errs:
		return err
	default:
		return nil
	}
}

// sendBatch sends up to ten jobs, and once more any SQS didn't take.
func (q *SQSQueue) sendBatch(ctx context.Context, jobs []Job) error {
	entries := make([]sqstypes.SendMessageBatchRequestEntry, len(jobs))
	for i, job := range jobs {
		body, err := json.Marshal(job)
		if err != nil {
			return err
		}
		entries[i] = sqstypes.SendMessageBatchRequestEntry{
			Id: aws.String(strconv.Itoa(i)), MessageBody: aws.String(string(body)), DelaySeconds: int32(job.Delay / time.Second),
		}
	}
	for attempt := 0; ; attempt++ {
		out, err := q.Client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{QueueUrl: aws.String(q.URL), Entries: entries})
		if err != nil {
			return fmt.Errorf("gcal: queue runs: %w", err)
		}
		if len(out.Failed) == 0 {
			return nil
		}
		if attempt == 1 {
			return fmt.Errorf("gcal: queue runs: %d not taken, first %s", len(out.Failed), aws.ToString(out.Failed[0].Code))
		}
		failed := map[string]bool{}
		for _, f := range out.Failed {
			failed[aws.ToString(f.Id)] = true
		}
		entries = slices.DeleteFunc(entries, func(e sqstypes.SendMessageBatchRequestEntry) bool { return !failed[aws.ToString(e.Id)] })
	}
}

// FromEnvironment builds the deployed connection from what the stack sets, for both Lambdas. expiry is the one the API's
// store has, so a calendar the worker removes expires like anything else deleted. Every run starts through the worker's
// queue, the API's refresh included, so the queue's concurrency bounds them all.
func FromEnvironment(cfg aws.Config, expiry *sync.Expiry) *Google {
	client := dynamodb.NewFromConfig(cfg)
	table := os.Getenv("TABLE_NAME")
	queue := &SQSQueue{Client: sqs.NewFromConfig(cfg), URL: os.Getenv("CALENDAR_QUEUE_URL")}
	start := func(trigger string, after time.Duration) func(ctx context.Context, sub string) error {
		return func(ctx context.Context, sub string) error {
			return queue.Send(ctx, []Job{{Sub: sub, Trigger: trigger, Delay: after}})
		}
	}
	return &Google{
		Records: &sync.Store{DB: client, Table: table, Expiry: expiry},
		Secrets: &cachedSecrets{
			Secrets: &SSMSecrets{Client: ssm.NewFromConfig(cfg), Prefix: os.Getenv("SSM_PREFIX")},
			ttl:     5 * time.Minute, now: time.Now, values: map[string]cachedSecret{},
		},
		Connections: &DynamoConnections{
			DB: client, Table: table, KMS: kms.NewFromConfig(cfg), KeyID: os.Getenv("GOOGLE_TOKEN_KEY"), Env: os.Getenv("ENV_NAME"), Now: time.Now,
		},
		States:      &DynamoStates{DB: client, Table: table},
		Log:         obs.NewLogger(os.Stdout),
		Env:         os.Getenv("ENV_NAME"),
		Now:         time.Now,
		AuthURL:     GoogleAuthURL,
		TokenURL:    GoogleTokenURL,
		RevokeURL:   GoogleRevokeURL,
		RedirectURL: os.Getenv("API_URL") + "/calendar/callback",
		Trigger:     start("refresh", 0),
		Queue:       queue,
		Retry: func(ctx context.Context, sub string, after time.Duration) error {
			return start(TriggerRetry, after)(ctx, sub)
		},
	}
}
