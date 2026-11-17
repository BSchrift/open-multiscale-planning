package account

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	cognito "github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	cognitotypes "github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3Objects is the files bucket.
type S3Objects struct {
	Client *s3.Client
	Bucket string
}

// Get reads an object, or returns nil for one that isn't there.
func (o *S3Objects) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := o.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(o.Bucket), Key: aws.String(key)})
	var missing *s3types.NoSuchKey
	if errors.As(err, &missing) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}

// Put streams an object in parts, so an export of any size goes up without being held in memory.
func (o *S3Objects) Put(ctx context.Context, key string, body io.Reader, contentType, disposition string) error {
	_, err := manager.NewUploader(o.Client).Upload(ctx, &s3.PutObjectInput{
		Bucket: aws.String(o.Bucket), Key: aws.String(key), Body: body,
		ContentType: aws.String(contentType), ContentDisposition: aws.String(disposition),
	})
	return err
}

func (o *S3Objects) List(ctx context.Context, prefix string) ([]string, error) {
	var keys []string
	pages := s3.NewListObjectsV2Paginator(o.Client, &s3.ListObjectsV2Input{Bucket: aws.String(o.Bucket), Prefix: aws.String(prefix)})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, object := range page.Contents {
			keys = append(keys, aws.ToString(object.Key))
		}
	}
	return keys, nil
}

// DeleteAll deletes keys a thousand at a time, the most one DeleteObjects takes.
func (o *S3Objects) DeleteAll(ctx context.Context, keys []string) error {
	for start := 0; start < len(keys); start += 1000 {
		var objects []s3types.ObjectIdentifier
		for _, key := range keys[start:min(start+1000, len(keys))] {
			objects = append(objects, s3types.ObjectIdentifier{Key: aws.String(key)})
		}
		out, err := o.Client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(o.Bucket), Delete: &s3types.Delete{Objects: objects, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return err
		}
		if len(out.Errors) > 0 {
			return errors.New("account: some objects weren't deleted: " + aws.ToString(out.Errors[0].Code))
		}
	}
	return nil
}

// CognitoIdentity is the user pool, through its admin API. Signing in by email makes each user's username a UUID of its
// own, so a user is found by the sub its tokens carry.
type CognitoIdentity struct {
	Client *cognito.Client
	PoolID string
}

// user is the sign-in with this sub: its username and attributes, or "" for none.
func (c *CognitoIdentity) user(ctx context.Context, sub string) (string, map[string]string, error) {
	// The filter quotes the sub, so one that could close the quote is refused, though a verified token's never is.
	if sub == "" || strings.ContainsAny(sub, `"\`) {
		return "", nil, errors.New("account: not a sub")
	}
	out, err := c.Client.ListUsers(ctx, &cognito.ListUsersInput{
		UserPoolId: aws.String(c.PoolID), Filter: aws.String(`sub = "` + sub + `"`), Limit: aws.Int32(1),
	})
	if err != nil || len(out.Users) == 0 {
		return "", nil, err
	}
	attributes := map[string]string{}
	for _, a := range out.Users[0].Attributes {
		attributes[aws.ToString(a.Name)] = aws.ToString(a.Value)
	}
	// Only ever the user the sub names, whatever the filter matched.
	if attributes["sub"] != sub {
		return "", nil, errors.New("account: the pool answered with another user")
	}
	return aws.ToString(out.Users[0].Username), attributes, nil
}

func (c *CognitoIdentity) Exists(ctx context.Context, sub string) (bool, error) {
	username, _, err := c.user(ctx, sub)
	return username != "", err
}

func (c *CognitoIdentity) Email(ctx context.Context, sub string) (string, error) {
	_, attributes, err := c.user(ctx, sub)
	return attributes["email"], err
}

func (c *CognitoIdentity) Delete(ctx context.Context, sub string) error {
	username, _, err := c.user(ctx, sub)
	if err != nil || username == "" {
		return err
	}
	_, err = c.Client.AdminDeleteUser(ctx, &cognito.AdminDeleteUserInput{UserPoolId: aws.String(c.PoolID), Username: aws.String(username)})
	var missing *cognitotypes.UserNotFoundException
	if errors.As(err, &missing) {
		return nil
	}
	return err
}

// IdentityFromEnvironment is the deployed user pool, from what the stack sets.
func IdentityFromEnvironment(cfg aws.Config) *CognitoIdentity {
	return &CognitoIdentity{Client: cognito.NewFromConfig(cfg), PoolID: os.Getenv("USER_POOL_ID")}
}

// TokensFromEnvironment checks lapsed tokens against the deployed user pool's keys, for the apps' client and the
// integration suite's.
func TokensFromEnvironment(cfg aws.Config) *Tokens {
	issuer := "https://cognito-idp." + cfg.Region + ".amazonaws.com/" + os.Getenv("USER_POOL_ID")
	jwks := &JWKS{URL: issuer + "/.well-known/jwks.json", Client: &http.Client{Timeout: 5 * time.Second}}
	return &Tokens{Issuer: issuer, ClientIDs: strings.Split(os.Getenv("USER_POOL_CLIENT_IDS"), ","), Keys: jwks.Keys, Now: time.Now}
}

// ObjectsFromEnvironment is the files bucket, or nil where the environment stores no files.
func ObjectsFromEnvironment(cfg aws.Config) *S3Objects {
	bucket := os.Getenv("FILES_BUCKET")
	if bucket == "" {
		return nil
	}
	return &S3Objects{Client: s3.NewFromConfig(cfg), Bucket: bucket}
}
