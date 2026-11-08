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

	"github.com/BSchrift/open-multiscale-planning/config"
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
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

// Store is the DynamoDB side of sync. Every writer goes through Push, so every write moves the counter.
type Store struct {
	DB    DB
	Table string
	// Expiry keeps expired records out of pulls and changes to them out of the table, as docs/retention.md says. Without
	// it nothing is left out, as in the tests of everything else.
	Expiry *Expiry
}

// Expiry is what the store needs to tell what has expired: the time, and how long a deleted record is kept.
type Expiry struct {
	Now     func() time.Time
	Deleted config.Period
}

// Response is the body of a 200 from POST /sync. A cursor below the one sent, or a generation other than the last one
// the device saw, means the table was restored from backup: the device resets to 0 and re-sends every local record.
type Response struct {
	Cursor     int64    `json:"cursor"`
	More       bool     `json:"more"`
	Changes    []Change `json:"changes"`
	Generation string   `json:"generation,omitempty"`
	// Reset is ResetExpired when records the device hasn't seen were removed as expired. It answers only a request with
	// expiry_reset, and nothing was merged.
	Reset string `json:"reset,omitempty"`
}

// ResetExpired tells a device to pull everything from 0, keep only what comes back or what it made since it last synced,
// and then send its changes again.
const ResetExpired = "expired"

// Stats is what a request did, for logs and metrics.
type Stats struct {
	Merged int
	// Dropped counts changes left out because they'd bring back an expired record.
	Dropped int
	// Filled counts expiries filled in on records that had none, without a new sequence number.
	Filled int
	// Skipped counts expired records a pull left out.
	Skipped    int
	Retries    int
	Pulled     int
	counter    int64
	generation string
	reset      bool

	// ItemCollectionGB is the most DynamoDB estimated the user's records to take after this request's writes, the upper
	// end of its range, or 0 when it wrote nothing or DynamoDB reported no size. The by_seq index caps them at 10 GB.
	ItemCollectionGB float64
	// ExpiryReset is set when the device was behind the expiry mark and was answered with a reset.
	ExpiryReset bool
}

// pusher is who a push comes from, which decides the expiry checks it gets.
type pusher int

const (
	// server is the backend's own writer, the calendar worker.
	server pusher = iota
	// oldDevice is an app from before retention, which never asks for a reset.
	oldDevice
	// device is an app that takes a reset when it's behind the expiry mark.
	device
)

// Sync pushes changes and returns the records above cursor, up to one page.
func (s *Store) Sync(ctx context.Context, sub string, req Request) (Response, Stats, error) {
	who := oldDevice
	if req.ExpiryReset {
		who = device
	}
	stats, err := s.push(ctx, sub, req.Cursor, req.Changes, who)
	if err != nil {
		return Response{}, stats, err
	}
	if stats.reset {
		return Response{Cursor: stats.counter, Changes: []Change{}, Generation: stats.generation}, stats, nil
	}
	reset := Response{Changes: []Change{}, Generation: stats.generation, Reset: ResetExpired}
	if stats.ExpiryReset {
		return reset, stats, nil
	}
	res, skipped, err := s.pull(ctx, sub, req.Cursor, stats.counter)
	if err != nil {
		return Response{}, stats, err
	}
	res.Generation = stats.generation
	stats.Pulled, stats.Skipped = len(res.Changes), skipped
	// The pull left out an expired record whose last write this device hasn't had, so it may hold an older copy: it pulls
	// everything instead, which leaves the copy out. What it sent merged, and sending it again changes nothing.
	if who == device && skipped > 0 && holdsRecords(req.Cursor, req.Changes) {
		stats.ExpiryReset, stats.Pulled = true, 0
		return reset, stats, nil
	}
	return res, stats, nil
}

// holdsRecords is false only for a device that holds nothing yet: at 0, with nothing to send.
func holdsRecords(cursor int64, changes []Change) bool { return cursor > 0 || len(changes) > 0 }

// Push merges changes in and writes what altered, retrying when another writer moves the counter first. A cursor above
// the stored counter writes nothing and marks the result for a reset. Callers with no cursor, such as the calendar
// worker, pass 0.
func (s *Store) Push(ctx context.Context, sub string, cursor int64, changes []Change) (Stats, error) {
	return s.push(ctx, sub, cursor, changes, server)
}

func (s *Store) push(ctx context.Context, sub string, cursor int64, changes []Change, who pusher) (Stats, error) {
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
		// A device that hasn't seen every record removed as expired may hold an older copy of one, which its changes would
		// bring back in part. It pulls everything instead.
		if who == device && cursor < state.mark && holdsRecords(cursor, changes) {
			stats.ExpiryReset = true
			return stats, nil
		}
		fills, rest, orphans := s.fills(changes, state)
		for _, f := range fills {
			filled, err := s.fill(ctx, sub, f, state.seqs[f.sk])
			if err != nil {
				return stats, err
			}
			if filled {
				stats.Filled++
			}
		}
		merged, dropped, err := s.mergeAll(rest, state.records, who)
		if err != nil {
			return stats, err
		}
		stats.Dropped = dropped + orphans
		written, counter, size, err := s.write(ctx, sub, state, merged, giveUp)
		stats.Merged += written
		stats.ItemCollectionGB = max(stats.ItemCollectionGB, size)
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
	// mark is the highest sequence number removed as expired, or about to be by staging's cleanup.
	mark    int64
	records map[string]Fields
	seqs    map[string]int64
}

// read takes the counter before the records. A batch read isn't one snapshot, and the counter is all a write is
// conditional on: read after a record, it could already include a commit that the record's read missed, and the write
// would then overwrite that commit.
func (s *Store) read(ctx context.Context, sub string, changes []Change) (storedState, error) {
	pk := &types.AttributeValueMemberS{Value: userKey(sub)}
	state := storedState{records: map[string]Fields{}, seqs: map[string]int64{}}
	counter := []map[string]types.AttributeValue{
		{"pk": pk, "sk": &types.AttributeValueMemberS{Value: counterKey}},
		{"pk": pk, "sk": &types.AttributeValueMemberS{Value: markKey}},
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
			if sk.Value == markKey {
				if state.mark, err = numberAttr(item["value"]); err != nil {
					return err
				}
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
			if state.seqs[sk.Value], err = numberAttr(item["seq"]); err != nil {
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
	// expires is when DynamoDB's TTL may remove the item, or zero for never.
	expires time.Time
}

// mergeAll returns the records that altered, leaving out the changes stale reports for who sent them, and how many it
// left out. A record that would pass the limit once merged is refused here: it would otherwise grow until DynamoDB's item
// limit fails every later write to it.
func (s *Store) mergeAll(changes []Change, stored map[string]Fields, who pusher) ([]mergedRecord, int, error) {
	var merged []mergedRecord
	dropped := 0
	stale := s.stale(who)
	for _, change := range changes {
		sk := recordKey(change.Type, change.ID)
		current, held := stored[sk]
		fields, altered := MergeFields(current, change.Fields)
		if altered == 0 {
			continue
		}
		if stale != nil && stale(held, change.Fields, fields) {
			dropped++
			continue
		}
		if s.Expiry != nil && who != device {
			clearOvertakenExpiry(change.Fields, fields)
		}
		size := recordBytes(fields)
		if size > MaxRecordBytes+mergedRoom {
			return nil, 0, tooLarge("record_too_large")
		}
		expires, _ := s.expiry(fields)
		merged = append(merged, mergedRecord{sk, fields, size, expires})
	}
	return merged, dropped, nil
}

// expiry is when a record expires: its expires_at, which the app works out, or else, for a record deleted by an app
// from before that or by the calendar worker, its deleted_at plus the deleted period.
func (s *Store) expiry(fields Fields) (time.Time, bool) {
	if at, ok := instantField(fields, "expires_at"); ok {
		return at, true
	}
	if s.Expiry != nil {
		if at, ok := instantField(fields, "deleted_at"); ok {
			return s.Expiry.Deleted.After(at), true
		}
	}
	return time.Time{}, false
}

// expirySources are the fields an expiry counts from, as frontend/src/core/expiry.ts lists them.
var expirySources = []string{"deleted_at", "done_at", "cancelled_at", "state", "end", "week_start", "answered_at", "project_id"}

// clearOvertakenExpiry empties a record's expiry once a writer that doesn't work expiries out, an app from before
// retention or the calendar worker, has changed what it counts from since it was set, as when one reopens a task or
// restores a deleted record. The old expiry would otherwise remove the record early. A deleted record then goes by its
// deleted_at, and the next up-to-date app to launch works the expiry out again.
func clearOvertakenExpiry(change, merged Fields) {
	expires, ok := merged["expires_at"]
	if !ok || expires.V == nil {
		return
	}
	latest := expires.C
	for _, name := range expirySources {
		if _, sent := change[name]; sent && merged[name].C > latest {
			latest = merged[name].C
		}
	}
	if latest != expires.C {
		merged["expires_at"] = Field{V: nil, C: latest}
	}
}

func instantField(fields Fields, name string) (time.Time, bool) {
	value, _ := fields[name].V.(string)
	at, err := time.Parse(time.RFC3339, value)
	return at, err == nil
}

// fillChange only fills in a record's expiry with the lowest clock, as each app does once for what it held before
// records had one.
type fillChange struct {
	sk    string
	field Field
}

// fills sets apart the changes that fill in an expiry the stored record lacks. They're written in place, keeping the
// record's sequence number: every device fills it in the same way, so none needs to pull the record again. That also
// lets an expiry that has already passed reach a record from before, so TTL removes it. An expiry alone for a record
// that isn't here can only be for one already removed, so those are left out and counted.
func (s *Store) fills(changes []Change, state storedState) ([]fillChange, []Change, int) {
	var fills []fillChange
	rest, orphans := changes[:0:0], 0
	for _, change := range changes {
		sk := recordKey(change.Type, change.ID)
		field, onlyExpiry := change.Fields["expires_at"]
		onlyExpiry = onlyExpiry && len(change.Fields) == 1 && s.Expiry != nil
		stored, held := state.records[sk]
		_, has := stored["expires_at"]
		switch {
		case onlyExpiry && !held:
			orphans++
		case onlyExpiry && !has && strings.HasPrefix(field.C, "0000000000000-"):
			fills = append(fills, fillChange{sk, field})
		default:
			rest = append(rest, change)
		}
	}
	return fills, rest, orphans
}

// fill writes one fill unless the record changed since it was read, and reports whether it did.
func (s *Store) fill(ctx context.Context, sub string, f fillChange, seq int64) (bool, error) {
	value, err := toAttribute(f.field.V)
	if err != nil {
		return false, err
	}
	update := "SET #fields.#expires = :field"
	values := map[string]types.AttributeValue{
		":field": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{"v": value, "c": &types.AttributeValueMemberS{Value: f.field.C}}},
		":seq":   number(seq),
	}
	if at, ok := instantField(Fields{"expires_at": f.field}, "expires_at"); ok {
		update += ", #expires = :ttl"
		values[":ttl"] = number(at.Unix())
	}
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: userKey(sub)}, "sk": &types.AttributeValueMemberS{Value: f.sk}},
		UpdateExpression:          aws.String(update),
		ConditionExpression:       aws.String("seq = :seq AND attribute_not_exists(#fields.#expires)"),
		ExpressionAttributeNames:  map[string]string{"#fields": "fields", "#expires": ttlAttribute},
		ExpressionAttributeValues: values,
	})
	var failed *types.ConditionalCheckFailedException
	if errors.As(err, &failed) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("sync: fill: %w", err)
	}
	return true, nil
}

// stale reports a change that would bring back an expired record, so Push leaves it out. That's any change whose record,
// once merged, has an expiry that has passed. From an app that can't take a reset it's also one for a record this store
// doesn't hold whose every clock is older than the deleted period: only a device that missed the record's removal still
// sends that. Nil without Expiry.
func (s *Store) stale(who pusher) func(held bool, change, merged Fields) bool {
	if s.Expiry == nil {
		return nil
	}
	now := s.Expiry.Now()
	before := s.Expiry.Deleted.Before(now).UnixMilli()
	return func(held bool, change, merged Fields) bool {
		if at, ok := s.expiry(merged); ok && at.Before(now) {
			return true
		}
		if held || who != oldDevice {
			return false
		}
		for _, field := range change {
			if wall, err := strconv.ParseInt(field.C[:13], 10, 64); err != nil || wall >= before {
				return false
			}
		}
		return true
	}
}

// write commits records in transactions under DynamoDB's size limit. Each one is conditional on the counter, so sequence
// numbers can't appear out of order. If a later one fails, the retry's read finds the earlier ones already merged. It
// stops waiting out throttles at giveUp, and returns how many records it committed, the counter after them, and the
// largest size DynamoDB reported for the user's records.
func (s *Store) write(ctx context.Context, sub string, state storedState, records []mergedRecord, giveUp time.Time) (int, int64, float64, error) {
	counter, exists, written, size := state.counter, state.exists, 0, 0.0
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
				return written, counter, size, err
			}
			items = append(items, item)
		}
		items = append(items, counterUpdate(s.Table, sub, counter, next, exists))
		for try := 0; ; try++ {
			out, err := s.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
				TransactItems:               items,
				ReturnItemCollectionMetrics: types.ReturnItemCollectionMetricsSize,
			})
			if err == nil {
				size = max(size, collectionGB(out, s.Table))
				break
			}
			// A throttled transaction wrote nothing, so the same one, with the same counter condition, can go again. One the
			// SDK found still in progress may yet land, but it has that condition too, so at most one of them commits.
			if !isThrottled(err) || try == maxThrottleWaits || time.Now().After(giveUp) {
				return written, counter, size, err
			}
			select {
			case <-ctx.Done():
				return written, counter, size, ctx.Err()
			case <-time.After(throttleWait(try)):
			}
		}
		written += n
		counter, exists, records = next, true, records[n:]
	}
	return written, counter, size, nil
}

// collectionGB is the upper end of DynamoDB's estimate of the user's item collection, their records and the by_seq
// index's copies of them, or 0 when it sent none.
func collectionGB(out *dynamodb.TransactWriteItemsOutput, table string) float64 {
	gb := 0.0
	if out == nil {
		return gb
	}
	for _, metrics := range out.ItemCollectionMetrics[table] {
		if bounds := metrics.SizeEstimateRangeGB; len(bounds) > 0 {
			gb = max(gb, bounds[len(bounds)-1])
		}
	}
	return gb
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
	item := map[string]types.AttributeValue{
		"pk":     &types.AttributeValueMemberS{Value: userKey(sub)},
		"sk":     &types.AttributeValueMemberS{Value: record.sk},
		"seq":    number(seq),
		"fields": &types.AttributeValueMemberM{Value: fields},
	}
	// The table's TTL attribute, so DynamoDB removes the item once it has expired. A put replaces the item, so a cleared
	// expiry takes the attribute away.
	if !record.expires.IsZero() {
		item[ttlAttribute] = number(record.expires.Unix())
	}
	return types.TransactWriteItem{Put: &types.Put{TableName: aws.String(table), Item: item}}, nil
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
// It leaves out records that have expired but that DynamoDB hasn't removed yet, which can take days, and returns how
// many. The cursor still moves past them.
func (s *Store) pull(ctx context.Context, sub string, cursor, counter int64) (Response, int, error) {
	if cursor >= counter {
		return Response{Cursor: cursor, Changes: []Change{}}, 0, nil
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
		return Response{}, 0, fmt.Errorf("sync: pull: %w", err)
	}
	var now int64
	if s.Expiry != nil {
		now = s.Expiry.Now().Unix()
	}
	skipped := 0
	res := Response{Cursor: cursor, More: len(out.LastEvaluatedKey) > 0, Changes: make([]Change, 0, len(out.Items))}
	for _, item := range out.Items {
		sk, _ := item["sk"].(*types.AttributeValueMemberS)
		if sk == nil {
			return Response{}, 0, errors.New("sync: pull: item has no sort key")
		}
		recordType, id, ok := strings.Cut(strings.TrimPrefix(sk.Value, recordPrefix), "#")
		if !ok {
			return Response{}, 0, errors.New("sync: pull: malformed sort key")
		}
		if res.Cursor, err = numberAttr(item["seq"]); err != nil {
			return Response{}, 0, err
		}
		if expires, err := numberAttr(item[ttlAttribute]); s.Expiry != nil && err == nil && expires < now {
			skipped++
			continue
		}
		fields, err := fieldsFromItem(item)
		if err != nil {
			return Response{}, 0, err
		}
		res.Changes = append(res.Changes, Change{Type: recordType, ID: id, Fields: fields})
	}
	// The last page has read everything up to the counter. A record removed as expired leaves a gap that can sit above
	// the last one read, and a cursor left below it would be behind the mark for good.
	if !res.More {
		res.Cursor = counter
	}
	return res, skipped, nil
}

const (
	counterKey = "meta#counter"
	// markKey holds a user's expiry mark, the highest sequence number removed as expired, and when it was last raised.
	markKey = "meta#expired"
	// ttlAttribute is the table's TTL attribute: when the item expires, in epoch seconds.
	ttlAttribute = "expires_at"
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
