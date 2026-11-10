package files

import (
	"context"
	"crypto"
	"os"
	gosync "sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

// ParameterReader is the part of SSM that reading the key uses.
type ParameterReader interface {
	GetParameter(context.Context, *ssm.GetParameterInput, ...func(*ssm.Options)) (*ssm.GetParameterOutput, error)
}

// SSMKey reads the key from an SSM SecureString the first time it's needed and keeps it. Not at start: a missing or bad
// key then fails only the download route, never sync. A failure isn't kept, so the next request tries again.
type SSMKey struct {
	Client ParameterReader
	Name   string

	mu  gosync.Mutex
	key crypto.Signer
}

func (k *SSMKey) Key(ctx context.Context) (crypto.Signer, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.key != nil {
		return k.key, nil
	}
	out, err := k.Client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(k.Name), WithDecryption: aws.Bool(true)})
	if err != nil {
		return nil, err
	}
	key, err := ParsePrivateKey(aws.ToString(out.Parameter.Value))
	if err != nil {
		return nil, err
	}
	k.key = key
	return key, nil
}

// S3Objects deletes from the attachments bucket.
type S3Objects struct {
	Client *s3.Client
	Bucket string
}

func (o *S3Objects) Delete(ctx context.Context, key string) error {
	_, err := o.Client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(o.Bucket), Key: aws.String(key)})
	return err
}

// FromEnvironment builds the deployed service from what the stack sets, or returns nil where the environment stores no
// files, so the routes answer that it doesn't.
func FromEnvironment(cfg aws.Config, records *sync.Store, limits Limits) *Service {
	upload, files := os.Getenv("FILES_UPLOAD_URL"), os.Getenv("FILES_URL")
	if upload == "" || files == "" {
		return nil
	}
	return &Service{
		DB:       dynamodb.NewFromConfig(cfg),
		Table:    os.Getenv("TABLE_NAME"),
		Records:  records,
		Uploads:  &PutSigner{Endpoint: upload, Region: cfg.Region, Credentials: cfg.Credentials},
		FilesURL: files,
		KeyID:    os.Getenv("FILES_KEY_ID"),
		Key:      &SSMKey{Client: ssm.NewFromConfig(cfg), Name: os.Getenv("FILES_KEY_PARAM")},
		Limits:   limits,
		Now:      time.Now,
	}
}

// RemoverFromEnvironment builds the retention function's remover, or returns nil where the environment stores no files.
func RemoverFromEnvironment(cfg aws.Config, db RemoverDB) *Remover {
	bucket := os.Getenv("FILES_BUCKET")
	if bucket == "" {
		return nil
	}
	return &Remover{DB: db, Table: os.Getenv("TABLE_NAME"), Objects: &S3Objects{Client: s3.NewFromConfig(cfg), Bucket: bucket}}
}
