package sync

// Removing expired records. DynamoDB's TTL removes each item once its expires_at attribute has passed, and the Streams
// consumer in cmd/retention raises the user's expiry mark from each removal it reads. Why TTL and Streams rather than a
// job that removes records itself:
//   - TTL deletes cost no write units, and Lambda reads a table's stream at no charge.
//   - A job would read the whole table each run, or need an index that every write pays for, and pay for each delete.
//   - Late removal is safe. TTL can take days, but pulls leave out an expired record as soon as its expires_at passes, the
//     apps remove theirs by expires_at, and Push drops changes to one. So nothing waits on the item being gone: the
//     mark only has to cover what was really removed, which is all a device can no longer be told about.
//   - Staging's periods are minutes, so there Cleanup below runs every few minutes to remove what TTL hasn't reached
//     yet, raising the mark itself before it removes anything. Prod relies on TTL alone.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

// markSettles is how long cleanup leaves a raised mark before removing the records under it. It outlasts any sync
// request, which the API stops at 25 seconds, so every sync that could still carry a device past one of them has read the
// mark that covers it.
const markSettles = 30 * time.Second

// scanPageItems bounds each page of the cleanup's scan, so no one request takes a large share of a partition's reads.
const scanPageItems = 1000

// MarkDB is the part of DynamoDB that raising a mark uses.
type MarkDB interface {
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

// RaiseMark moves a user's expiry mark up to seq, the sequence number of a record removed as expired. It never moves
// down, so marks from removals read out of order end at the highest. pk is the item's partition key, user#<sub>.
func RaiseMark(ctx context.Context, db MarkDB, table, pk string, seq int64, now time.Time) error {
	_, err := db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(table),
		Key:                       map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: pk}, "sk": &types.AttributeValueMemberS{Value: markKey}},
		UpdateExpression:          aws.String("SET #value = :seq, raised_at = :now"),
		ConditionExpression:       aws.String("attribute_not_exists(#value) OR #value < :seq"),
		ExpressionAttributeNames:  map[string]string{"#value": "value"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":seq": number(seq), ":now": &types.AttributeValueMemberS{Value: now.UTC().Format(time.RFC3339)}},
	})
	var failed *types.ConditionalCheckFailedException
	if err != nil && !errors.As(err, &failed) {
		return fmt.Errorf("sync: mark: %w", err)
	}
	return nil
}

// CleanupDB is the part of DynamoDB the cleanup job uses.
type CleanupDB interface {
	MarkDB
	Scan(context.Context, *dynamodb.ScanInput, ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error)
	DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
}

// Cleanup removes what TTL hasn't reached yet, for staging, whose periods are minutes, and for the local stack, where
// TTL never runs. Prod has no cleanup.
type Cleanup struct {
	DB    CleanupDB
	Table string
	Now   func() time.Time
	Log   *slog.Logger
	Env   string
	// ReadUnitsPerSecond paces the scan, which reads the whole table: after each page it waits until the page's read
	// units fit this budget. A partition serves 3,000 a second, and a small table is one partition, so an unpaced scan
	// throttles and sets off the throttle alarm. Zero doesn't pace, as on the local stack.
	ReadUnitsPerSecond int
	// Wait waits between pages. Nil waits on a timer, and stops early if ctx ends.
	Wait func(ctx context.Context, d time.Duration) error
	// Removing, when set, runs before each record the cleanup removes, with its pk and sk, so what hangs off a record goes
	// with it, as when TTL removes one: an attachment's file. Before, not after: an error stops the run with the record
	// still there, so a later run tries both again.
	Removing func(ctx context.Context, pk, sk string) error
}

// CleanupStats is what one run did, for its log line.
type CleanupStats struct {
	// Users is how many users had a record to remove or a mark to raise.
	Users   int
	Removed int
	// Marked counts the users whose mark went up, so their records go on a later run.
	Marked int
}

// Run makes one pass and logs what it did: counts only.
func (c *Cleanup) Run(ctx context.Context, requestID string) (CleanupStats, error) {
	start := c.Now()
	stats, err := c.pass(ctx, start)
	attrs := []any{"request_id", requestID, "users", stats.Users, "removed", stats.Removed, "marked", stats.Marked,
		"duration_ms", c.Now().Sub(start).Milliseconds()}
	if err != nil {
		attrs = append(append(attrs, "outcome", "failed"), ErrorAttrs(err)...)
	} else {
		attrs = append(attrs, "outcome", "ok")
	}
	c.Log.Info("cleanup_run", append(attrs, obs.Metrics(c.Env, c.Now(), map[string]int{"CleanupRecordsRemoved": stats.Removed})...)...)
	return stats, err
}

type expiring struct {
	mark     int64
	raisedAt time.Time
	// Sort key to sequence number.
	records map[string]int64
}

// pass removes a record in two steps: one run raises the user's mark to cover it, and a run at least markSettles later
// removes it, so no sync can carry a device past a record it hasn't had without resetting it. Each removal is conditional
// on the record's sequence number, so one written again since the scan stays for a later run.
func (c *Cleanup) pass(ctx context.Context, now time.Time) (CleanupStats, error) {
	var stats CleanupStats
	users, err := c.scan(ctx, now)
	if err != nil {
		return stats, err
	}
	for pk, user := range users {
		settled := !now.Before(user.raisedAt.Add(markSettles))
		var above int64
		removed := 0
		for sk, seq := range user.records {
			if seq > user.mark {
				above = max(above, seq)
				continue
			}
			if !settled {
				continue
			}
			if c.Removing != nil {
				if err := c.Removing(ctx, pk, sk); err != nil {
					return stats, err
				}
			}
			ok, err := c.remove(ctx, pk, sk, seq)
			if err != nil {
				return stats, err
			}
			if ok {
				removed++
			}
		}
		if above > 0 {
			if err := RaiseMark(ctx, c.DB, c.Table, pk, above, now); err != nil {
				return stats, err
			}
			stats.Marked++
		}
		if removed > 0 || above > 0 {
			stats.Users++
		}
		stats.Removed += removed
	}
	return stats, nil
}

// scan finds every record past its TTL and every mark, by user. It reads the whole table, a page at a time, paced to the
// read budget.
func (c *Cleanup) scan(ctx context.Context, now time.Time) (map[string]*expiring, error) {
	users := map[string]*expiring{}
	user := func(pk string) *expiring {
		if users[pk] == nil {
			users[pk] = &expiring{records: map[string]int64{}}
		}
		return users[pk]
	}
	var start map[string]types.AttributeValue
	for {
		out, err := c.DB.Scan(ctx, &dynamodb.ScanInput{
			TableName:                aws.String(c.Table),
			ConsistentRead:           aws.Bool(true),
			ExclusiveStartKey:        start,
			Limit:                    aws.Int32(scanPageItems),
			ReturnConsumedCapacity:   types.ReturnConsumedCapacityTotal,
			FilterExpression:         aws.String("sk = :mark OR (begins_with(sk, :rec) AND #expires < :now)"),
			ProjectionExpression:     aws.String("pk, sk, seq, #value, raised_at"),
			ExpressionAttributeNames: map[string]string{"#expires": ttlAttribute, "#value": "value"},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":mark": &types.AttributeValueMemberS{Value: markKey},
				":rec":  &types.AttributeValueMemberS{Value: recordPrefix},
				":now":  number(now.Unix()),
			},
		})
		if err != nil {
			return nil, fmt.Errorf("cleanup: scan: %w", err)
		}
		for _, item := range out.Items {
			pk, _ := item["pk"].(*types.AttributeValueMemberS)
			sk, _ := item["sk"].(*types.AttributeValueMemberS)
			if pk == nil || sk == nil || !strings.HasPrefix(pk.Value, "user#") {
				continue
			}
			if sk.Value == markKey {
				u := user(pk.Value)
				if u.mark, err = numberAttr(item["value"]); err != nil {
					return nil, err
				}
				if at, ok := item["raised_at"].(*types.AttributeValueMemberS); ok {
					u.raisedAt, _ = time.Parse(time.RFC3339, at.Value)
				}
				continue
			}
			seq, err := numberAttr(item["seq"])
			if err != nil {
				return nil, err
			}
			user(pk.Value).records[sk.Value] = seq
		}
		if len(out.LastEvaluatedKey) == 0 {
			return users, nil
		}
		start = out.LastEvaluatedKey
		if err := c.pace(ctx, out.ConsumedCapacity); err != nil {
			return nil, fmt.Errorf("cleanup: scan: %w", err)
		}
	}
}

// pace waits as long as a page's read units take at the budget, before the next page.
func (c *Cleanup) pace(ctx context.Context, used *types.ConsumedCapacity) error {
	if c.ReadUnitsPerSecond <= 0 || used == nil || used.CapacityUnits == nil {
		return nil
	}
	d := time.Duration(*used.CapacityUnits / float64(c.ReadUnitsPerSecond) * float64(time.Second))
	if c.Wait != nil {
		return c.Wait(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// remove deletes a record unless it was written again since the scan, and reports whether it did.
func (c *Cleanup) remove(ctx context.Context, pk, sk string, seq int64) (bool, error) {
	_, err := c.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:                 aws.String(c.Table),
		Key:                       map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: pk}, "sk": &types.AttributeValueMemberS{Value: sk}},
		ConditionExpression:       aws.String("seq = :seq"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":seq": number(seq)},
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("cleanup: delete: %w", err)
	}
	return true, nil
}
