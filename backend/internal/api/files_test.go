package api

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/files"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

type fakeFiles struct {
	sub, id   string
	ids       []string
	upload    files.Upload
	downloads files.Downloads
	usage     files.Usage
	err       error
}

func (f *fakeFiles) GrantUpload(_ context.Context, sub, id string) (files.Upload, error) {
	f.sub, f.id = sub, id
	return f.upload, f.err
}

func (f *fakeFiles) GrantDownloads(_ context.Context, sub string, ids []string) (files.Downloads, error) {
	f.sub, f.ids = sub, ids
	return f.downloads, f.err
}

func (f *fakeFiles) Usage(_ context.Context, sub string) (files.Usage, error) {
	f.sub = sub
	return f.usage, f.err
}

func filesServer(f Files) *Server {
	s, _ := newServer(&fakeSyncer{}, nil)
	s.Files = f
	return s
}

func TestUploadGrantsForTheTokensUser(t *testing.T) {
	f := &fakeFiles{upload: files.Upload{
		URL: "https://bucket.example/u/x/y?X-Amz-Signature=s", ExpiresAt: testNow.Add(5 * time.Minute).UTC(),
		Headers: map[string]string{"Content-Type": "image/jpeg", "Content-Length": "5", "x-amz-checksum-sha256": "aGFzaA=="},
		Usage:   files.Usage{UsedBytes: 5, QuotaBytes: 1 << 30},
	}}
	// A user id in the body is ignored: the token decides whose attachment this is.
	rec := do(filesServer(f), "POST", "/files/upload", `{"id":"a1","sub":"someone-else"}`, testSub)
	if rec.Code != 200 || f.sub != testSub || f.id != "a1" {
		t.Fatalf("%d %s %+v", rec.Code, rec.Body, f)
	}
	want := `{"url":"https://bucket.example/u/x/y?X-Amz-Signature=s","headers":{"Content-Length":"5","Content-Type":"image/jpeg","x-amz-checksum-sha256":"aGFzaA=="},"expires_at":"2027-01-15T08:05:00Z","used_bytes":5,"quota_bytes":1073741824}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body %s", got)
	}
}

func TestDownloadAndUsage(t *testing.T) {
	f := &fakeFiles{
		downloads: files.Downloads{Files: []files.Download{{ID: "a1", URL: "https://files.example/u/x/y?Signature=s", ExpiresAt: testNow.UTC()}}, Missing: []string{"a2"}},
		usage:     files.Usage{UsedBytes: 10, QuotaBytes: 20},
	}
	s := filesServer(f)
	rec := do(s, "POST", "/files/download", `{"ids":["a1","a2"]}`, testSub)
	if rec.Code != 200 || f.sub != testSub || !slices.Equal(f.ids, []string{"a1", "a2"}) {
		t.Fatalf("%d %s %+v", rec.Code, rec.Body, f)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"files":[{"id":"a1","url":"https://files.example/u/x/y?Signature=s","expires_at":"2027-01-15T08:00:00Z"}],"missing":["a2"]}` {
		t.Fatalf("body %s", got)
	}
	rec = do(s, "GET", "/files/usage", "", testSub)
	if got := strings.TrimSpace(rec.Body.String()); rec.Code != 200 || got != `{"used_bytes":10,"quota_bytes":20}` {
		t.Fatalf("%d %s", rec.Code, got)
	}
}

func TestFilesRefusalsCarryTheirCodeAndDetails(t *testing.T) {
	retry := time.Date(2027, 1, 15, 9, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		err    error
		status int
		body   string
	}{
		{&files.Refusal{Status: 404, Code: "not_found"}, 404, `{"error":"not_found"}`},
		{&files.Refusal{Status: 413, Code: "file_too_large"}, 413, `{"error":"file_too_large"}`},
		{&files.Refusal{Status: 429, Code: "upload_rate", RetryAt: retry}, 429, `{"error":"upload_rate","retry_at":"2027-01-15T09:00:00Z"}`},
		{&files.Refusal{Status: 403, Code: "quota_exceeded", Usage: &files.Usage{UsedBytes: 7, QuotaBytes: 9}}, 403, `{"error":"quota_exceeded","quota_bytes":9,"used_bytes":7}`},
		{files.ErrBusy, 409, `{"error":"conflict"}`},
	} {
		s, logs := newServer(&fakeSyncer{}, nil)
		s.Files = &fakeFiles{err: c.err}
		rec := do(s, "POST", "/files/upload", `{"id":"a1"}`, testSub)
		if got := strings.TrimSpace(rec.Body.String()); rec.Code != c.status || got != c.body {
			t.Errorf("%v: %d %s", c.err, rec.Code, got)
		}
		if line := logLine(t, logs); line["error_type"] == nil || line["user"] != obs.HashSub(testSub) {
			t.Errorf("%v", line)
		}
	}
}

func TestFilesRequestsAreChecked(t *testing.T) {
	s := filesServer(&fakeFiles{})
	for _, c := range []struct{ target, body string }{
		{"/files/upload", ``}, {"/files/upload", `{"id":7}`}, {"/files/upload", `[`},
		{"/files/download", `{"ids":"a1"}`}, {"/files/download", `{`},
		{"/files/upload", `{"id":"` + strings.Repeat("x", 20<<10) + `"}`},
	} {
		if rec := do(s, "POST", c.target, c.body, testSub); rec.Code != 400 || !strings.Contains(rec.Body.String(), `"invalid_request"`) {
			t.Errorf("%s %.40s: %d %s", c.target, c.body, rec.Code, rec.Body)
		}
	}
	for _, target := range []string{"/files/upload", "/files/download"} {
		if rec := do(s, "POST", target, `{}`, ""); rec.Code != 401 {
			t.Errorf("%s without a token: %d", target, rec.Code)
		}
	}
	if rec := do(s, "GET", "/files/usage", "", ""); rec.Code != 401 {
		t.Errorf("usage without a token: %d", rec.Code)
	}
}

// What a file holds never reaches a log line, and neither does an AWS error's message, which can quote the request.
func TestAFilesFailureLogsCodesOnly(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, nil)
	s.Files = &fakeFiles{err: &types.TransactionCanceledException{
		Message:             aws.String("Receipt.pdf secret"),
		CancellationReasons: []types.CancellationReason{{Code: aws.String("ValidationError")}},
	}}
	rec := do(s, "POST", "/files/upload", `{"id":"a1"}`, testSub)
	if rec.Code != 500 || strings.TrimSpace(rec.Body.String()) != `{"error":"internal"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), testSub) || !strings.Contains(logs.String(), "ValidationError") {
		t.Fatalf("%s", logs)
	}
}

// Where the environment stores no files, the routes say so, and the app offers no attachments.
func TestFilesRoutesWithoutStorage(t *testing.T) {
	s, _ := newServer(&fakeSyncer{}, nil)
	for _, c := range []struct{ method, target string }{{"POST", "/files/upload"}, {"POST", "/files/download"}, {"GET", "/files/usage"}} {
		rec := do(s, c.method, c.target, `{"id":"a1"}`, testSub)
		if rec.Code != 501 || strings.TrimSpace(rec.Body.String()) != `{"error":"files_not_configured"}` {
			t.Errorf("%s: %d %s", c.target, rec.Code, rec.Body)
		}
	}
}
