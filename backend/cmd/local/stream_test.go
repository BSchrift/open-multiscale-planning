package main

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	tabletypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/dynamodbstreams"
	streamtypes "github.com/aws/aws-sdk-go-v2/service/dynamodbstreams/types"
)

// fakeStream is one open shard of a table's stream. An iterator names how far into records it reads from, and an
// iterator handed out before expire was called is refused as DynamoDB refuses one older than 15 minutes.
type fakeStream struct {
	records []streamtypes.Record
	// issued counts the iterators handed out; those numbered below valid have expired.
	issued, valid int
	iterators     map[string]fakeIterator
	opened        []dynamodbstreams.GetShardIteratorInput
}

type fakeIterator struct{ serial, at int }

func (f *fakeStream) iterator(at int) *string {
	f.issued++
	name := fmt.Sprintf("iterator-%d", f.issued)
	f.iterators[name] = fakeIterator{serial: f.issued, at: at}
	return aws.String(name)
}

func (f *fakeStream) expire() { f.valid = f.issued + 1 }

func (f *fakeStream) add(sub string) {
	f.records = append(f.records, streamtypes.Record{Dynamodb: &streamtypes.StreamRecord{
		SequenceNumber: aws.String(fmt.Sprint(len(f.records) + 1)),
		Keys: map[string]streamtypes.AttributeValue{
			"pk": &streamtypes.AttributeValueMemberS{Value: "user#" + sub},
			"sk": &streamtypes.AttributeValueMemberS{Value: "rec#time_block#b1"},
		},
	}})
}

func (f *fakeStream) DescribeTable(context.Context, *dynamodb.DescribeTableInput, ...func(*dynamodb.Options)) (*dynamodb.DescribeTableOutput, error) {
	return &dynamodb.DescribeTableOutput{Table: &tabletypes.TableDescription{LatestStreamArn: aws.String("stream")}}, nil
}

func (f *fakeStream) DescribeStream(context.Context, *dynamodbstreams.DescribeStreamInput, ...func(*dynamodbstreams.Options)) (*dynamodbstreams.DescribeStreamOutput, error) {
	return &dynamodbstreams.DescribeStreamOutput{StreamDescription: &streamtypes.StreamDescription{
		Shards: []streamtypes.Shard{{ShardId: aws.String("shard-1")}},
	}}, nil
}

func (f *fakeStream) GetShardIterator(_ context.Context, in *dynamodbstreams.GetShardIteratorInput, _ ...func(*dynamodbstreams.Options)) (*dynamodbstreams.GetShardIteratorOutput, error) {
	f.opened = append(f.opened, *in)
	at := 0
	if in.ShardIteratorType == streamtypes.ShardIteratorTypeAfterSequenceNumber {
		at = slices.IndexFunc(f.records, func(r streamtypes.Record) bool { return *r.Dynamodb.SequenceNumber == aws.ToString(in.SequenceNumber) }) + 1
	}
	return &dynamodbstreams.GetShardIteratorOutput{ShardIterator: f.iterator(at)}, nil
}

func (f *fakeStream) GetRecords(_ context.Context, in *dynamodbstreams.GetRecordsInput, _ ...func(*dynamodbstreams.Options)) (*dynamodbstreams.GetRecordsOutput, error) {
	it := f.iterators[aws.ToString(in.ShardIterator)]
	if it.serial < f.valid {
		return nil, &streamtypes.ExpiredIteratorException{Message: aws.String("Iterator expired")}
	}
	return &dynamodbstreams.GetRecordsOutput{Records: f.records[it.at:], NextShardIterator: f.iterator(len(f.records))}, nil
}

func newFakeReader(f *fakeStream) *streamReader {
	return &streamReader{tables: f, tableName: "table", client: f, iterators: map[string]*string{}, closed: map[string]bool{}, last: map[string]*string{}}
}

// make dev's stack runs for days on a laptop that sleeps. Its next poll after a sleep longer than an iterator lasts
// carries on after the last record it read, rather than failing every tick from then on, which stopped the local
// calendar worker's stream runs, retries and schedule until the stack was started again.
func TestTheStreamCarriesOnAfterTheLastRecordOnceItsIteratorExpires(t *testing.T) {
	stream := &fakeStream{iterators: map[string]fakeIterator{}}
	reader := newFakeReader(stream)
	stream.add("ana")
	woken, err := reader.poll(context.Background())
	if err != nil || !slices.Equal(woken, []string{"ana"}) {
		t.Fatalf("first poll = %v, %v; want [ana]", woken, err)
	}

	stream.expire()
	stream.add("ben")
	woken, err = reader.poll(context.Background())
	if err != nil {
		t.Fatalf("poll after the iterator expired: %v", err)
	}
	if !slices.Equal(woken, []string{"ben"}) {
		t.Fatalf("woken = %v, want [ben]: only what came after the last record read", woken)
	}
	last := stream.opened[len(stream.opened)-1]
	if last.ShardIteratorType != streamtypes.ShardIteratorTypeAfterSequenceNumber || aws.ToString(last.SequenceNumber) != "1" {
		t.Fatalf("reopened with %s after %q, want AFTER_SEQUENCE_NUMBER after 1", last.ShardIteratorType, aws.ToString(last.SequenceNumber))
	}

	stream.add("cleo")
	if woken, err = reader.poll(context.Background()); err != nil || !slices.Equal(woken, []string{"cleo"}) {
		t.Fatalf("next poll = %v, %v; want [cleo]", woken, err)
	}
}

// One that expires before it read anything opens the shard from its start again, as the first poll did.
func TestAnIteratorThatExpiresBeforeAnyRecordReopensFromTheStart(t *testing.T) {
	stream := &fakeStream{iterators: map[string]fakeIterator{}}
	reader := newFakeReader(stream)
	if woken, err := reader.poll(context.Background()); err != nil || len(woken) != 0 {
		t.Fatalf("first poll = %v, %v; want nothing", woken, err)
	}
	stream.expire()
	stream.add("ana")
	woken, err := reader.poll(context.Background())
	if err != nil || !slices.Equal(woken, []string{"ana"}) {
		t.Fatalf("poll after the iterator expired = %v, %v; want [ana]", woken, err)
	}
	if last := stream.opened[len(stream.opened)-1]; last.ShardIteratorType != streamtypes.ShardIteratorTypeTrimHorizon {
		t.Fatalf("reopened with %s, want TRIM_HORIZON", last.ShardIteratorType)
	}
}
