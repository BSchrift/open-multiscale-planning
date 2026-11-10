package fakes

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	stdsync "sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// Bucket stands in for the attachments bucket and the CloudFront distribution in front of it, so uploads and downloads
// work with no AWS. It takes a presigned PUT only when its SigV4 signature holds and covers the size, type and checksum,
// as S3 then refuses any other bytes, and serves a GET only with a valid CloudFront signed URL. Objects live in memory.
type Bucket struct {
	Region      string
	Credentials aws.Credentials
	// PublicKeys are the keys a download link may be signed with, by key pair id, as the distribution's key group holds.
	PublicKeys map[string]*rsa.PublicKey
	Now        func() time.Time

	mu      stdsync.Mutex
	objects map[string]object
}

type object struct {
	body                     []byte
	contentType, disposition string
}

// The headers an upload has to have signed: S3 then takes exactly the bytes the API granted.
var signedForUpload = []string{"content-length", "content-type", "host", "x-amz-checksum-sha256"}

// Uploads takes presigned PUTs to keys under prefix, the path it's served at, which the signature covers too.
func (b *Bucket) Uploads(prefix string) http.Handler {
	return withOpenCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key, ok := strings.CutPrefix(r.URL.Path, prefix)
		if r.Method != http.MethodPut || !ok || key == "" {
			s3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
			return
		}
		if code := b.checkPresigned(r); code != "" {
			s3Error(w, http.StatusForbidden, code)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, r.ContentLength+1))
		if err != nil || int64(len(body)) != r.ContentLength {
			s3Error(w, http.StatusBadRequest, "IncompleteBody")
			return
		}
		sum := sha256.Sum256(body)
		if base64.StdEncoding.EncodeToString(sum[:]) != r.Header.Get("x-amz-checksum-sha256") {
			s3Error(w, http.StatusBadRequest, "BadDigest")
			return
		}
		b.mu.Lock()
		if b.objects == nil {
			b.objects = map[string]object{}
		}
		b.objects[key] = object{body, r.Header.Get("Content-Type"), r.Header.Get("Content-Disposition")}
		b.mu.Unlock()
		w.Header().Set("ETag", fmt.Sprintf(`"%x"`, sum[:16]))
		w.WriteHeader(http.StatusOK)
	}))
}

// checkPresigned signs the request again as the presigner would have, from the headers it says it signed, and compares.
// It returns S3's error code, or "" when the signature holds.
func (b *Bucket) checkPresigned(r *http.Request) string {
	q := r.URL.Query()
	signedAt, err := time.Parse("20060102T150405Z", q.Get("X-Amz-Date"))
	if err != nil || q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" {
		return "AuthorizationQueryParametersError"
	}
	expires, err := strconv.Atoi(q.Get("X-Amz-Expires"))
	if err != nil || b.Now().After(signedAt.Add(time.Duration(expires)*time.Second)) {
		return "AccessDenied"
	}
	signed := strings.Split(q.Get("X-Amz-SignedHeaders"), ";")
	for _, name := range signedForUpload {
		if !slices.Contains(signed, name) {
			return "AccessDenied"
		}
	}
	again := url.Values{"X-Amz-Expires": {q.Get("X-Amz-Expires")}}
	u := url.URL{Scheme: "http", Host: r.Host, Path: r.URL.Path, RawQuery: again.Encode()}
	req, err := http.NewRequest(http.MethodPut, u.String(), nil)
	if err != nil {
		return "AccessDenied"
	}
	req.Host, req.ContentLength = r.Host, r.ContentLength
	for _, name := range signed {
		if name != "host" && name != "content-length" {
			req.Header.Set(name, r.Header.Get(name))
		}
	}
	signer := v4.NewSigner(func(o *v4.SignerOptions) { o.DisableHeaderHoisting, o.DisableURIPathEscaping = true, true })
	presigned, _, err := signer.PresignHTTP(context.Background(), b.Credentials, req, "UNSIGNED-PAYLOAD", "s3", b.Region, signedAt)
	if err != nil {
		return "AccessDenied"
	}
	want, _ := url.Parse(presigned)
	if subtle.ConstantTimeCompare([]byte(want.Query().Get("X-Amz-Signature")), []byte(q.Get("X-Amz-Signature"))) != 1 {
		return "SignatureDoesNotMatch"
	}
	return ""
}

// Downloads serves keys under prefix to CloudFront signed URLs, with the headers the distribution adds.
func (b *Bucket) Downloads(prefix string) http.Handler {
	return withOpenCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key, ok := strings.CutPrefix(r.URL.Path, prefix)
		if r.Method != http.MethodGet || !ok || key == "" {
			s3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
			return
		}
		if !b.checkSignedURL(r) {
			s3Error(w, http.StatusForbidden, "AccessDenied")
			return
		}
		b.mu.Lock()
		found, ok := b.objects[key]
		b.mu.Unlock()
		if !ok {
			s3Error(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		w.Header().Set("Content-Type", found.contentType)
		if found.disposition != "" {
			w.Header().Set("Content-Disposition", found.disposition)
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		w.Write(found.body)
	}))
}

// checkSignedURL checks a canned policy's signature as CloudFront does: SHA-1 with RSA over the policy for this URL and
// expiry, in CloudFront's URL-safe base64.
func (b *Bucket) checkSignedURL(r *http.Request) bool {
	q := r.URL.Query()
	key := b.PublicKeys[q.Get("Key-Pair-Id")]
	expires, err := strconv.ParseInt(q.Get("Expires"), 10, 64)
	if key == nil || err != nil || b.Now().Unix() >= expires {
		return false
	}
	signature, err := base64.StdEncoding.DecodeString(strings.NewReplacer("-", "+", "_", "=", "~", "/").Replace(q.Get("Signature")))
	if err != nil {
		return false
	}
	resource := (&url.URL{Scheme: "http", Host: r.Host, Path: r.URL.Path}).String()
	policy := fmt.Sprintf(`{"Statement":[{"Resource":"%s","Condition":{"DateLessThan":{"AWS:EpochTime":%d}}}]}`, resource, expires)
	sum := sha1.Sum([]byte(policy))
	return rsa.VerifyPKCS1v15(key, crypto.SHA1, sum[:], signature) == nil
}

// Delete removes an object, as the retention function's DeleteObject does. A missing key is no error, as in S3.
func (b *Bucket) Delete(_ context.Context, key string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.objects, key)
	return nil
}

// Object returns an object's bytes, for tests to check what landed and what's gone.
func (b *Bucket) Object(key string) ([]byte, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	found, ok := b.objects[key]
	return bytes.Clone(found.body), ok
}

// withOpenCORS answers what the bucket's CORS and the distribution answer the apps' origins, for any origin: the local
// web app runs on whatever port its test picked.
func withOpenCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				w.Header().Set("Access-Control-Allow-Methods", "PUT,GET,HEAD")
				w.Header().Set("Access-Control-Allow-Headers", "content-type,content-disposition,x-amz-checksum-sha256")
				w.Header().Set("Access-Control-Max-Age", "86400")
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func s3Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, "<Error><Code>%s</Code></Error>", code)
}
