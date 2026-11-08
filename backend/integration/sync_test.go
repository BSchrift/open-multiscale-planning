package integration

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	stdsync "sync"
	"testing"
	"time"
)

func valueOf(t *testing.T, r record, name string) any {
	t.Helper()
	f, ok := r.Fields[name]
	if !ok {
		t.Fatalf("%s has no field %s: %+v", r.ID, name, r.Fields)
	}
	return f.V
}

func TestSmokeSyncPushAndPull(t *testing.T) {
	needs(t)
	writer := signIn(t)
	start := writer.startCursor()
	id := fresh("task")
	res := writer.sync(start, writer.record("task", id, "title", "Write the report", "minutes", 30))
	if res.Cursor <= start {
		t.Fatalf("the cursor stayed at %d", res.Cursor)
	}
	got, ok := find(res.Changes, "task", id)
	if !ok {
		t.Fatalf("a device gets its own write back: %+v", res)
	}
	if valueOf(t, got, "title") != "Write the report" || valueOf(t, got, "minutes") != json.Number("30") {
		t.Fatalf("%+v", got)
	}
	// Another device starts from before the write and sees it. It is the same user, so it shares the record's history.
	all, end := writer.pullAll(start)
	if _, ok := find(all, "task", id); !ok || end != res.Cursor {
		t.Fatalf("end %d, cursor %d: %+v", end, res.Cursor, all)
	}
	if again := writer.sync(end); len(again.Changes) != 0 || again.Cursor != end || again.More {
		t.Fatalf("nothing new should come back: %+v", again)
	}
}

func TestEveryRecordTypeRoundTrips(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	var changes []record
	// The last is a type no app has yet: an app that adds one can be released before the server.
	for _, recordType := range []string{"objective", "project", "slip_entry", "milestone", "task", "task_completion", "time_block", "block_outcome",
		"week_plan", "week_pick", "away_period", "settings", "calendar", "calendar_source", "practice", "a_type_no_app_has_yet"} {
		changes = append(changes, a.record(recordType, fresh("r"), "note", recordType))
	}
	a.sync(start, changes...)
	all, _ := a.pullAll(start)
	for _, want := range changes {
		got, ok := find(all, want.Type, want.ID)
		if !ok || valueOf(t, got, "note") != want.Type {
			t.Errorf("%s: %+v", want.Type, got)
		}
	}
}

func TestValuesRoundTripExactly(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	id := fresh("values")
	raw := map[string]string{
		"text": `"Paint the fence"`, "empty_text": `""`, "unicode": `"Café é 日本語 🎨"`, "quotes": `"a\"b\\c\n"`,
		"yes": `true`, "no": `false`, "nothing": `null`, "zero": `0`, "negative": `-12`, "fraction": `0.25`,
		"big": `9007199254740993`, "longest": `12345678901234567890123456789012345678`, "tiny": `1e-130`, "huge": `1e125`,
		"list": `[1,"two",null,[3]]`, "empty_list": `[]`, "object": `{"a":{"b":[true]}}`, "empty_object": `{}`,
		"deep": nested(25),
	}
	clock := a.clock()
	var parts []string
	for name, value := range raw {
		parts = append(parts, fmt.Sprintf(`%q:{"v":%s,"c":%q}`, name, value, clock))
	}
	body := fmt.Sprintf(`{"cursor":%d,"changes":[{"type":"task","id":%q,"fields":{%s}}]}`, start, id, strings.Join(parts, ","))
	a.pushed[[2]string{"task", id}] = true
	if res := a.sendRaw([]byte(body)); res.status != 200 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	got, ok := a.get("task", id)
	if !ok {
		t.Fatal("not pulled")
	}
	for name, value := range raw {
		want := decodeNumbers(t, value)
		if have := valueOf(t, got, name); !sameValue(have, want) {
			t.Errorf("%s: got %#v, want %#v", name, have, want)
		}
		if got.Fields[name].C != clock {
			t.Errorf("%s: clock %s", name, got.Fields[name].C)
		}
	}
}

// DynamoDB normalises how a number is spelt, so numbers compare by value. Above 15 digits a float would blur them, so
// those must come back exactly as text.
func sameValue(a, b any) bool {
	an, aok := a.(json.Number)
	bn, bok := b.(json.Number)
	if aok && bok {
		if an == bn {
			return true
		}
		af, _ := strconv.ParseFloat(string(an), 64)
		bf, _ := strconv.ParseFloat(string(bn), 64)
		return af == bf && len(strings.TrimLeft(string(bn), "-")) < 16
	}
	return reflect.DeepEqual(a, b)
}

func decodeNumbers(t *testing.T, raw string) any {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var out any
	if err := decoder.Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestUnusualNumbersAreStoredOrRefusedButNeverFail(t *testing.T) {
	needs(t)
	a := signIn(t)
	for _, number := range []string{"0e999", "0e-999", "-0", "0.0", "1E5", "1e+5", "1.50", "100000000000000000000000000000000000000e-1", "1e125", "9.99e125"} {
		id := fresh("number")
		a.pushed[[2]string{"task", id}] = true
		res := a.sendRaw([]byte(changeBody("task", id, titled(number))))
		if res.status != 200 && res.errorCode() != "invalid_value" {
			t.Errorf("%s: %d %s", number, res.status, truncated(res.body))
		}
	}
}

func TestIdsMayHoldTheKeySeparator(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	id := fresh("with#hash#inside")
	a.sync(start, a.record("task", id, "title", "Write the report"))
	all, _ := a.pullAll(start)
	if _, ok := find(all, "task", id); !ok {
		t.Fatalf("%+v", all)
	}
}

func TestPagingReturnsEverythingOnceInOrder(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	want := map[string]bool{}
	for batch := 0; batch < 6; batch++ {
		var changes []record
		for i := 0; i < 99; i++ {
			id := fresh("page")
			want[id] = true
			changes = append(changes, a.record("task", id, "n", i))
		}
		a.sync(a.startCursor(), changes...)
	}
	first := a.sync(start)
	if !first.More || len(first.Changes) != 500 {
		t.Fatalf("first page: more %v with %d changes", first.More, len(first.Changes))
	}
	if first.Cursor <= start {
		t.Fatalf("cursor %d", first.Cursor)
	}
	all, end := a.pullAll(start)
	seen := map[string]bool{}
	for _, r := range all {
		if seen[r.ID] {
			t.Fatalf("%s came twice", r.ID)
		}
		seen[r.ID] = true
	}
	for id := range want {
		if !seen[id] {
			t.Fatalf("%s never came", id)
		}
	}
	if end != a.startCursor() {
		t.Fatalf("ended at %d, counter %d", end, a.startCursor())
	}
}

// DynamoDB stops a query at 1 MB whatever the limit, and a transaction at 4 MB.
func TestLargeRecordsSplitAndPage(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	text := strings.Repeat("x", 90*1024)
	var changes []record
	want := map[string]bool{}
	for i := 0; i < 50; i++ {
		id := fresh("large")
		want[id] = true
		changes = append(changes, a.record("task", id, "body", text))
	}
	res := a.sync(start, changes...)
	if !res.More || len(res.Changes) >= 50 {
		t.Fatalf("expected a short page: more %v, %d changes", res.More, len(res.Changes))
	}
	all, _ := a.pullAll(start)
	for _, r := range all {
		delete(want, r.ID)
	}
	if len(want) != 0 {
		t.Fatalf("%d records never came", len(want))
	}
}

func TestLatestWriteMovesARecordToTheEnd(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	first, second := fresh("first"), fresh("second")
	a.sync(start, a.record("task", first, "title", "one"))
	a.sync(a.startCursor(), a.record("task", second, "title", "two"))
	a.sync(a.startCursor(), a.record("task", first, "title", "three"))
	all, _ := a.pullAll(start)
	var order []string
	for _, r := range all {
		order = append(order, r.ID)
	}
	if !reflect.DeepEqual(order, []string{second, first}) {
		t.Fatalf("%v", order)
	}
}

func TestMergeKeepsTheNewestWriteOfEachField(t *testing.T) {
	needs(t)
	a := signIn(t)
	id := fresh("merge")
	wall := time.Now().Add(-time.Hour)
	at := func(minutes int, device string) string {
		return clockAt(wall.Add(time.Duration(minutes)*time.Minute), 0, device)
	}
	push := func(fields map[string]field) { a.sync(a.startCursor(), record{"task", id, fields}) }

	push(map[string]field{"title": {"first", at(10, "one")}, "minutes": {10, at(10, "one")}})
	// Offline devices arrive late and out of order: each field keeps its own newest.
	push(map[string]field{"title": {"older", at(5, "two")}, "minutes": {20, at(20, "two")}})
	push(map[string]field{"note": {"added", at(1, "three")}})
	got, _ := a.get("task", id)
	if valueOf(t, got, "title") != "first" || valueOf(t, got, "minutes") != json.Number("20") || valueOf(t, got, "note") != "added" {
		t.Fatalf("%+v", got)
	}
	if got.Fields["title"].C != at(10, "one") || got.Fields["minutes"].C != at(20, "two") {
		t.Fatalf("clocks: %+v", got.Fields)
	}
}

func TestTiesBreakTheSameWayEveryWhere(t *testing.T) {
	needs(t)
	a := signIn(t)
	wall := time.Now().Add(-time.Hour)
	cases := []struct {
		name         string
		lower, upper string
	}{
		{"device id", clockAt(wall, 3, "device-a"), clockAt(wall, 3, "device-b")},
		{"device id is bytes", clockAt(wall, 3, "device-B"), clockAt(wall, 3, "device-a")},
		{"counter beats device", clockAt(wall, 3, "device-z"), clockAt(wall, 4, "device-a")},
		{"wall beats counter", clockAt(wall, 999999, "device-z"), clockAt(wall.Add(time.Millisecond), 0, "device-a")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for _, order := range [][2]string{{c.lower, c.upper}, {c.upper, c.lower}} {
				id := fresh("tie")
				for _, clock := range order {
					a.sync(a.startCursor(), record{"task", id, map[string]field{"title": {clock, clock}}})
				}
				got, _ := a.get("task", id)
				if valueOf(t, got, "title") != c.upper {
					t.Fatalf("order %v kept %v", order, valueOf(t, got, "title"))
				}
			}
		})
	}
}

// The same cases the client's merge is tested against, here through the running API. They're written at a fixed time,
// so each clock moves to the recent past with their order unchanged.
func TestSharedMergeCases(t *testing.T) {
	needs(t)
	files, err := filepath.Glob("../testdata/merge/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no cases: %v", err)
	}
	a := signIn(t)
	base := time.Now().Add(-time.Hour).UnixMilli()
	shift := func(clock string) string {
		wall, err := strconv.ParseInt(clock[:13], 10, 64)
		if err != nil {
			t.Fatalf("clock %q", clock)
		}
		return fmt.Sprintf("%013d%s", wall-1800000000000+base, clock[13:])
	}
	moved := func(fields map[string]field) map[string]field {
		out := make(map[string]field, len(fields))
		for name, f := range fields {
			out[name] = field{f.V, shift(f.C)}
		}
		return out
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var c struct {
			Name     string             `json:"name"`
			Current  map[string]field   `json:"current"`
			Incoming []map[string]field `json:"incoming"`
			Expected map[string]field   `json:"expected"`
		}
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.UseNumber()
		if err := decoder.Decode(&c); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		t.Run(c.Name, func(t *testing.T) {
			id := fresh("case")
			if len(c.Current) > 0 {
				a.sync(a.startCursor(), record{"task", id, moved(c.Current)})
			}
			for _, incoming := range c.Incoming {
				a.sync(a.startCursor(), record{"task", id, moved(incoming)})
			}
			got, _ := a.get("task", id)
			want := moved(c.Expected)
			if len(got.Fields) != len(want) {
				t.Fatalf("got %+v, want %+v", got.Fields, want)
			}
			for name, f := range want {
				have := got.Fields[name]
				if have.C != f.C || !sameDeep(have.V, f.V) {
					t.Errorf("%s: got %+v, want %+v", name, have, f)
				}
			}
		})
	}
}

func sameDeep(a, b any) bool {
	switch av := a.(type) {
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !sameDeep(av[i], bv[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for key := range av {
			if !sameDeep(av[key], bv[key]) {
				return false
			}
		}
		return true
	}
	return sameValue(a, b)
}

func TestResendingChangesNothing(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	change := a.record("task", fresh("resend"), "title", "Write the report")
	first := a.sync(start, change)
	again := a.sync(first.Cursor, change)
	if len(again.Changes) != 0 || again.Cursor != first.Cursor {
		t.Fatalf("a resend wrote: %+v", again)
	}
	got, _ := a.get(change.Type, change.ID)
	if !reflect.DeepEqual(got.Fields["title"].C, change.Fields["title"].C) {
		t.Fatalf("%+v", got)
	}
}

func TestOneRecordTwiceInARequestFolds(t *testing.T) {
	needs(t)
	a := signIn(t)
	id := fresh("twice")
	older, newer := a.clock(), a.clock()
	a.sync(a.startCursor(),
		record{"task", id, map[string]field{"title": {"newer", newer}}},
		record{"task", id, map[string]field{"title": {"older", older}, "note": {"kept", older}}},
	)
	got, _ := a.get("task", id)
	if valueOf(t, got, "title") != "newer" || valueOf(t, got, "note") != "kept" {
		t.Fatalf("%+v", got)
	}
}

func TestLargestAllowedBatchAndRecord(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	var changes []record
	for i := 0; i < 99; i++ {
		changes = append(changes, a.record("task", fresh("full"), "n", i))
	}
	a.sync(start, changes...)
	all, _ := a.pullAll(start)
	if len(all) != 99 {
		t.Fatalf("%d", len(all))
	}
	// As near the limit as JSON allows, with the shape that costs DynamoDB most per byte of JSON.
	id := fresh("limit")
	clock := a.clock()
	overhead := len(fmt.Sprintf(`{"list":{"v":[],"c":%q}}`, clock))
	items := (100*1024 - overhead + 1) / 3
	body := fmt.Sprintf(`{"cursor":0,"changes":[{"type":"task","id":%q,"fields":{"list":{"v":[%s],"c":%q}}}]}`,
		id, strings.TrimSuffix(strings.Repeat("[],", items), ","), clock)
	a.pushed[[2]string{"task", id}] = true
	if res := a.sendRaw([]byte(body)); res.status != 200 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
}

// A record can't grow past the limit by merging, or every later write to it would fail.
func TestMergedRecordMustFitToo(t *testing.T) {
	needs(t)
	a := signIn(t)
	id := fresh("grow")
	text := strings.Repeat("x", 60*1024)
	a.sync(a.startCursor(), a.record("task", id, "one", text))
	before := a.startCursor()
	res := a.send(before, a.record("task", id, "two", text))
	if res.status != 413 || res.errorCode() != "record_too_large" {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	if a.startCursor() != before {
		t.Fatal("the refused write moved the counter")
	}
	got, _ := a.get("task", id)
	if _, ok := got.Fields["two"]; ok {
		t.Fatal("the refused field was stored")
	}
	a.sync(a.startCursor(), a.record("task", id, "one", "short"))
	a.sync(a.startCursor(), a.record("task", id, "two", text))
}

// Deleting adds a field, and a delete that's refused would sit in a device's outbox for ever.
func TestARecordAtTheLimitCanStillBeDeleted(t *testing.T) {
	needs(t)
	a := signIn(t)
	id := fresh("full")
	clock := a.clock()
	overhead := len(fmt.Sprintf(`{"body":{"v":"","c":%q}}`, clock))
	body := fmt.Sprintf(`{"cursor":0,"changes":[{"type":"task","id":%q,"fields":{"body":{"v":"%s","c":%q}}}]}`, id, strings.Repeat("x", 100*1024-overhead), clock)
	a.pushed[[2]string{"task", id}] = true
	if res := a.sendRaw([]byte(body)); res.status != 200 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	stamp := time.Now().UTC().Format(time.RFC3339)
	a.sync(a.startCursor(), a.record("task", id, "deleted_at", stamp))
	got, _ := a.get("task", id)
	if valueOf(t, got, "deleted_at") != stamp {
		t.Fatalf("%+v", got.Fields["deleted_at"])
	}
	// It can't then keep growing by small steps, past the room left for that.
	big := strings.Repeat("y", 2048)
	if res := a.send(a.startCursor(), a.record("task", id, "note", big)); res.status != 413 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
}

// A refused record in a batch refuses all of it, so a device never half-applies.
func TestABadRecordRefusesTheWholeBatch(t *testing.T) {
	needs(t)
	a := signIn(t)
	good := fresh("good")
	before := a.startCursor()
	res := a.send(before, a.record("task", good, "title", "fine"), record{"Not a type", fresh("bad"), map[string]field{"x": {1, a.clock()}}})
	if res.status != 400 {
		t.Fatalf("%d", res.status)
	}
	if a.startCursor() != before {
		t.Fatal("part of a refused batch was written")
	}
}

func TestConcurrentDevicesLoseNothing(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	shared := fresh("shared")
	const devices, rounds = 6, 8
	wall := time.Now().Add(-time.Minute)
	var wg stdsync.WaitGroup
	errs := make(chan string, devices*rounds*2)
	ids := make([][]string, devices)
	for d := 0; d < devices; d++ {
		ids[d] = make([]string, rounds)
		for r := range ids[d] {
			ids[d][r] = fresh("own")
			a.pushed[[2]string{"task", ids[d][r]}] = true
		}
	}
	a.pushed[[2]string{"task", shared}] = true
	for d := 0; d < devices; d++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := 0; r < rounds; r++ {
				clock := clockAt(wall, r, fmt.Sprintf("device-%d", d))
				body := mustJSON(t, syncRequest{0, []record{
					{"task", ids[d][r], map[string]field{"who": {d, clock}}},
					// Each device owns a field of the shared record, so a lost update would show as a missing one.
					{"task", shared, map[string]field{fmt.Sprintf("device_%d", d): {r, clock}}},
				}})
				for try := 0; ; try++ {
					res := request(t, "POST", "/sync", a.tokens.access, body)
					if res.status == 200 {
						break
					}
					if res.status != 409 || try == 200 {
						errs <- fmt.Sprintf("device %d round %d: %d %s", d, r, res.status, truncated(res.body))
						return
					}
					time.Sleep(time.Duration(5+try) * time.Millisecond)
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	all, end := a.pullAll(start)
	for d := range ids {
		for _, id := range ids[d] {
			if _, ok := find(all, "task", id); !ok {
				t.Errorf("lost %s", id)
			}
		}
	}
	got, ok := find(all, "task", shared)
	if !ok {
		t.Fatal("lost the shared record")
	}
	for d := 0; d < devices; d++ {
		if v := valueOf(t, got, fmt.Sprintf("device_%d", d)); v != json.Number(strconv.Itoa(rounds-1)) {
			t.Errorf("device %d kept %v", d, v)
		}
	}
	// Sequence numbers are one per write, so a device pulling from any point sees a consistent history.
	counter := a.startCursor()
	if end != counter {
		t.Errorf("pull ended at %d, counter %d", end, counter)
	}
}

func TestConflictRetriesThenAsksTheDeviceToResend(t *testing.T) {
	needs(t, faultInjection)
	a := signIn(t)
	id := fresh("conflict")
	t.Cleanup(func() { setFaults(t, 0) })

	// Under the attempt limit the request still works.
	setFaults(t, 2)
	a.sync(a.startCursor(), a.record("task", id, "title", "first"))

	setFaults(t, 3)
	change := a.record("task", id, "title", "second")
	before := a.startCursor()
	res := a.send(before, change)
	if res.status != 409 || res.errorCode() != "conflict" {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	got, _ := a.get("task", id)
	if valueOf(t, got, "title") != "first" {
		t.Fatalf("%+v", got)
	}
	a.sync(before, change)
	got, _ = a.get("task", id)
	if valueOf(t, got, "title") != "second" {
		t.Fatalf("%+v", got)
	}
}

func setFaults(t *testing.T, conflicts int) {
	t.Helper()
	res := request(t, "POST", "/_local/faults", "", []byte(fmt.Sprintf(`{"sync_conflicts":%d}`, conflicts)))
	if res.status != 204 {
		t.Fatalf("faults: %d", res.status)
	}
}

func TestCursorAboveTheCounterMeansARestore(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	kept := fresh("kept")
	counter := a.sync(start, a.record("task", kept, "title", "Write the report")).Cursor

	// A device from before a restore: nothing it sends is written, and it hears the real counter.
	lost := fresh("lost")
	res := a.sync(counter+1000, a.record("task", lost, "title", "Paint the fence"))
	if res.Cursor != counter || len(res.Changes) != 0 || res.More {
		t.Fatalf("%+v", res)
	}
	all, _ := a.pullAll(start)
	if _, ok := find(all, "task", lost); ok {
		t.Fatal("a device above the counter wrote")
	}
	// Starting over from 0 with everything it has brings the record back and keeps the rest.
	a.sync(0, a.record("task", lost, "title", "Paint the fence"))
	all, _ = a.pullAll(start)
	if _, ok := find(all, "task", lost); !ok {
		t.Fatal("the re-send didn't land")
	}
	if _, ok := find(all, "task", kept); !ok {
		t.Fatal("the reset lost a record")
	}
	if res := a.sync(math.MaxInt64); res.Cursor != a.startCursor() {
		t.Fatalf("%+v", res)
	}
}

func TestAtTheCounterThereIsNothingToPull(t *testing.T) {
	needs(t)
	a := signIn(t)
	counter := a.startCursor()
	res := a.send(counter)
	if res.status != 200 || !strings.Contains(string(res.body), `"changes":[]`) {
		t.Fatalf("an empty pull must be an empty list: %d %s", res.status, res.body)
	}
}

func TestClockLimitIsADayAheadOfTheServer(t *testing.T) {
	needs(t, fakeClock)
	clock := holdClock(t)
	a := signIn(t)
	id := fresh("limit")
	justOver := map[string]field{"title": {"x", clockAt(clock.now.Add(24*time.Hour+time.Millisecond), 0, "device")}}
	atLimit := map[string]field{"note": {"x", clockAt(clock.now.Add(24*time.Hour), 0, "device")}}
	if res := a.send(0, record{"task", id, justOver}); res.status != 400 || res.errorCode() != "clock_ahead" {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	if res := a.send(0, record{"task", id, atLimit}); res.status != 200 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	// The limit follows the server's time, so the same clock is fine later on.
	clock.advance(time.Hour)
	a.reSignIn()
	if res := a.send(0, record{"task", id, justOver}); res.status != 200 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
}

func TestClockAheadWithinADayHoldsOnTheRealClock(t *testing.T) {
	needs(t)
	a := signIn(t)
	id := fresh("ahead")
	a.sync(a.startCursor(), record{"task", id, map[string]field{"title": {"from the future", clockAt(time.Now().Add(23*time.Hour), 0, "device")}}})
	a.sync(a.startCursor(), a.record("task", id, "title", "normal"))
	got, _ := a.get("task", id)
	if valueOf(t, got, "title") != "from the future" {
		t.Fatalf("%+v", got)
	}
}

func TestTombstonesSyncAndRestore(t *testing.T) {
	needs(t)
	a := signIn(t)
	start := a.startCursor()
	id := fresh("tomb")
	a.sync(start, a.record("task", id, "title", "Learn to bake bread"))
	stamp := time.Now().UTC().Format(time.RFC3339)

	a.sync(a.startCursor(), a.record("task", id, "deleted_at", stamp))
	all, _ := a.pullAll(start)
	got, ok := find(all, "task", id)
	if !ok || valueOf(t, got, "deleted_at") != stamp || valueOf(t, got, "title") != "Learn to bake bread" {
		t.Fatalf("a delete keeps the row and sends it on: %+v", got)
	}

	// An older write from a device that hadn't heard can't undo it, and an edit to another field doesn't either.
	old := clockAt(time.Now().Add(-time.Hour), 0, "late")
	a.sync(a.startCursor(), record{"task", id, map[string]field{"deleted_at": {nil, old}, "title": {"late edit", old}}})
	got, _ = a.get("task", id)
	if valueOf(t, got, "deleted_at") != stamp || valueOf(t, got, "title") != "Learn to bake bread" {
		t.Fatalf("%+v", got)
	}
	a.sync(a.startCursor(), a.record("task", id, "note", "edited after"))
	got, _ = a.get("task", id)
	if valueOf(t, got, "deleted_at") != stamp {
		t.Fatalf("%+v", got)
	}

	// Undo is a newer null.
	a.sync(a.startCursor(), a.record("task", id, "deleted_at", nil))
	got, _ = a.get("task", id)
	if valueOf(t, got, "deleted_at") != nil {
		t.Fatalf("%+v", got)
	}
}

func TestUsersCanOnlySeeTheirOwnRecords(t *testing.T) {
	needs(t, secondUser)
	one, other := signIn(t), signInOther(t)
	oneStart, otherStart := one.startCursor(), other.startCursor()
	shared := fresh("same-id")
	only := fresh("only-one")
	oneCursor := one.sync(oneStart, one.record("task", shared, "title", "belongs to one"), one.record("task", only, "title", "private")).Cursor

	seen, _ := other.pullAll(0)
	for _, id := range []string{shared, only} {
		if _, ok := find(seen, "task", id); ok {
			t.Fatalf("the other user saw %s", id)
		}
	}
	if got := other.startCursor(); got != otherStart {
		t.Fatalf("one user's write moved another's counter: %d to %d", otherStart, got)
	}

	// The same id is an independent record for each, and nothing in a request can name another user.
	body := mustJSON(t, map[string]any{"cursor": 0, "sub": one.username, "user": one.username, "pk": "user#" + one.username, "changes": []record{other.record("task", shared, "title", "belongs to other")}})
	other.pushed[[2]string{"task", shared}] = true
	if res := other.sendRaw(body); res.status != 200 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	mine, _ := one.get("task", shared)
	theirs, _ := other.get("task", shared)
	if valueOf(t, mine, "title") != "belongs to one" || valueOf(t, theirs, "title") != "belongs to other" {
		t.Fatalf("%+v %+v", mine, theirs)
	}
	if one.startCursor() != oneCursor {
		t.Fatal("the other user's write moved this one's counter")
	}
}
