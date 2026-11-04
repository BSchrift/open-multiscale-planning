package gcal

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

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

// FromEnvironment builds the deployed connection from what the stack sets, for both Lambdas.
func FromEnvironment(cfg aws.Config, trigger func(context.Context) error) *Google {
	client := dynamodb.NewFromConfig(cfg)
	table := os.Getenv("TABLE_NAME")
	return &Google{
		Records:     &sync.Store{DB: client, Table: table},
		Secrets:     &SSMSecrets{Client: ssm.NewFromConfig(cfg), Prefix: os.Getenv("SSM_PREFIX")},
		States:      &DynamoStates{DB: client, Table: table},
		Log:         obs.NewLogger(os.Stdout),
		Env:         os.Getenv("ENV_NAME"),
		Now:         time.Now,
		AuthURL:     GoogleAuthURL,
		TokenURL:    GoogleTokenURL,
		RedirectURL: os.Getenv("API_URL") + "/calendar/callback",
		Trigger:     trigger,
	}
}
