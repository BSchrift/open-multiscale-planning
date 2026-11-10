package files_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/files"
)

// The presigned PUT on its own, with no table: the stand-in takes it only as signed.
func TestPutSignerSignsTheSizeTypeAndChecksum(t *testing.T) {
	now := start
	bucket := &fakes.Bucket{Region: "us-west-2", Credentials: creds, Now: func() time.Time { return now }}
	srv := httptest.NewServer(bucket.Uploads("/b/"))
	defer srv.Close()
	body := []byte("bytes")
	signer := &files.PutSigner{Endpoint: srv.URL + "/b", Region: "us-west-2", Credentials: credentials.StaticCredentialsProvider{Value: creds}}
	headers := map[string]string{"Content-Type": "application/pdf", "Content-Disposition": "attachment", "x-amz-checksum-sha256": hash(body)}
	link, err := signer.Presign(context.Background(), "u/abc/f1", int64(len(body)), headers, now, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	up := files.Upload{URL: link, Headers: headers}
	if status := put(t, up, body, nil); status != http.StatusOK {
		t.Fatalf("%d", status)
	}
	if got, _ := bucket.Object("u/abc/f1"); !bytes.Equal(got, body) {
		t.Fatalf("%q", got)
	}
	other := &files.PutSigner{Endpoint: srv.URL + "/b", Region: "us-west-2", Credentials: credentials.NewStaticCredentialsProvider("other", "other", "")}
	if link, _ := other.Presign(context.Background(), "u/abc/f2", int64(len(body)), headers, now, 5*time.Minute); put(t, files.Upload{URL: link, Headers: headers}, body, nil) != http.StatusForbidden {
		t.Fatal("took a link signed with other credentials")
	}
}

func pemOf(t *testing.T, kind string, der []byte) string {
	t.Helper()
	return string(pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}))
}

func TestParsePrivateKey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(key)
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ecDER, _ := x509.MarshalPKCS8PrivateKey(ec)
	for name, text := range map[string]string{
		"PKCS #8, as make files-key writes it": pemOf(t, "PRIVATE KEY", pkcs8),
		"PKCS #1":                              pemOf(t, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(key)),
	} {
		if got, err := files.ParsePrivateKey(text); err != nil || !got.Equal(key) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, text := range map[string]string{"not PEM": "a key", "not RSA": pemOf(t, "PRIVATE KEY", ecDER), "not a key": pemOf(t, "PRIVATE KEY", []byte("x"))} {
		if _, err := files.ParsePrivateKey(text); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}

type parameters struct {
	value string
	err   error
	reads int
}

func (p *parameters) GetParameter(_ context.Context, in *ssm.GetParameterInput, _ ...func(*ssm.Options)) (*ssm.GetParameterOutput, error) {
	p.reads++
	if !aws.ToBool(in.WithDecryption) || aws.ToString(in.Name) != "/multiscale/staging/files/k1" {
		return nil, errors.New("wrong request")
	}
	if p.err != nil {
		return nil, p.err
	}
	return &ssm.GetParameterOutput{Parameter: &ssmtypes.Parameter{Value: aws.String(p.value)}}, nil
}

// The key is read when first needed, not at start, so a missing one fails downloads alone; once read it's kept.
func TestSSMKeyIsReadOnceItsNeededAndKept(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	p := &parameters{err: &ssmtypes.ParameterNotFound{}}
	k := &files.SSMKey{Client: p, Name: "/multiscale/staging/files/k1"}
	if _, err := k.Key(context.Background()); err == nil {
		t.Fatal("a missing key passed")
	}
	p.err, p.value = nil, pemOf(t, "PRIVATE KEY", der)
	for range 2 {
		got, err := k.Key(context.Background())
		if err != nil || !got.(*rsa.PrivateKey).Equal(key) {
			t.Fatal(err)
		}
	}
	if p.reads != 2 {
		t.Errorf("read %d times: a failure is tried again, a key is kept", p.reads)
	}
}
