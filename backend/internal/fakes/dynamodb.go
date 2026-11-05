// Package fakes holds local stand-ins for the AWS pieces DynamoDB Local and Moto don't cover.
package fakes

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

// CreateTable makes the production table's shape: pk and sk, an all-projection local index on seq, and a stream. An
// existing table is left as it is.
func CreateTable(ctx context.Context, client *dynamodb.Client, table string) error {
	_, err := client.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName:   aws.String(table),
		BillingMode: types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("sk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("seq"), AttributeType: types.ScalarAttributeTypeN},
		},
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("sk"), KeyType: types.KeyTypeRange},
		},
		LocalSecondaryIndexes: []types.LocalSecondaryIndex{{
			IndexName: aws.String("by_seq"),
			KeySchema: []types.KeySchemaElement{
				{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
				{AttributeName: aws.String("seq"), KeyType: types.KeyTypeRange},
			},
			Projection: &types.Projection{ProjectionType: types.ProjectionTypeAll},
		}},
		StreamSpecification: &types.StreamSpecification{
			StreamEnabled:  aws.Bool(true),
			StreamViewType: types.StreamViewTypeNewImage,
		},
	})
	var exists *types.ResourceInUseException
	if errors.As(err, &exists) {
		return nil
	}
	return err
}

// ConflictDB fails the next Conflicts transactions the way DynamoDB does when another writer moved the counter, which
// DynamoDB Local never does on its own.
type ConflictDB struct {
	sync.DB
	Conflicts atomic.Int64
}

func (d *ConflictDB) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	for {
		left := d.Conflicts.Load()
		if left <= 0 {
			return d.DB.TransactWriteItems(ctx, in, opts...)
		}
		if d.Conflicts.CompareAndSwap(left, left-1) {
			return nil, &types.TransactionCanceledException{
				Message:             aws.String("injected conflict"),
				CancellationReasons: []types.CancellationReason{{Code: aws.String("ConditionalCheckFailed")}},
			}
		}
	}
}
