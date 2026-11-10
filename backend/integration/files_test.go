package integration

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

// The attachment limits under test, from the files the server reads them from.
var maxFileBytes = appconfig.Protocol.Attachments.MaxFileBytes

func defaultQuota(t *testing.T) int {
	t.Helper()
	env, err := appconfig.ForEnv(target.Env)
	if err != nil {
		t.Fatal(err)
	}
	return env.Attachments.DefaultQuotaBytes
}

type uploadGrant struct {
	URL        string            `json:"url"`
	Headers    map[string]string `json:"headers"`
	ExpiresAt  time.Time         `json:"expires_at"`
	UsedBytes  int64             `json:"used_bytes"`
	QuotaBytes int64             `json:"quota_bytes"`
}

type downloadGrant struct {
	Files []struct {
		ID        string    `json:"id"`
		URL       string    `json:"url"`
		ExpiresAt time.Time `json:"expires_at"`
	} `json:"files"`
	Missing []string `json:"missing"`
}

func digest(body []byte) string {
	sum := sha256.Sum256(body)
	return base64.StdEncoding.EncodeToString(sum[:])
}

// attach syncs an attachment record for body, as the app writes one: a JPEG photo unless pairs say otherwise.
func (a *account) attach(id string, body []byte, pairs ...any) {
	a.t.Helper()
	fields := []any{"task_id", fresh("task"), "kind", "photo", "name", "Receipt", "size", len(body), "type", "image/jpeg", "sha256", digest(body)}
	a.sync(a.startCursor(), a.record("attachment", id, append(fields, pairs...)...))
}

func (a *account) askUpload(id string) response {
	a.t.Helper()
	return request(a.t, "POST", "/files/upload", a.tokens.access, mustJSON(a.t, map[string]string{"id": id}))
}

func (a *account) grantUpload(id string) uploadGrant {
	a.t.Helper()
	res := a.askUpload(id)
	if res.status != 200 {
		a.t.Fatalf("upload %s: %d %s", id, res.status, truncated(res.body))
	}
	var grant uploadGrant
	if err := json.Unmarshal(res.body, &grant); err != nil {
		a.t.Fatal(err)
	}
	return grant
}

func (a *account) grantDownloads(ids ...string) downloadGrant {
	a.t.Helper()
	res := request(a.t, "POST", "/files/download", a.tokens.access, mustJSON(a.t, map[string][]string{"ids": ids}))
	if res.status != 200 {
		a.t.Fatalf("download: %d %s", res.status, truncated(res.body))
	}
	var grant downloadGrant
	if err := json.Unmarshal(res.body, &grant); err != nil {
		a.t.Fatal(err)
	}
	return grant
}

func (a *account) usage() (used, quota int64) {
	a.t.Helper()
	res := request(a.t, "GET", "/files/usage", a.tokens.access, nil)
	var got struct {
		UsedBytes  int64 `json:"used_bytes"`
		QuotaBytes int64 `json:"quota_bytes"`
	}
	if res.status != 200 || json.Unmarshal(res.body, &got) != nil {
		a.t.Fatalf("usage: %d %s", res.status, truncated(res.body))
	}
	return got.UsedBytes, got.QuotaBytes
}

// direct sends a request to a link outside the API, as the app does to the bucket and the files host.
func direct(t *testing.T, method, link string, body []byte, headers map[string]string) response {
	t.Helper()
	req, err := http.NewRequest(method, link, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		if name != "Content-Length" {
			req.Header.Set(name, value)
		}
	}
	if body == nil {
		req.ContentLength = 0
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return response{res.StatusCode, raw, res.Header}
}

// The whole journey: the record syncs, the API grants an upload of exactly its bytes, the app puts them, another device
// asks for a link and fetches them from the files host, with nothing in them able to run there.
func TestSmokeAttachmentRoundTrip(t *testing.T) {
	needs(t, filesStored)
	a := signIn(t)
	photo := []byte(fmt.Sprintf("a photo of a receipt, %s", fresh("bytes")))
	id := fresh("photo")
	a.attach(id, photo)

	grant := a.grantUpload(id)
	if grant.QuotaBytes != int64(defaultQuota(t)) || grant.UsedBytes < int64(len(photo)) || grant.Headers["x-amz-checksum-sha256"] != digest(photo) {
		t.Fatalf("%+v", grant)
	}
	if left := time.Until(grant.ExpiresAt); left < 4*time.Minute || left > 6*time.Minute {
		t.Errorf("the link lasts %v", left)
	}
	// The bucket takes only the bytes granted.
	if res := direct(t, "PUT", grant.URL, append(bytes.Clone(photo), '!'), grant.Headers); res.status/100 == 2 {
		t.Fatalf("a file of another size landed: %d", res.status)
	}
	if res := direct(t, "PUT", grant.URL, photo, grant.Headers); res.status != 200 {
		t.Fatalf("upload: %d %s", res.status, truncated(res.body))
	}

	// The same person on another device.
	other := newAccount(t, a.username, a.login)
	got := other.grantDownloads(id, fresh("never"))
	if len(got.Files) != 1 || got.Files[0].ID != id || len(got.Missing) != 1 {
		t.Fatalf("%+v", got)
	}
	res := direct(t, "GET", got.Files[0].URL, nil, nil)
	if res.status != 200 || !bytes.Equal(res.body, photo) {
		t.Fatalf("download: %d %s", res.status, truncated(res.body))
	}
	if res.header.Get("X-Content-Type-Options") != "nosniff" || res.header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
		t.Errorf("headers %v", res.header)
	}
	// The edge serves only signed requests.
	link, _ := url.Parse(got.Files[0].URL)
	link.RawQuery = ""
	if res := direct(t, "GET", link.String(), nil, nil); res.status != 403 {
		t.Errorf("an unsigned request: %d", res.status)
	}
}

// One person's attachment isn't another's to download, even by its id.
func TestAnotherPersonsFileIsMissing(t *testing.T) {
	needs(t, filesStored)
	a := signIn(t)
	b := signInOther(t)
	id := fresh("photo")
	a.attach(id, []byte("mine"))
	a.grantUpload(id)
	if got := b.grantDownloads(id); len(got.Files) != 0 || len(got.Missing) != 1 {
		t.Fatalf("%+v", got)
	}
	if res := b.askUpload(id); res.status != 404 || res.errorCode() != "not_found" {
		t.Fatalf("%d %s", res.status, res.body)
	}
}

func TestUploadRefusals(t *testing.T) {
	needs(t, filesStored)
	a := signIn(t)
	used, _ := a.usage()
	ids := map[string]string{"missing": fresh("missing")}
	attach := func(name string, body []byte, pairs ...any) {
		ids[name] = fresh(name)
		a.attach(ids[name], body, pairs...)
	}
	attach("large", nil, "size", maxFileBytes+1, "sha256", digest([]byte("x")))
	attach("html", []byte("<script>"), "type", "text/html")
	attach("deleted", []byte("x"), "deleted_at", time.Now().UTC().Format(time.RFC3339))
	attach("link", []byte("x"), "kind", "link", "url", "https://example.com")
	attach("no-hash", []byte("x"), "sha256", nil)
	for _, c := range []struct{ name, code string }{
		{"large", "file_too_large"}, {"html", "type_not_allowed"}, {"deleted", "not_found"}, {"link", "not_found"},
		{"no-hash", "invalid_attachment"}, {"missing", "not_found"},
	} {
		res := a.askUpload(ids[c.name])
		if res.errorCode() != c.code {
			t.Errorf("%s: %d %s", c.name, res.status, truncated(res.body))
		}
	}
	if res := request(t, "POST", "/files/download", a.tokens.access, []byte(`{"ids":[]}`)); res.status != 400 || res.errorCode() != "invalid_request" {
		t.Errorf("no ids: %d %s", res.status, res.body)
	}
	if res := request(t, "GET", "/files/usage", "", nil); res.status != 401 {
		t.Errorf("usage without a token: %d", res.status)
	}
	if now, _ := a.usage(); now != used {
		t.Errorf("a refusal took storage: %d, then %d", used, now)
	}
}

// The quota and the hourly upload limit, each reached on the local stack by someone new.
func TestTheQuotaAndTheUploadLimit(t *testing.T) {
	needs(t, filesStored, fakeClock)
	clock := holdClock(t)
	full := signIn(t)
	quota := defaultQuota(t)
	// Granted, never uploaded: the grant counts the bytes, so the test needn't send them.
	big := digest(bytes.Repeat([]byte("x"), maxFileBytes))
	for i := 0; i < quota/maxFileBytes; i++ {
		id := fresh("big")
		full.attach(id, nil, "size", maxFileBytes, "sha256", big)
		full.grantUpload(id)
	}
	id := fresh("one-more")
	full.attach(id, []byte("x"))
	res := full.askUpload(id)
	var refused struct {
		Error      string `json:"error"`
		UsedBytes  int    `json:"used_bytes"`
		QuotaBytes int    `json:"quota_bytes"`
	}
	json.Unmarshal(res.body, &refused)
	if res.status != 403 || refused.Error != "quota_exceeded" || refused.UsedBytes != quota/maxFileBytes*maxFileBytes || refused.QuotaBytes != quota {
		t.Fatalf("%d %s", res.status, res.body)
	}

	busy := signIn(t)
	env, _ := appconfig.ForEnv(target.Env)
	for i := 0; i <= env.Attachments.UploadsPerHour; i++ {
		id := fresh("small")
		busy.attach(id, []byte(id))
		res := busy.askUpload(id)
		if i < env.Attachments.UploadsPerHour {
			if res.status != 200 {
				t.Fatalf("upload %d: %d %s", i, res.status, res.body)
			}
			continue
		}
		var limited struct {
			Error   string    `json:"error"`
			RetryAt time.Time `json:"retry_at"`
		}
		json.Unmarshal(res.body, &limited)
		if next := clock.now.Truncate(time.Hour).Add(time.Hour); res.status != 429 || limited.Error != "upload_rate" || !limited.RetryAt.Equal(next) {
			t.Fatalf("%d %s, want a retry at %v", res.status, res.body, next)
		}
		clock.to(limited.RetryAt)
		busy.reSignIn()
		if res := busy.askUpload(id); res.status != 200 {
			t.Fatalf("in the next hour: %d %s", res.status, res.body)
		}
	}
}

// make storage-quota against the local stack: it reads a person's usage, raises their quota, and resets it.
func TestStorageQuotaScript(t *testing.T) {
	needs(t, filesStored, localTables)
	a := signIn(t)
	id := fresh("photo")
	a.attach(id, []byte("photo"))
	a.grantUpload(id)
	run := func(gb string) string {
		t.Helper()
		cmd := exec.Command("bash", "../../scripts/storage-quota.sh")
		cmd.Env = append(os.Environ(), "ENV=local", "EMAIL="+a.username, "GB="+gb,
			"LOCAL_API_URL="+target.APIURL, "DYNAMODB_ENDPOINT="+os.Getenv("INTEGRATION_DYNAMODB_ENDPOINT"))
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("GB=%s: %v\n%s", gb, err, out)
		}
		return string(out)
	}
	quota := defaultQuota(t)
	if out := run(""); !strings.Contains(out, fmt.Sprintf(": 5 of %d bytes stored", quota)) || !strings.Contains(out, "the default quota") {
		t.Errorf("%s", out)
	}
	if out := run("1"); !strings.Contains(out, "Raised") || !strings.Contains(out, fmt.Sprintf(": 5 of %d bytes stored", 1<<30)) {
		t.Errorf("%s", out)
	}
	if _, got := a.usage(); got != 1<<30 {
		t.Errorf("the API sees a quota of %d", got)
	}
	if out := run("default"); !strings.Contains(out, "the default quota") {
		t.Errorf("%s", out)
	}
	if _, got := a.usage(); got != int64(quota) {
		t.Errorf("the API sees a quota of %d after the reset", got)
	}
}
