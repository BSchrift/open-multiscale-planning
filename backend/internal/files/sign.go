package files

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// PutSigner presigns S3 PUTs with SigV4. Every header goes into the signature as a header rather than the query, which
// the SDK's S3 presigner does for some, so S3 refuses a request whose size, type or checksum differs from the grant.
type PutSigner struct {
	// Endpoint is where keys go: https://<bucket>.s3.<region>.amazonaws.com, or the local stand-in's address.
	Endpoint    string
	Region      string
	Credentials aws.CredentialsProvider
}

func (p *PutSigner) Presign(ctx context.Context, key string, size int64, headers map[string]string, at time.Time, expires time.Duration) (string, error) {
	creds, err := p.Credentials.Retrieve(ctx)
	if err != nil {
		return "", err
	}
	query := url.Values{"X-Amz-Expires": {strconv.Itoa(int(expires / time.Second))}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, p.Endpoint+"/"+key+"?"+query.Encode(), nil)
	if err != nil {
		return "", err
	}
	req.ContentLength = size
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	signer := v4.NewSigner(func(o *v4.SignerOptions) { o.DisableHeaderHoisting, o.DisableURIPathEscaping = true, true })
	signed, _, err := signer.PresignHTTP(ctx, creds, req, "UNSIGNED-PAYLOAD", "s3", p.Region, at)
	return signed, err
}

// SigningKey gives the private key download links are signed with.
type SigningKey interface {
	Key(ctx context.Context) (crypto.Signer, error)
}

// StaticKey is a key already in hand, as on the local stack, which makes one at start.
type StaticKey struct{ Signer crypto.Signer }

func (k StaticKey) Key(context.Context) (crypto.Signer, error) { return k.Signer, nil }

// ParsePrivateKey reads an RSA private key from PEM, PKCS #8 as make files-key writes it, or PKCS #1.
func ParsePrivateKey(text string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(text))
	if block == nil {
		return nil, errors.New("files: the signing key isn't PEM")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("files: the signing key isn't an RSA private key")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("files: the signing key isn't an RSA private key")
	}
	return key, nil
}
