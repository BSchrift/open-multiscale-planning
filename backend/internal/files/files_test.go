package files_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/files"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	msync "github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

var (
	tableSeq atomic.Int64
	start    = time.Date(2030, 6, 1, 10, 20, 0, 0, time.UTC)
	creds    = aws.Credentials{AccessKeyID: "dummy", SecretAccessKey: "dummy"}
)

// env is a service on a fresh table in DynamoDB Local, the bucket stand-in serving its links, and a clock the test moves.
type env struct {
	t       *testing.T
	service *files.Service
	store   *msync.Store
	client  *dynamodb.Client
	bucket  *fakes.Bucket
	now     *time.Time
	devices atomic.Int64
}

func newEnv(t *testing.T) *env {
	t.Helper()
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("DYNAMODB_ENDPOINT not set: start DynamoDB Local to run this test")
	}
	client := dynamodb.New(dynamodb.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	table := fmt.Sprintf("files-test-%d-%d", os.Getpid(), tableSeq.Add(1))
	if err := fakes.CreateTable(context.Background(), client, table); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		client.DeleteTable(context.Background(), &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	})
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := start
	clock := func() time.Time { return now }
	bucket := &fakes.Bucket{Region: "us-west-2", Credentials: creds, PublicKeys: map[string]*rsa.PublicKey{"K1": &key.PublicKey}, Now: clock}
	mux := http.NewServeMux()
	mux.Handle("/bucket/", bucket.Uploads("/bucket/"))
	mux.Handle("/edge/", bucket.Downloads("/edge/"))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	store := &msync.Store{DB: client, Table: table}
	return &env{t: t, store: store, client: client, bucket: bucket, now: &now, service: &files.Service{
		DB: client, Table: table, Records: store,
		Uploads:  &files.PutSigner{Endpoint: srv.URL + "/bucket", Region: "us-west-2", Credentials: credentials.StaticCredentialsProvider{Value: creds}},
		FilesURL: srv.URL + "/edge", KeyID: "K1", Key: files.StaticKey{Signer: key},
		Limits: files.Limits{
			MaxFileBytes: 1000, MaxIDsPerDownload: 4, ContentTypes: []string{"image/jpeg", "image/png", "application/pdf"},
			DefaultQuotaBytes: 2500, UploadsPerHour: 4, DownloadBytesPerHour: 3000,
		},
		Now: clock,
	}}
}

func hash(body []byte) string {
	sum := sha256.Sum256(body)
	return base64.StdEncoding.EncodeToString(sum[:])
}

// attach syncs an attachment record as an app writes it, with name, value pairs that replace its defaults: a photo of
// body, as a JPEG.
func (e *env) attach(sub, id string, body []byte, pairs ...any) {
	e.t.Helper()
	c := fmt.Sprintf("%013d-000000-d%d", e.now.UnixMilli(), e.devices.Add(1))
	fields := msync.Fields{
		"task_id": {V: "t1", C: c}, "kind": {V: "photo", C: c}, "name": {V: "Receipt", C: c},
		"size": {V: json.Number(fmt.Sprint(len(body))), C: c}, "type": {V: "image/jpeg", C: c}, "sha256": {V: hash(body), C: c},
	}
	for i := 0; i+1 < len(pairs); i += 2 {
		fields[pairs[i].(string)] = msync.Field{V: pairs[i+1], C: c}
	}
	if _, err := e.store.Push(context.Background(), sub, 0, []msync.Change{{Type: "attachment", ID: id, Fields: fields}}); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) grant(sub, id string) files.Upload {
	e.t.Helper()
	up, err := e.service.GrantUpload(context.Background(), sub, id)
	if err != nil {
		e.t.Fatalf("%s: %v", id, err)
	}
	return up
}

// refusal is the refusal err holds, or fails the test.
func refusal(t *testing.T, err error, status int, code string) *files.Refusal {
	t.Helper()
	var r *files.Refusal
	if !errors.As(err, &r) || r.Status != status || r.Code != code {
		t.Fatalf("got %v, want %d %s", err, status, code)
	}
	return r
}

// put uploads body to a granted link with the headers it came with, as an app does.
func put(t *testing.T, up files.Upload, body []byte, change func(*http.Request)) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, up.URL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range up.Headers {
		if name != "Content-Length" {
			req.Header.Set(name, value)
		}
	}
	if change != nil {
		change(req)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func get(t *testing.T, link string) (int, []byte, http.Header) {
	t.Helper()
	res, err := http.Get(link)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, body, res.Header
}

func (e *env) item(sub, sk string) map[string]types.AttributeValue {
	e.t.Helper()
	out, err := e.client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(e.store.Table), ConsistentRead: aws.Bool(true),
		Key: map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "user#" + sub}, "sk": &types.AttributeValueMemberS{Value: sk}},
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return out.Item
}

func (e *env) usage(sub string) files.Usage {
	e.t.Helper()
	u, err := e.service.Usage(context.Background(), sub)
	if err != nil {
		e.t.Fatal(err)
	}
	return u
}

func TestAnUploadIsSignedForExactlyWhatSynced(t *testing.T) {
	e := newEnv(t)
	photo := []byte("a small photo")
	e.attach("abc", "a1", photo)
	up := e.grant("abc", "a1")

	if want := (files.Usage{UsedBytes: int64(len(photo)), QuotaBytes: 2500}); up.Usage != want {
		t.Errorf("usage %+v", up.Usage)
	}
	if !up.ExpiresAt.Equal(start.Add(5*time.Minute)) || up.ExpiresAt.Location() != time.UTC {
		t.Errorf("expires %v", up.ExpiresAt)
	}
	want := map[string]string{"Content-Type": "image/jpeg", "Content-Length": fmt.Sprint(len(photo)), "x-amz-checksum-sha256": hash(photo)}
	if fmt.Sprint(up.Headers) != fmt.Sprint(want) {
		t.Errorf("headers %v", up.Headers)
	}
	link, _ := url.Parse(up.URL)
	key := strings.TrimPrefix(link.Path, "/bucket/")
	if !strings.HasPrefix(key, "u/"+obs.HashSub("abc")+"/") || len(key) != len("u/")+16+1+32 {
		t.Errorf("key %q", key)
	}
	if got := link.Query().Get("X-Amz-SignedHeaders"); got != "content-length;content-type;host;x-amz-checksum-sha256" {
		t.Errorf("signed headers %q", got)
	}

	// S3 takes only the bytes granted: not more, not others, not another type, and not once the link has expired.
	if status := put(t, up, append(bytes.Clone(photo), '!'), nil); status != http.StatusForbidden {
		t.Errorf("a longer file: %d", status)
	}
	if status := put(t, up, []byte("a small phot0"), nil); status != http.StatusBadRequest {
		t.Errorf("other bytes of the same size: %d", status)
	}
	if status := put(t, up, photo, func(r *http.Request) { r.Header.Set("Content-Type", "text/html") }); status != http.StatusForbidden {
		t.Errorf("another type: %d", status)
	}
	if _, ok := e.bucket.Object(key); ok {
		t.Fatal("a refused upload landed")
	}
	if status := put(t, up, photo, nil); status != http.StatusOK {
		t.Fatalf("the granted upload: %d", status)
	}
	if got, _ := e.bucket.Object(key); !bytes.Equal(got, photo) {
		t.Errorf("stored %q", got)
	}
	*e.now = e.now.Add(5*time.Minute + time.Second)
	if status := put(t, up, photo, nil); status != http.StatusForbidden {
		t.Errorf("an expired link: %d", status)
	}

	stored := e.item("abc", "file#a1")
	if stored["key"].(*types.AttributeValueMemberS).Value != key || stored["sha256"].(*types.AttributeValueMemberS).Value != hash(photo) {
		t.Errorf("file# %v", stored)
	}
}

func TestOnlyJPEGsAndPNGsDownloadInline(t *testing.T) {
	e := newEnv(t)
	e.attach("abc", "png", []byte("png"), "type", "image/png")
	e.attach("abc", "pdf", []byte("pdf"), "kind", "file", "type", "application/pdf")
	if got := e.grant("abc", "png").Headers["Content-Disposition"]; got != "" {
		t.Errorf("png: %q", got)
	}
	up := e.grant("abc", "pdf")
	if got := up.Headers["Content-Disposition"]; got != "attachment" {
		t.Errorf("pdf: %q", got)
	}
	if got, _ := url.Parse(up.URL); !strings.Contains(got.Query().Get("X-Amz-SignedHeaders"), "content-disposition") {
		t.Errorf("the disposition isn't signed: %s", up.URL)
	}
	if status := put(t, up, []byte("pdf"), func(r *http.Request) { r.Header.Del("Content-Disposition") }); status != http.StatusForbidden {
		t.Errorf("without the disposition: %d", status)
	}
}

func TestUploadRefusals(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.attach("abc", "deleted", []byte("x"), "deleted_at", "2030-06-01T10:00:00Z")
	e.attach("abc", "expired", []byte("x"), "expires_at", "2030-06-01T10:00:00Z")
	e.attach("abc", "link", []byte("x"), "kind", "link", "url", "https://example.com")
	e.attach("abc", "no-size", []byte("x"), "size", nil)
	e.attach("abc", "text-size", []byte("x"), "size", "1")
	e.attach("abc", "fraction", []byte("x"), "size", json.Number("1.5"))
	e.attach("abc", "zero", []byte("x"), "size", json.Number("0"))
	e.attach("abc", "no-type", []byte("x"), "type", "")
	e.attach("abc", "short-hash", []byte("x"), "sha256", base64.StdEncoding.EncodeToString([]byte("short")))
	e.attach("abc", "hex-hash", []byte("x"), "sha256", strings.Repeat("ab", 32))
	e.attach("abc", "large", bytes.Repeat([]byte("x"), 1001))
	e.attach("abc", "html", []byte("<script>"), "type", "text/html")
	e.attach("abc", "svg", []byte("<svg>"), "type", "image/svg+xml")
	e.attach("other", "theirs", []byte("x"))

	for _, c := range []struct {
		id, code string
		status   int
	}{
		{"missing", "not_found", 404}, {"deleted", "not_found", 404}, {"expired", "not_found", 404}, {"link", "not_found", 404},
		{"theirs", "not_found", 404},
		{"no-size", "invalid_attachment", 400}, {"text-size", "invalid_attachment", 400}, {"fraction", "invalid_attachment", 400},
		{"zero", "invalid_attachment", 400}, {"no-type", "invalid_attachment", 400}, {"short-hash", "invalid_attachment", 400},
		{"hex-hash", "invalid_attachment", 400},
		{"large", "file_too_large", 413}, {"html", "type_not_allowed", 415}, {"svg", "type_not_allowed", 415},
		{"has space", "invalid_request", 400}, {"", "invalid_request", 400},
	} {
		t.Run(c.id, func(t *testing.T) {
			_, err := e.service.GrantUpload(ctx, "abc", c.id)
			refusal(t, err, c.status, c.code)
		})
	}
	if u := e.usage("abc"); u.UsedBytes != 0 {
		t.Errorf("a refusal counted: %+v", u)
	}
}

func TestAskingAgainSignsAFreshLinkWithoutCountingTwice(t *testing.T) {
	e := newEnv(t)
	e.attach("abc", "a1", []byte("photo"))
	first := e.grant("abc", "a1")
	*e.now = e.now.Add(time.Minute)
	again := e.grant("abc", "a1")
	if again.URL == first.URL || !again.ExpiresAt.Equal(first.ExpiresAt.Add(time.Minute)) {
		t.Errorf("not a fresh link: %s %v", again.URL, again.ExpiresAt)
	}
	firstURL, _ := url.Parse(first.URL)
	againURL, _ := url.Parse(again.URL)
	if firstURL.Path != againURL.Path {
		t.Errorf("a second key: %s, %s", firstURL.Path, againURL.Path)
	}
	if u := e.usage("abc"); u.UsedBytes != 5 {
		t.Errorf("counted twice: %+v", u)
	}
	if got := e.item("abc", "meta#rate")["uploads"].(*types.AttributeValueMemberN).Value; got != "1" {
		t.Errorf("uploads %s", got)
	}
	// A record that no longer matches what was granted gets no link for other bytes.
	e.attach("abc", "a1", []byte("other photo"))
	_, err := e.service.GrantUpload(context.Background(), "abc", "a1")
	refusal(t, err, http.StatusConflict, "attachment_changed")
}

func TestTheHourlyUploadLimitRollsOverOnTheHour(t *testing.T) {
	e := newEnv(t)
	for i := range 5 {
		e.attach("abc", fmt.Sprint("a", i), []byte(fmt.Sprint("photo ", i)))
	}
	for i := range 4 {
		e.grant("abc", fmt.Sprint("a", i))
	}
	*e.now = time.Date(2030, 6, 1, 10, 59, 59, 0, time.UTC)
	_, err := e.service.GrantUpload(context.Background(), "abc", "a4")
	r := refusal(t, err, http.StatusTooManyRequests, "upload_rate")
	if !r.RetryAt.Equal(time.Date(2030, 6, 1, 11, 0, 0, 0, time.UTC)) {
		t.Errorf("retry at %v", r.RetryAt)
	}
	// A link asked for again still comes: it counts nothing.
	e.grant("abc", "a0")
	*e.now = time.Date(2030, 6, 1, 11, 0, 0, 0, time.UTC)
	e.grant("abc", "a4")
	if got := e.item("abc", "meta#rate")["uploads"].(*types.AttributeValueMemberN).Value; got != "1" {
		t.Errorf("the new hour counts from one: %s", got)
	}
}

func TestTheQuotaAndARaisedOne(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.attach("abc", "a1", bytes.Repeat([]byte("1"), 1000))
	e.attach("abc", "a2", bytes.Repeat([]byte("2"), 1000))
	e.attach("abc", "a3", bytes.Repeat([]byte("3"), 600))
	e.grant("abc", "a1")
	e.grant("abc", "a2")
	_, err := e.service.GrantUpload(ctx, "abc", "a3")
	r := refusal(t, err, http.StatusForbidden, "quota_exceeded")
	if r.Usage == nil || *r.Usage != (files.Usage{UsedBytes: 2000, QuotaBytes: 2500}) {
		t.Errorf("usage %+v", r.Usage)
	}
	// Someone else's storage is their own.
	e.attach("other", "b1", bytes.Repeat([]byte("1"), 1000))
	e.grant("other", "b1")

	// make storage-quota writes meta#quota in the person's partition.
	if _, err := e.client.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(e.store.Table), Item: map[string]types.AttributeValue{
		"pk": &types.AttributeValueMemberS{Value: "user#abc"}, "sk": &types.AttributeValueMemberS{Value: "meta#quota"},
		"value": &types.AttributeValueMemberN{Value: "5000"},
	}}); err != nil {
		t.Fatal(err)
	}
	if up := e.grant("abc", "a3"); up.Usage != (files.Usage{UsedBytes: 2600, QuotaBytes: 5000}) {
		t.Errorf("raised: %+v", up.Usage)
	}
	if u := e.usage("other"); u != (files.Usage{UsedBytes: 1000, QuotaBytes: 2500}) {
		t.Errorf("the raise reached someone else: %+v", u)
	}
}

// Grants racing each other can't pass the quota between them: each is conditional on the bytes it read.
func TestGrantsRacingForTheLastRoomGetOneEach(t *testing.T) {
	e := newEnv(t)
	for i := range 4 {
		e.attach("abc", fmt.Sprint("a", i), bytes.Repeat([]byte{byte('0' + i)}, 900))
	}
	results := make(chan error, 4)
	for i := range 4 {
		go func() {
			_, err := e.service.GrantUpload(context.Background(), "abc", fmt.Sprint("a", i))
			results <- err
		}()
	}
	granted := 0
	for range 4 {
		err := <-results
		var r *files.Refusal
		switch {
		case err == nil:
			granted++
		case errors.As(err, &r) && r.Code == "quota_exceeded", errors.Is(err, files.ErrBusy):
		default:
			t.Errorf("%v", err)
		}
	}
	if u := e.usage("abc"); granted != 2 || u.UsedBytes != 1800 {
		t.Errorf("granted %d, %+v", granted, u)
	}
}

func TestDownloadsAreSignedOnlyForTheCallersOwnFiles(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	photo := []byte("a photo of the receipt")
	e.attach("abc", "mine", photo)
	e.attach("abc", "not-uploaded", []byte("later"))
	e.attach("other", "theirs", []byte("their photo"))
	up := e.grant("abc", "mine")
	if status := put(t, up, photo, nil); status != http.StatusOK {
		t.Fatal(status)
	}
	theirs := e.grant("other", "theirs")
	if status := put(t, theirs, []byte("their photo"), nil); status != http.StatusOK {
		t.Fatal(status)
	}

	got, err := e.service.GrantDownloads(ctx, "abc", []string{"mine", "theirs", "never", "mine"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 1 || got.Files[0].ID != "mine" || !slices.Equal(got.Missing, []string{"theirs", "never"}) {
		t.Fatalf("%+v", got)
	}
	if !got.Files[0].ExpiresAt.Equal(start.Add(5 * time.Minute)) {
		t.Errorf("expires %v", got.Files[0].ExpiresAt)
	}
	// The link verifies against the key group's public key, and the edge serves the file with nothing that could run.
	status, body, header := get(t, got.Files[0].URL)
	if status != http.StatusOK || !bytes.Equal(body, photo) || header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("%d %q %v", status, body, header)
	}
	link, _ := url.Parse(got.Files[0].URL)
	if q := link.Query(); q.Get("Key-Pair-Id") != "K1" || q.Get("Expires") != fmt.Sprint(start.Add(5*time.Minute).Unix()) {
		t.Errorf("%s", got.Files[0].URL)
	}
	// Not the path of someone else's file, a changed expiry, or once it's past.
	theirKey, _ := url.Parse(theirs.URL)
	for name, tampered := range map[string]string{
		"another path":   strings.Replace(got.Files[0].URL, link.Path, "/edge/"+strings.TrimPrefix(theirKey.Path, "/bucket/"), 1),
		"a later expiry": strings.Replace(got.Files[0].URL, "Expires="+link.Query().Get("Expires"), fmt.Sprint("Expires=", start.Add(time.Hour).Unix()), 1),
		"no signature":   (&url.URL{Scheme: link.Scheme, Host: link.Host, Path: link.Path}).String(),
	} {
		if status, _, _ := get(t, tampered); status != http.StatusForbidden {
			t.Errorf("%s: %d", name, status)
		}
	}
	*e.now = e.now.Add(5 * time.Minute)
	if status, _, _ := get(t, got.Files[0].URL); status != http.StatusForbidden {
		t.Errorf("an expired link: %d", status)
	}

	for _, ids := range [][]string{nil, {}, {"a", "b", "c", "d", "e"}, {"has space"}} {
		_, err := e.service.GrantDownloads(ctx, "abc", ids)
		refusal(t, err, http.StatusBadRequest, "invalid_request")
	}
}

func TestDownloadedBytesCountByTheHour(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.attach("abc", "a1", bytes.Repeat([]byte("1"), 1000))
	e.grant("abc", "a1")
	for range 3 {
		if _, err := e.service.GrantDownloads(ctx, "abc", []string{"a1"}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := e.service.GrantDownloads(ctx, "abc", []string{"a1"})
	r := refusal(t, err, http.StatusTooManyRequests, "download_rate")
	if !r.RetryAt.Equal(time.Date(2030, 6, 1, 11, 0, 0, 0, time.UTC)) {
		t.Errorf("retry at %v", r.RetryAt)
	}
	// Asking only for files that aren't there counts nothing, so it's never refused.
	if got, err := e.service.GrantDownloads(ctx, "abc", []string{"never"}); err != nil || len(got.Missing) != 1 {
		t.Errorf("%+v %v", got, err)
	}
	*e.now = time.Date(2030, 6, 1, 11, 0, 0, 0, time.UTC)
	if _, err := e.service.GrantDownloads(ctx, "abc", []string{"a1"}); err != nil {
		t.Fatalf("a new hour: %v", err)
	}
	rate := e.item("abc", "meta#rate")
	if rate["download_bytes"].(*types.AttributeValueMemberN).Value != "1000" || rate["uploads"].(*types.AttributeValueMemberN).Value != "0" {
		t.Errorf("%v", rate)
	}
}

func TestRemovingARecordFreesItsFile(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	photo := []byte("photo")
	e.attach("abc", "a1", photo)
	e.attach("abc", "a2", []byte("another"))
	up := e.grant("abc", "a1")
	e.grant("abc", "a2")
	put(t, up, photo, nil)
	link, _ := url.Parse(up.URL)
	key := strings.TrimPrefix(link.Path, "/bucket/")

	remover := &files.Remover{DB: e.client, Table: e.store.Table, Objects: e.bucket}
	for range 2 {
		// Twice, as when TTL and staging's cleanup both reach it: the second finds nothing left to do.
		if err := remover.Removing(ctx, "user#abc", "rec#attachment#a1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := e.bucket.Object(key); ok || e.item("abc", "file#a1") != nil {
		t.Fatal("the file stayed")
	}
	if u := e.usage("abc"); u.UsedBytes != int64(len("another")) {
		t.Errorf("the bytes weren't freed: %+v", u)
	}
	// Anything but an attachment's record, or one never granted, has nothing to remove.
	for _, sk := range []string{"rec#task#a2", "rec#attachment#never", "meta#storage"} {
		if err := remover.Removing(ctx, "user#abc", sk); err != nil {
			t.Fatal(err)
		}
	}
	if e.item("abc", "file#a2") == nil {
		t.Fatal("removed the wrong file")
	}

	// A failed delete leaves everything for the next try.
	failing := &files.Remover{DB: e.client, Table: e.store.Table, Objects: failingObjects{}}
	if err := failing.Removing(ctx, "user#abc", "rec#attachment#a2"); err == nil || e.item("abc", "file#a2") == nil {
		t.Fatalf("%v", err)
	}
}

type failingObjects struct{}

func (failingObjects) Delete(context.Context, string) error { return errors.New("bucket unreachable") }

// meta# and file# items have no sequence number, so no pull ever returns them, and a sync can't write one: it writes
// only rec# items, whatever type a device names.
func TestPullsNeverReturnWhatTheAPIKeeps(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.attach("abc", "a1", []byte("photo"))
	e.grant("abc", "a1")
	e.service.GrantDownloads(ctx, "abc", []string{"a1"})
	res, _, err := e.store.Sync(ctx, "abc", msync.Request{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Changes) != 1 || res.Changes[0].Type != "attachment" {
		t.Fatalf("%+v", res.Changes)
	}
	for _, sk := range []string{"file#a1", "meta#storage", "meta#rate"} {
		if _, ok := e.item("abc", sk)["seq"]; ok {
			t.Errorf("%s has a sequence number", sk)
		}
	}
	// A device naming meta# or file# as a record's type or id still writes a rec# item.
	if _, err := msync.ParseRequest([]byte(`{"cursor":0,"changes":[{"type":"meta","id":"storage","fields":{"value":{"v":0,"c":"0000000000001-000000-d"}}}]}`), *e.now); err != nil {
		t.Fatal(err)
	}
	e.store.Push(ctx, "abc", 0, []msync.Change{{Type: "meta", ID: "storage", Fields: msync.Fields{"value": {V: json.Number("0"), C: "0000000000001-000000-d"}}}})
	if u := e.usage("abc"); u.UsedBytes != 5 {
		t.Errorf("a sync changed meta#storage: %+v", u)
	}
	if e.item("abc", "rec#meta#storage") == nil {
		t.Error("the change didn't land as a record")
	}
}
