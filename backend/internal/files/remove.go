package files

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// The sort key prefix of an attachment's record, whose removal takes its file with it.
const attachmentRecord = "rec#" + attachmentType + "#"

// RemoverDB is the part of DynamoDB removing a file uses.
type RemoverDB interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
}

// Objects deletes from the bucket. A missing key is no error, as in S3.
type Objects interface {
	Delete(ctx context.Context, key string) error
}

// Remover takes an attachment's file with its record, when TTL or staging's cleanup removes the record: the object,
// its file# item and its bytes in meta#storage. A file follows its record, so it stays while the record can still be
// restored, and Undo brings both back.
type Remover struct {
	DB      RemoverDB
	Table   string
	Objects Objects
}

// Removing removes the file of the record at pk and sk, if it's an attachment's and one was granted. It deletes the
// object first, so a failure part way leaves file#<id> for the next try to find; deleting again is harmless.
func (r *Remover) Removing(ctx context.Context, pk, sk string) error {
	id, ok := strings.CutPrefix(sk, attachmentRecord)
	if !ok || !strings.HasPrefix(pk, "user#") {
		return nil
	}
	fileKey := map[string]types.AttributeValue{"pk": str(pk), "sk": str(filePrefix + id)}
	out, err := r.DB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(r.Table), Key: fileKey, ConsistentRead: aws.Bool(true)})
	if err != nil {
		return fmt.Errorf("files: remove: %w", err)
	}
	if out.Item == nil {
		return nil
	}
	object := stringAttr(out.Item["key"])
	size, err := numberAttr(out.Item["size"])
	if err != nil || object == "" {
		return fmt.Errorf("files: remove: malformed %s", filePrefix)
	}
	if err := r.Objects.Delete(ctx, object); err != nil {
		return fmt.Errorf("files: remove object: %w", err)
	}
	_, err = r.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: []types.TransactWriteItem{
		{Delete: &types.Delete{
			TableName:                 aws.String(r.Table),
			Key:                       fileKey,
			ConditionExpression:       aws.String("#key = :key"),
			ExpressionAttributeNames:  map[string]string{"#key": "key"},
			ExpressionAttributeValues: map[string]types.AttributeValue{":key": str(object)},
		}},
		{Update: &types.Update{
			TableName:                 aws.String(r.Table),
			Key:                       map[string]types.AttributeValue{"pk": str(pk), "sk": str(storageKey)},
			UpdateExpression:          aws.String("ADD #value :freed"),
			ExpressionAttributeNames:  map[string]string{"#value": "value"},
			ExpressionAttributeValues: map[string]types.AttributeValue{":freed": num(-size)},
		}},
	}})
	// Another removal of the same record got there first, as when TTL and staging's cleanup both reach it.
	if conditionFailed(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("files: remove: %w", err)
	}
	return nil
}
