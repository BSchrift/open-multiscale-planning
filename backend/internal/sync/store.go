package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const (
	// maxAttempts bounds tries on the counter race. Past it the device tries again later.
	maxAttempts = 3
	pageSize    = 500
	// All of a user's records share one partition, which writes about 1,000 units a second, and a transactional write
	// costs two per KB, so a transaction far above this is refused however long it waits.
	maxTransactionBytes = 256 << 10
	maxReadTries        = 5
	// maxThrottleWaits waits out the partition's write rate for about 15 seconds when each throttle comes straight back.
	// A throttle the SDK retried first has spent its own backoff too, so throttleBudget also stops the waits. Past
	// either the device tries again later, and what landed stays.
	maxThrottleWaits = 20
)

// ErrConflict means the write couldn't finish now: other writers kept moving the counter through every attempt, or
// DynamoDB kept throttling. Nothing was lost, and what landed stays: merging is idempotent, so the device resends.
var ErrConflict = errors.New("sync: counter kept moving")

// throttleWait is how long to wait before sending a throttled transaction again for the try-th time.
var throttleWait = func(try int) time.Duration { return min(time.Duration(try+1)*100*time.Millisecond, time.Second) }

// throttleBudget is how long one push waits out throttling, to stop inside the API's 25 seconds.
var throttleBudget = 15 * time.Second

// DB is the part of DynamoDB the store uses, so tests can inject what DynamoDB Local never does.
type DB interface {
	BatchGetItem(context.Context, *dynamodb.BatchGetItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error)
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
	Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
}

// Store is the DynamoDB side of sync. Every writer goes through Push, so every write moves the counter.
type Store struct {
	DB    DB
	Table string
}

// Response is the body of a 200 from POST /sync. A cursor below the one sent, or a generation other than the last one
// the device saw, means the table was restored from backup: the device resets to 0 and re-sends every local record.
type Response struct {
	Cursor     int64    `json:"cursor"`
	More       bool     `json:"more"`
	Changes    []Change `json:"changes"`
	Generation string   `json:"generation,omitempty"`
}

// Stats is what a request did, for logs and metrics.
type Stats struct {
	Merged     int
	Retries    int
	Pulled     int
	counter    int64
	generation string
	reset      bool
}

// Sync pushes changes and returns the records above cursor, up to one page.
func (s *Store) Sync(ctx context.Context, sub string, cursor int64, changes []Change) (Response, Stats, error) {
	stats, err := s.Push(ctx, sub, cursor, changes)
	if err != nil {
		return Response{}, stats, err
	}
	if stats.reset {
		return Response{Cursor: stats.counter, Changes: []Change{}, Generation: stats.generation}, stats, nil
	}
	res, err := s.pull(ctx, sub, cursor, stats.counter)
	res.Generation = stats.generation
	stats.Pulled = len(res.Changes)
	return res, stats, err
}

// Push merges changes in and writes what altered, retrying when another writer moves the counter first. A cursor above
// the stored counter writes nothing and marks the result for a reset. Callers with no cursor, such as the calendar
// worker, pass 0.
func (s *Store) Push(ctx context.Context, sub string, cursor int64, changes []Change) (Stats, error) {
	changes = combine(changes)
	var stats Stats
	// One budget across every attempt, so a conflict between throttles doesn't start it again.
	giveUp := time.Now().Add(throttleBudget)
	for attempt := 1; ; attempt++ {
		state, err := s.read(ctx, sub, changes)
		if err != nil {
			return stats, err
		}
		stats.counter, stats.generation = state.counter, state.generation
		if cursor > state.counter {
			stats.reset = true
			return stats, nil
		}
		merged, err := mergeAll(changes, state.records)
		if err != nil {
			return stats, err
		}
		written, counter, err := s.write(ctx, sub, state, merged, giveUp)
		stats.Merged += written
		if err == nil {
			stats.counter = counter
			return stats, nil
		}
		if isThrottled(err) {
			return stats, ErrConflict
		}
		if !isConflict(err) {
			return stats, fmt.Errorf("sync: write: %w", err)
		}
		if attempt == maxAttempts {
			return stats, ErrConflict
		}
		stats.Retries++
	}
}

// combine folds repeats of a record into one change, because neither a batch read nor a transaction takes one item twice.
func combine(changes []Change) []Change {
	byKey := make(map[string]int, len(changes))
	combined := make([]Change, 0, len(changes))
	for _, change := range changes {
		key := recordKey(change.Type, change.ID)
		if i, seen := byKey[key]; seen {
			combined[i].Fields, _ = MergeFields(combined[i].Fields, change.Fields)
			continue
		}
		byKey[key] = len(combined)
		combined = append(combined, change)
	}
	return combined
}

type storedState struct {
	counter    int64
	exists     bool
	generation string
	records    map[string]Fields
}

// read takes the counter before the records. A batch read isn't one snapshot, and the counter is all a write is
// conditional on: read after a record, it could already include a commit that the record's read missed, and the write
// would then overwrite that commit.
func (s *Store) read(ctx context.Context, sub string, changes []Change) (storedState, error) {
	pk := &types.AttributeValueMemberS{Value: userKey(sub)}
	state := storedState{records: map[string]Fields{}}
	counter := []map[string]types.AttributeValue{
		{"pk": pk, "sk": &types.AttributeValueMemberS{Value: counterKey}},
		{"pk": &types.AttributeValueMemberS{Value: generationPK}, "sk": &types.AttributeValueMemberS{Value: generationKey}},
	}
	if err := s.readKeys(ctx, counter, &state); err != nil {
		return state, err
	}
	if len(changes) == 0 {
		return state, nil
	}
	records := make([]map[string]types.AttributeValue, 0, len(changes))
	for _, change := range changes {
		records = append(records, map[string]types.AttributeValue{
			"pk": pk, "sk": &types.AttributeValueMemberS{Value: recordKey(change.Type, change.ID)},
		})
	}
	return state, s.readKeys(ctx, records, &state)
}

func (s *Store) readKeys(ctx context.Context, keys []map[string]types.AttributeValue, state *storedState) error {
	request := map[string]types.KeysAndAttributes{s.Table: {Keys: keys, ConsistentRead: aws.Bool(true)}}
	for try := 0; ; try++ {
		out, err := s.DB.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: request})
		if err != nil {
			return fmt.Errorf("sync: read: %w", err)
		}
		for _, item := range out.Responses[s.Table] {
			sk, _ := item["sk"].(*types.AttributeValueMemberS)
			if sk == nil {
				return errors.New("sync: read: item has no sort key")
			}
			if sk.Value == counterKey {
				if state.counter, err = numberAttr(item["value"]); err != nil {
					return err
				}
				state.exists = true
				continue
			}
			if sk.Value == generationKey {
				generation, ok := item["value"].(*types.AttributeValueMemberS)
				if !ok {
					return errors.New("sync: read: the table's generation is not a string")
				}
				state.generation = generation.Value
				continue
			}
			if state.records[sk.Value], err = fieldsFromItem(item); err != nil {
				return err
			}
		}
		if len(out.UnprocessedKeys) == 0 {
			return nil
		}
		// A key left unread must not count as missing, or its record's other fields would be overwritten.
		if try == maxReadTries {
			return errors.New("sync: read: keys still unprocessed")
		}
		request = out.UnprocessedKeys
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(try+1) * 50 * time.Millisecond):
		}
	}
}

type mergedRecord struct {
	sk     string
	fields Fields
	size   int
}

// mergeAll returns the records that altered. A record that would pass the limit once merged is refused here: it would
// otherwise grow until DynamoDB's item limit fails every later write to it.
func mergeAll(changes []Change, stored map[string]Fields) ([]mergedRecord, error) {
	var merged []mergedRecord
	for _, change := range changes {
		sk := recordKey(change.Type, change.ID)
		fields, altered := MergeFields(stored[sk], change.Fields)
		if altered == 0 {
			continue
		}
		size := recordBytes(fields)
		if size > MaxRecordBytes+mergedRoom {
			return nil, tooLarge("record_too_large")
		}
		merged = append(merged, mergedRecord{sk, fields, size})
	}
	return merged, nil
}

// write commits records in transactions under DynamoDB's size limit. Each one is conditional on the counter, so sequence
// numbers can't appear out of order. If a later one fails, the retry's read finds the earlier ones already merged. It
// stops waiting out throttles at giveUp, and returns how many records it committed and the counter after them.
func (s *Store) write(ctx context.Context, sub string, state storedState, records []mergedRecord, giveUp time.Time) (int, int64, error) {
	counter, exists, written := state.counter, state.exists, 0
	for len(records) > 0 {
		n, bytes := 0, 0
		for n < len(records) && (n == 0 || bytes+records[n].size <= maxTransactionBytes) {
			bytes += records[n].size
			n++
		}
		items := make([]types.TransactWriteItem, 0, n+1)
		next := counter
		for _, record := range records[:n] {
			next++
			item, err := recordItem(s.Table, sub, record, next)
			if err != nil {
				return written, counter, err
			}
			items = append(items, item)
		}
		items = append(items, counterUpdate(s.Table, sub, counter, next, exists))
		for try := 0; ; try++ {
			_, err := s.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
			if err == nil {
				break
			}
			// A throttled transaction wrote nothing, so the same one, with the same counter condition, can go again. One the
			// SDK found still in progress may yet land, but it has that condition too, so at most one of them commits.
			if !isThrottled(err) || try == maxThrottleWaits || time.Now().After(giveUp) {
				return written, counter, err
			}
			select {
			case <-ctx.Done():
				return written, counter, ctx.Err()
			case <-time.After(throttleWait(try)):
			}
		}
		written += n
		counter, exists, records = next, true, records[n:]
	}
	return written, counter, nil
}

func recordItem(table, sub string, record mergedRecord, seq int64) (types.TransactWriteItem, error) {
	fields := make(map[string]types.AttributeValue, len(record.fields))
	for name, field := range record.fields {
		value, err := toAttribute(field.V)
		if err != nil {
			return types.TransactWriteItem{}, err
		}
		fields[name] = &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{
			"v": value,
			"c": &types.AttributeValueMemberS{Value: field.C},
		}}
	}
	return types.TransactWriteItem{Put: &types.Put{
		TableName: aws.String(table),
		Item: map[string]types.AttributeValue{
			"pk":     &types.AttributeValueMemberS{Value: userKey(sub)},
			"sk":     &types.AttributeValueMemberS{Value: record.sk},
			"seq":    number(seq),
			"fields": &types.AttributeValueMemberM{Value: fields},
		},
	}}, nil
}

func counterUpdate(table, sub string, old, next int64, exists bool) types.TransactWriteItem {
	update := &types.Update{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userKey(sub)},
			"sk": &types.AttributeValueMemberS{Value: counterKey},
		},
		UpdateExpression:          aws.String("SET #value = :new"),
		ConditionExpression:       aws.String("attribute_not_exists(#value)"),
		ExpressionAttributeNames:  map[string]string{"#value": "value"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":new": number(next)},
	}
	if exists {
		update.ConditionExpression = aws.String("#value = :old")
		update.ExpressionAttributeValues[":old"] = number(old)
	}
	return types.TransactWriteItem{Update: update}
}

// throttleCodes are the throttles that come back as an exception rather than as a cancelled transaction. The SDK retries
// each of these itself first, and hands the last one back wrapped in its retry error.
var throttleCodes = map[string]bool{
	"ProvisionedThroughputExceededException": true,
	"ThrottlingException":                    true,
	"RequestLimitExceeded":                   true,
	// The SDK resent the request with the same token while its first try was still landing.
	"TransactionInProgressException": true,
}

func isThrottled(err error) bool {
	var canceled *types.TransactionCanceledException
	if errors.As(err, &canceled) {
		return slices.ContainsFunc(canceled.CancellationReasons, func(reason types.CancellationReason) bool {
			code := aws.ToString(reason.Code)
			return code == "ThrottlingError" || code == "ProvisionedThroughputExceeded"
		})
	}
	var coded interface{ ErrorCode() string }
	return errors.As(err, &coded) && throttleCodes[coded.ErrorCode()]
}

// ErrorAttrs names an AWS error for a log line: its code, a cancelled transaction's reason codes in item order, and how
// many tries the SDK made before giving up. Only codes and counts, since a message can quote the request.
func ErrorAttrs(err error) []any {
	var attrs []any
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) {
		attrs = append(attrs, "aws_error", coded.ErrorCode())
	}
	var canceled *types.TransactionCanceledException
	if errors.As(err, &canceled) {
		reasons := make([]string, len(canceled.CancellationReasons))
		for i, reason := range canceled.CancellationReasons {
			reasons[i] = aws.ToString(reason.Code)
		}
		attrs = append(attrs, "cancellation_reasons", reasons)
	}
	var attempts *retry.MaxAttemptsError
	if errors.As(err, &attempts) {
		attrs = append(attrs, "aws_attempts", attempts.Attempt)
	}
	return attrs
}

func isConflict(err error) bool {
	var canceled *types.TransactionCanceledException
	if !errors.As(err, &canceled) {
		return false
	}
	return slices.ContainsFunc(canceled.CancellationReasons, func(reason types.CancellationReason) bool {
		code := aws.ToString(reason.Code)
		return code == "ConditionalCheckFailed" || code == "TransactionConflict"
	})
}

// pull goes no further than a counter read beforehand. A query can show part of a transaction that's landing right now,
// and since a cursor only moves forward, seeing a later record without an earlier one would lose that one for good. A
// transaction the counter already includes has landed whole.
func (s *Store) pull(ctx context.Context, sub string, cursor, counter int64) (Response, error) {
	if cursor >= counter {
		return Response{Cursor: cursor, Changes: []Change{}}, nil
	}
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.Table),
		IndexName:              aws.String("by_seq"),
		ConsistentRead:         aws.Bool(true),
		Limit:                  aws.Int32(pageSize),
		KeyConditionExpression: aws.String("pk = :user AND seq BETWEEN :from AND :to"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":user": &types.AttributeValueMemberS{Value: userKey(sub)},
			":from": number(cursor + 1),
			":to":   number(counter),
		},
	})
	if err != nil {
		return Response{}, fmt.Errorf("sync: pull: %w", err)
	}
	res := Response{Cursor: cursor, More: len(out.LastEvaluatedKey) > 0, Changes: make([]Change, 0, len(out.Items))}
	for _, item := range out.Items {
		sk, _ := item["sk"].(*types.AttributeValueMemberS)
		if sk == nil {
			return Response{}, errors.New("sync: pull: item has no sort key")
		}
		recordType, id, ok := strings.Cut(strings.TrimPrefix(sk.Value, recordPrefix), "#")
		if !ok {
			return Response{}, errors.New("sync: pull: malformed sort key")
		}
		fields, err := fieldsFromItem(item)
		if err != nil {
			return Response{}, err
		}
		if res.Cursor, err = numberAttr(item["seq"]); err != nil {
			return Response{}, err
		}
		res.Changes = append(res.Changes, Change{Type: recordType, ID: id, Fields: fields})
	}
	return res, nil
}

const (
	counterKey   = "meta#counter"
	recordPrefix = "rec#"
	// The table's generation is one item for every user, absent until the first restore from backup. The restore's last
	// step writes a new one, which a counter can't stand in for: other devices may have moved it past an old cursor.
	generationPK  = "meta"
	generationKey = "generation"
)

func userKey(sub string) string { return "user#" + sub }

func recordKey(recordType, id string) string { return recordPrefix + recordType + "#" + id }

func number(n int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(n, 10)}
}

func numberAttr(value types.AttributeValue) (int64, error) {
	n, ok := value.(*types.AttributeValueMemberN)
	if !ok {
		return 0, errors.New("sync: expected a number attribute")
	}
	return strconv.ParseInt(n.Value, 10, 64)
}

// toAttribute maps a JSON value to its native DynamoDB form, keeping numbers in the text they arrived as.
func toAttribute(value any) (types.AttributeValue, error) {
	switch v := value.(type) {
	case nil:
		return &types.AttributeValueMemberNULL{Value: true}, nil
	case bool:
		return &types.AttributeValueMemberBOOL{Value: v}, nil
	case string:
		return &types.AttributeValueMemberS{Value: v}, nil
	case json.Number:
		// DynamoDB refuses a zero spelt with an exponent out of its range, such as 0e999.
		if f, err := strconv.ParseFloat(string(v), 64); err == nil && f == 0 {
			return &types.AttributeValueMemberN{Value: "0"}, nil
		}
		return &types.AttributeValueMemberN{Value: string(v)}, nil
	case []any:
		list := make([]types.AttributeValue, len(v))
		for i, item := range v {
			av, err := toAttribute(item)
			if err != nil {
				return nil, err
			}
			list[i] = av
		}
		return &types.AttributeValueMemberL{Value: list}, nil
	case map[string]any:
		m := make(map[string]types.AttributeValue, len(v))
		for key, item := range v {
			av, err := toAttribute(item)
			if err != nil {
				return nil, err
			}
			m[key] = av
		}
		return &types.AttributeValueMemberM{Value: m}, nil
	}
	return nil, fmt.Errorf("sync: value of unexpected type %T", value)
}

func fromAttribute(value types.AttributeValue) (any, error) {
	switch v := value.(type) {
	case *types.AttributeValueMemberNULL:
		return nil, nil
	case *types.AttributeValueMemberBOOL:
		return v.Value, nil
	case *types.AttributeValueMemberS:
		return v.Value, nil
	case *types.AttributeValueMemberN:
		return json.Number(v.Value), nil
	case *types.AttributeValueMemberL:
		list := make([]any, len(v.Value))
		for i, item := range v.Value {
			decoded, err := fromAttribute(item)
			if err != nil {
				return nil, err
			}
			list[i] = decoded
		}
		return list, nil
	case *types.AttributeValueMemberM:
		m := make(map[string]any, len(v.Value))
		for key, item := range v.Value {
			decoded, err := fromAttribute(item)
			if err != nil {
				return nil, err
			}
			m[key] = decoded
		}
		return m, nil
	}
	return nil, fmt.Errorf("sync: attribute of unexpected type %T", value)
}

func fieldsFromItem(item map[string]types.AttributeValue) (Fields, error) {
	stored, ok := item["fields"].(*types.AttributeValueMemberM)
	if !ok {
		return nil, errors.New("sync: item has no fields")
	}
	fields := make(Fields, len(stored.Value))
	for name, attr := range stored.Value {
		entry, ok := attr.(*types.AttributeValueMemberM)
		if !ok {
			return nil, errors.New("sync: malformed field")
		}
		clock, ok := entry.Value["c"].(*types.AttributeValueMemberS)
		if !ok {
			return nil, errors.New("sync: field has no clock")
		}
		value, err := fromAttribute(entry.Value["v"])
		if err != nil {
			return nil, err
		}
		fields[name] = Field{V: value, C: clock.Value}
	}
	return fields, nil
}

// List returns every record of one type for one user, following pages.
func (s *Store) List(ctx context.Context, sub, recordType string) ([]Change, error) {
	var (
		changes []Change
		start   map[string]types.AttributeValue
	)
	for {
		out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.Table),
			ConsistentRead:         aws.Bool(true),
			ExclusiveStartKey:      start,
			KeyConditionExpression: aws.String("pk = :user AND begins_with(sk, :prefix)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":user":   &types.AttributeValueMemberS{Value: userKey(sub)},
				":prefix": &types.AttributeValueMemberS{Value: recordKey(recordType, "")},
			},
		})
		if err != nil {
			return nil, fmt.Errorf("sync: list: %w", err)
		}
		for _, item := range out.Items {
			sk, _ := item["sk"].(*types.AttributeValueMemberS)
			if sk == nil {
				return nil, errors.New("sync: list: item has no sort key")
			}
			fields, err := fieldsFromItem(item)
			if err != nil {
				return nil, err
			}
			changes = append(changes, Change{Type: recordType, ID: strings.TrimPrefix(sk.Value, recordKey(recordType, "")), Fields: fields})
		}
		if len(out.LastEvaluatedKey) == 0 {
			return changes, nil
		}
		start = out.LastEvaluatedKey
	}
}
