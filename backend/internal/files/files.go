// Package files grants the uploads and downloads of attachments' files, and counts what each person stores and fetches.
// The bytes go straight between the apps and S3 or CloudFront: the API only signs links, after checking the attachment
// record that synced, the person's hourly limits and their quota. What's in a file is never read, indexed or logged.
//
// Beside each person's records, in their own partition, the API keeps:
//   - file#<attachment id>: the file's key in the bucket, its size, type and hash, written when the upload is granted;
//   - meta#storage: the bytes of every file granted and not yet removed;
//   - meta#quota: a raised quota, written only by make storage-quota;
//   - meta#rate: this hour's start and its uploads and downloaded bytes.
//
// None has a sequence number, so pulls never return them, and sync writes only rec# items, so no app can change them.
// meta#rate holds its hour rather than expiring by TTL: TTL's removals reach the retention function's stream, which
// reads them as expired records.
package files

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/cloudfront/sign"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	"github.com/BSchrift/open-multiscale-planning/config"
)

const (
	// linkLife is how long a signed upload or download link works.
	linkLife = 5 * time.Minute
	// maxAttempts bounds the retries when another grant moves the same counters first.
	maxAttempts  = 3
	maxReadTries = 5

	attachmentType = "attachment"
	filePrefix     = "file#"
	storageKey     = "meta#storage"
	quotaKey       = "meta#quota"
	rateKey        = "meta#rate"
)

// ErrBusy means other grants kept moving the person's counters through every attempt. Nothing was granted, and asking
// again is safe.
var ErrBusy = errors.New("files: counters kept moving")

// Refusal is a grant refused for a reason the app shows. Code is stable for clients and safe to log.
type Refusal struct {
	Status int
	Code   string
	// RetryAt is when an hourly limit lets the next one through, for upload_rate and download_rate.
	RetryAt time.Time
	// Usage is set for quota_exceeded.
	Usage *Usage
}

func (r *Refusal) Error() string { return "files: refused: " + r.Code }

func refused(status int, code string) *Refusal { return &Refusal{Status: status, Code: code} }

// ErrInvalidRequest is a request that isn't one: no JSON, the wrong shape, or ids that can't be ids.
var ErrInvalidRequest = refused(http.StatusBadRequest, "invalid_request")

// DB is the part of DynamoDB the grants use.
type DB interface {
	BatchGetItem(context.Context, *dynamodb.BatchGetItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error)
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

// Records reads a synced record from its owner's partition. *sync.Store implements it.
type Records interface {
	Record(ctx context.Context, sub, recordType, id string) (sync.Fields, bool, error)
}

// Presigner signs an S3 PUT of exactly size bytes with these headers. *PutSigner implements it.
type Presigner interface {
	Presign(ctx context.Context, key string, size int64, headers map[string]string, at time.Time, expires time.Duration) (string, error)
}

// Limits are config/protocol.yaml's and the environment's attachment settings.
type Limits struct {
	MaxFileBytes         int64
	MaxIDsPerDownload    int
	ContentTypes         []string
	DefaultQuotaBytes    int64
	UploadsPerHour       int64
	DownloadBytesPerHour int64
}

// LimitsFor is the limits an environment's settings give.
func LimitsFor(env config.EnvConfig) Limits {
	p, q := config.Protocol.Attachments, env.Attachments
	return Limits{
		MaxFileBytes: int64(p.MaxFileBytes), MaxIDsPerDownload: p.MaxIDsPerDownload, ContentTypes: p.ContentTypes,
		DefaultQuotaBytes: int64(q.DefaultQuotaBytes), UploadsPerHour: int64(q.UploadsPerHour), DownloadBytesPerHour: int64(q.DownloadBytesPerHour),
	}
}

// Service is what the /files routes need.
type Service struct {
	DB      DB
	Table   string
	Records Records
	Uploads Presigner
	// FilesURL is the distribution's address, which download links point at; KeyID names the public key in its key group
	// that Key's private half matches.
	FilesURL string
	KeyID    string
	Key      SigningKey
	Limits   Limits
	Now      func() time.Time
	// Rand makes file ids. Nil is crypto/rand.
	Rand io.Reader
}

// Usage is what a person stores against their quota, in bytes.
type Usage struct {
	UsedBytes  int64 `json:"used_bytes"`
	QuotaBytes int64 `json:"quota_bytes"`
}

// Upload is the answer to POST /files/upload: a PUT link and the headers it has to be sent with.
type Upload struct {
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expires_at"`
	Usage
}

// Download is one file's link.
type Download struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Downloads is the answer to POST /files/download. Missing lists the ids with no file granted in the caller's partition.
type Downloads struct {
	Files   []Download `json:"files"`
	Missing []string   `json:"missing"`
}

// file is what an attachment's record says of its file, and what file#<id> keeps.
type file struct {
	key, contentType, sha256 string
	size                     int64
}

// counters is a person's file# items asked for and their meta# items, as read before a grant.
type counters struct {
	files              map[string]file
	usedBytes, quota   int64
	hour               int64
	uploads, downloads int64
}

func (c counters) usage() Usage { return Usage{c.usedBytes, c.quota} }

// GrantUpload signs an upload of the file an attachment record describes, as it synced to the caller's own partition.
// A grant for an attachment already granted, with the same size, type and hash, signs a fresh link without counting
// the file again.
func (s *Service) GrantUpload(ctx context.Context, sub, id string) (Upload, error) {
	if !sync.ValidID(id) {
		return Upload{}, ErrInvalidRequest
	}
	fields, found, err := s.Records.Record(ctx, sub, attachmentType, id)
	if err != nil {
		return Upload{}, err
	}
	if !found || !s.current(fields) {
		return Upload{}, refused(http.StatusNotFound, "not_found")
	}
	want, ok := described(fields)
	if !ok {
		return Upload{}, refused(http.StatusBadRequest, "invalid_attachment")
	}
	if want.size > s.Limits.MaxFileBytes {
		return Upload{}, refused(http.StatusRequestEntityTooLarge, "file_too_large")
	}
	if !slices.Contains(s.Limits.ContentTypes, want.contentType) {
		return Upload{}, refused(http.StatusUnsupportedMediaType, "type_not_allowed")
	}
	for attempt := 1; ; attempt++ {
		now := s.Now()
		c, err := s.read(ctx, sub, []string{id})
		if err != nil {
			return Upload{}, err
		}
		if granted, ok := c.files[id]; ok {
			if granted.size != want.size || granted.contentType != want.contentType || granted.sha256 != want.sha256 {
				return Upload{}, refused(http.StatusConflict, "attachment_changed")
			}
			return s.upload(ctx, granted, c.usage(), now)
		}
		hour := hourOf(now)
		if c.hour == hour.Unix() && c.uploads >= s.Limits.UploadsPerHour {
			return Upload{}, &Refusal{Status: http.StatusTooManyRequests, Code: "upload_rate", RetryAt: hour.Add(time.Hour)}
		}
		if c.usedBytes+want.size > c.quota {
			usage := c.usage()
			return Upload{}, &Refusal{Status: http.StatusForbidden, Code: "quota_exceeded", Usage: &usage}
		}
		if want.key, err = s.newKey(sub); err != nil {
			return Upload{}, err
		}
		err = s.grant(ctx, sub, id, want, c, hour)
		if err == nil {
			return s.upload(ctx, want, Usage{c.usedBytes + want.size, c.quota}, now)
		}
		if !conditionFailed(err) {
			return Upload{}, fmt.Errorf("files: grant: %w", err)
		}
		if attempt == maxAttempts {
			return Upload{}, ErrBusy
		}
	}
}

// current is whether a record is an attachment's photo or file that's still there: not deleted, not expired.
func (s *Service) current(fields sync.Fields) bool {
	if kind := fields["kind"].V; kind != "photo" && kind != "file" {
		return false
	}
	if fields["deleted_at"].V != nil {
		return false
	}
	expires, _ := fields["expires_at"].V.(string)
	at, err := time.Parse(time.RFC3339, expires)
	return err != nil || at.After(s.Now())
}

// described reads a record's size, type and hash, and whether they make sense: a whole number of bytes, a type, and the
// base64 of a SHA-256 digest, exactly as S3 takes it in x-amz-checksum-sha256.
func described(fields sync.Fields) (file, bool) {
	number, _ := fields["size"].V.(json.Number)
	size, err := strconv.ParseInt(string(number), 10, 64)
	contentType, _ := fields["type"].V.(string)
	hash, _ := fields["sha256"].V.(string)
	digest, hashErr := base64.StdEncoding.DecodeString(hash)
	if err != nil || size <= 0 || contentType == "" || hashErr != nil || len(digest) != 32 {
		return file{}, false
	}
	return file{contentType: contentType, sha256: hash, size: size}, true
}

// newKey is where a file goes: under the person's hashed sub, which their log lines carry too, at 128 random bits, so
// no key can be guessed or worked out from the task.
func (s *Service) newKey(sub string) (string, error) {
	random := s.Rand
	if random == nil {
		random = rand.Reader
	}
	id := make([]byte, 16)
	if _, err := io.ReadFull(random, id); err != nil {
		return "", err
	}
	return "u/" + obs.HashSub(sub) + "/" + hex.EncodeToString(id), nil
}

// grant writes file#<id>, adds its size to meta#storage and counts it in meta#rate, in one transaction. Each part is
// conditional on what the read found still holding, so a grant racing another can't pass the quota or the limit.
func (s *Service) grant(ctx context.Context, sub, id string, f file, c counters, hour time.Time) error {
	_, err := s.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: []types.TransactWriteItem{
		{Put: &types.Put{
			TableName: aws.String(s.Table),
			Item: map[string]types.AttributeValue{
				"pk": str(userKey(sub)), "sk": str(filePrefix + id),
				"key": str(f.key), "size": num(f.size), "type": str(f.contentType), "sha256": str(f.sha256),
			},
			ConditionExpression: aws.String("attribute_not_exists(sk)"),
		}},
		{Update: &types.Update{
			TableName:                 aws.String(s.Table),
			Key:                       key(sub, storageKey),
			UpdateExpression:          aws.String("ADD #value :size"),
			ConditionExpression:       aws.String("attribute_not_exists(#value) OR #value <= :room"),
			ExpressionAttributeNames:  map[string]string{"#value": "value"},
			ExpressionAttributeValues: map[string]types.AttributeValue{":size": num(f.size), ":room": num(c.quota - f.size)},
		}},
		{Update: s.countRate(sub, c, hour, 1, 0)},
	}})
	return err
}

// countRate adds to this hour's counts, or starts a new hour with them, on condition the counts still allow it.
func (s *Service) countRate(sub string, c counters, hour time.Time, uploads, downloads int64) *types.Update {
	update := &types.Update{
		TableName:                aws.String(s.Table),
		Key:                      key(sub, rateKey),
		ExpressionAttributeNames: map[string]string{"#hour": "hour"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":hour": num(hour.Unix()), ":uploads": num(uploads), ":downloads": num(downloads),
		},
	}
	if c.hour == hour.Unix() {
		update.UpdateExpression = aws.String("ADD uploads :uploads, download_bytes :downloads")
		update.ConditionExpression = aws.String("#hour = :hour AND uploads <= :uploadRoom AND download_bytes <= :downloadRoom")
		update.ExpressionAttributeValues[":uploadRoom"] = num(s.Limits.UploadsPerHour - uploads)
		update.ExpressionAttributeValues[":downloadRoom"] = num(s.Limits.DownloadBytesPerHour - downloads)
	} else {
		update.UpdateExpression = aws.String("SET #hour = :hour, uploads = :uploads, download_bytes = :downloads")
		update.ConditionExpression = aws.String("attribute_not_exists(#hour) OR #hour < :hour")
	}
	return update
}

// upload signs the PUT. S3 takes only a request with every signed header as it was signed, so it takes exactly these
// bytes: this size, type and hash. Anything but a JPEG or PNG is stored to download as an attachment, so no file can
// run on the files host.
func (s *Service) upload(ctx context.Context, f file, usage Usage, now time.Time) (Upload, error) {
	headers := map[string]string{
		"Content-Type":          f.contentType,
		"Content-Length":        strconv.FormatInt(f.size, 10),
		"x-amz-checksum-sha256": f.sha256,
	}
	if f.contentType != "image/jpeg" && f.contentType != "image/png" {
		headers["Content-Disposition"] = "attachment"
	}
	signed := map[string]string{}
	for name, value := range headers {
		if name != "Content-Length" {
			signed[name] = value
		}
	}
	url, err := s.Uploads.Presign(ctx, f.key, f.size, signed, now, linkLife)
	if err != nil {
		return Upload{}, err
	}
	return Upload{URL: url, Headers: headers, ExpiresAt: now.Add(linkLife).UTC().Truncate(time.Second), Usage: usage}, nil
}

// GrantDownloads signs a link to each file granted in the caller's own partition, counting their bytes against the
// hourly download limit as the links are handed out. A link can be fetched again until it expires, which the count
// can't see: a limit on every request would need WAF at the edge.
func (s *Service) GrantDownloads(ctx context.Context, sub string, ids []string) (Downloads, error) {
	if len(ids) == 0 || len(ids) > s.Limits.MaxIDsPerDownload {
		return Downloads{}, ErrInvalidRequest
	}
	var unique []string
	for _, id := range ids {
		if !sync.ValidID(id) {
			return Downloads{}, ErrInvalidRequest
		}
		if !slices.Contains(unique, id) {
			unique = append(unique, id)
		}
	}
	for attempt := 1; ; attempt++ {
		now := s.Now()
		c, err := s.read(ctx, sub, unique)
		if err != nil {
			return Downloads{}, err
		}
		var total int64
		for _, f := range c.files {
			total += f.size
		}
		hour := hourOf(now)
		used := int64(0)
		if c.hour == hour.Unix() {
			used = c.downloads
		}
		if total > 0 && used+total > s.Limits.DownloadBytesPerHour {
			return Downloads{}, &Refusal{Status: http.StatusTooManyRequests, Code: "download_rate", RetryAt: hour.Add(time.Hour)}
		}
		if total > 0 {
			_, err = s.DB.UpdateItem(ctx, updateInput(s.countRate(sub, c, hour, 0, total)))
		}
		if err == nil {
			return s.downloads(ctx, unique, c.files, now)
		}
		if !conditionFailed(err) {
			return Downloads{}, fmt.Errorf("files: count downloads: %w", err)
		}
		if attempt == maxAttempts {
			return Downloads{}, ErrBusy
		}
	}
}

func (s *Service) downloads(ctx context.Context, ids []string, granted map[string]file, now time.Time) (Downloads, error) {
	out := Downloads{Files: []Download{}, Missing: []string{}}
	expires := now.Add(linkLife).UTC().Truncate(time.Second)
	for _, id := range ids {
		f, ok := granted[id]
		if !ok {
			out.Missing = append(out.Missing, id)
			continue
		}
		key, err := s.Key.Key(ctx)
		if err != nil {
			return Downloads{}, err
		}
		url, err := sign.NewURLSigner(s.KeyID, key).Sign(s.FilesURL+"/"+f.key, expires)
		if err != nil {
			return Downloads{}, err
		}
		out.Files = append(out.Files, Download{ID: id, URL: url, ExpiresAt: expires})
	}
	return out, nil
}

// Usage is what the caller stores and may store, so the app can tell storage is full before adding a file.
func (s *Service) Usage(ctx context.Context, sub string) (Usage, error) {
	c, err := s.read(ctx, sub, nil)
	return c.usage(), err
}

// read takes the file# items for ids and the person's meta# items in one strongly consistent batch read.
func (s *Service) read(ctx context.Context, sub string, ids []string) (counters, error) {
	c := counters{files: map[string]file{}, quota: s.Limits.DefaultQuotaBytes}
	keys := []map[string]types.AttributeValue{key(sub, storageKey), key(sub, quotaKey), key(sub, rateKey)}
	for _, id := range ids {
		keys = append(keys, key(sub, filePrefix+id))
	}
	request := map[string]types.KeysAndAttributes{s.Table: {Keys: keys, ConsistentRead: aws.Bool(true)}}
	for try := 0; ; try++ {
		out, err := s.DB.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: request})
		if err != nil {
			return c, fmt.Errorf("files: read: %w", err)
		}
		for _, item := range out.Responses[s.Table] {
			if err := c.add(item); err != nil {
				return c, err
			}
		}
		if len(out.UnprocessedKeys) == 0 {
			return c, nil
		}
		// A key left unread would count as nothing stored or granted, so it's read again or the request fails.
		if try == maxReadTries {
			return c, errors.New("files: read: keys still unprocessed")
		}
		request = out.UnprocessedKeys
		select {
		case <-ctx.Done():
			return c, ctx.Err()
		case <-time.After(time.Duration(try+1) * 50 * time.Millisecond):
		}
	}
}

func (c *counters) add(item map[string]types.AttributeValue) error {
	sk := stringAttr(item["sk"])
	var err error
	switch {
	case sk == storageKey:
		c.usedBytes, err = numberAttr(item["value"])
	case sk == quotaKey:
		c.quota, err = numberAttr(item["value"])
	case sk == rateKey:
		if c.hour, err = numberAttr(item["hour"]); err == nil {
			if c.uploads, err = numberAttr(item["uploads"]); err == nil {
				c.downloads, err = numberAttr(item["download_bytes"])
			}
		}
	default:
		var size int64
		size, err = numberAttr(item["size"])
		id := sk[len(filePrefix):]
		c.files[id] = file{key: stringAttr(item["key"]), contentType: stringAttr(item["type"]), sha256: stringAttr(item["sha256"]), size: size}
	}
	if err != nil {
		return fmt.Errorf("files: read %s: %w", sk, err)
	}
	return nil
}

// hourOf is the start of the UTC hour now falls in, which the hourly limits count from.
func hourOf(now time.Time) time.Time { return now.UTC().Truncate(time.Hour) }

func conditionFailed(err error) bool {
	var canceled *types.TransactionCanceledException
	if errors.As(err, &canceled) {
		return slices.ContainsFunc(canceled.CancellationReasons, func(reason types.CancellationReason) bool {
			code := aws.ToString(reason.Code)
			return code == "ConditionalCheckFailed" || code == "TransactionConflict"
		})
	}
	var failed *types.ConditionalCheckFailedException
	return errors.As(err, &failed)
}

func updateInput(u *types.Update) *dynamodb.UpdateItemInput {
	return &dynamodb.UpdateItemInput{
		TableName: u.TableName, Key: u.Key, UpdateExpression: u.UpdateExpression, ConditionExpression: u.ConditionExpression,
		ExpressionAttributeNames: u.ExpressionAttributeNames, ExpressionAttributeValues: u.ExpressionAttributeValues,
	}
}

func userKey(sub string) string { return "user#" + sub }

func key(sub, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"pk": str(userKey(sub)), "sk": str(sk)}
}

func str(s string) types.AttributeValue { return &types.AttributeValueMemberS{Value: s} }

func num(n int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(n, 10)}
}

func stringAttr(value types.AttributeValue) string {
	s, _ := value.(*types.AttributeValueMemberS)
	if s == nil {
		return ""
	}
	return s.Value
}

func numberAttr(value types.AttributeValue) (int64, error) {
	n, ok := value.(*types.AttributeValueMemberN)
	if !ok {
		return 0, errors.New("expected a number attribute")
	}
	return strconv.ParseInt(n.Value, 10, 64)
}
