package gcal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
)

func TestSecretsThroughTheRealSDK(t *testing.T) {
	endpoint := os.Getenv("SSM_ENDPOINT")
	if endpoint == "" {
		t.Skip("SSM_ENDPOINT not set: start Moto to run this test")
	}
	client := ssm.New(ssm.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	ctx := context.Background()
	prefix := fmt.Sprintf("/multiscale/test-%d", time.Now().UnixNano())
	secrets := &SSMSecrets{Client: client, Prefix: prefix}

	if _, err := secrets.Get(ctx, SecretRefreshToken); !errors.Is(err, ErrNoSecret) {
		t.Fatalf("missing: %v", err)
	}
	for _, value := range []string{"first-value", "second-value"} {
		if err := secrets.Put(ctx, SecretRefreshToken, value); err != nil {
			t.Fatal(err)
		}
		got, err := secrets.Get(ctx, SecretRefreshToken)
		if err != nil || got != value {
			t.Fatalf("%q %v", got, err)
		}
	}
	name := prefix + "/" + SecretRefreshToken
	stored, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name)})
	if err != nil {
		t.Fatal(err)
	}
	if stored.Parameter.Type != types.ParameterTypeSecureString {
		t.Fatalf("stored as %s", stored.Parameter.Type)
	}
	if aws.ToString(stored.Parameter.Value) == "second-value" {
		t.Fatal("read back without decryption gave the plain value")
	}
}

func TestStatesAreSingleUseInDynamoDB(t *testing.T) {
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("DYNAMODB_ENDPOINT not set: start DynamoDB Local to run this test")
	}
	client := dynamodb.New(dynamodb.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	ctx := context.Background()
	table := fmt.Sprintf("states-test-%d", time.Now().UnixNano())
	if err := fakes.CreateTable(ctx, client, table); err != nil {
		t.Fatal(err)
	}
	defer client.DeleteTable(ctx, &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	states := &DynamoStates{DB: client, Table: table}

	if ok, err := states.Consume(ctx, "one", "n1"); ok || err != nil {
		t.Fatalf("nothing stored: %v %v", ok, err)
	}
	if err := states.Put(ctx, "one", "n1"); err != nil {
		t.Fatal(err)
	}
	if ok, err := states.Consume(ctx, "two", "n1"); ok || err != nil {
		t.Fatalf("other user: %v %v", ok, err)
	}
	if ok, err := states.Consume(ctx, "one", "other"); ok || err != nil {
		t.Fatalf("other nonce: %v %v", ok, err)
	}
	if ok, err := states.Consume(ctx, "one", "n1"); !ok || err != nil {
		t.Fatalf("right nonce: %v %v", ok, err)
	}
	if ok, err := states.Consume(ctx, "one", "n1"); ok || err != nil {
		t.Fatalf("second use: %v %v", ok, err)
	}
	if err := states.Put(ctx, "one", "n2"); err != nil {
		t.Fatal(err)
	}
	if err := states.Put(ctx, "one", "n3"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := states.Consume(ctx, "one", "n2"); ok {
		t.Fatal("replaced nonce still works")
	}
}
