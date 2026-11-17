package account_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

// exportOf builds the person's export and returns its files by name, as the person unzips it.
func (w *world) exportOf(sub string) map[string]string {
	w.t.Helper()
	ctx := context.Background()
	state, err := w.svc.StartExport(ctx, sub)
	if err != nil || state.State != account.ExportBuilding {
		w.t.Fatalf("start: %+v, %v", state, err)
	}
	w.mustRun(w.started[len(w.started)-1])
	state, err = w.svc.Export(ctx, sub)
	if err != nil || state.State != account.ExportReady || state.ExpiresAt == nil {
		w.t.Fatalf("export: %+v, %v", state, err)
	}
	link, err := url.Parse(state.URL)
	if err != nil {
		w.t.Fatal(err)
	}
	key := strings.TrimPrefix(link.Path, "/")
	if !strings.HasPrefix(key, "exports/"+obs.HashSub(sub)+"/") {
		w.t.Fatalf("the export is at %s, outside the person's own prefix", key)
	}
	raw, ok := w.bucket.Object(key)
	if !ok {
		w.t.Fatalf("no object at %s", key)
	}
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		w.t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range archive.File {
		r, err := f.Open()
		if err != nil {
			w.t.Fatal(err)
		}
		body, _ := io.ReadAll(r)
		r.Close()
		files[f.Name] = string(body)
	}
	return files
}

func records(t *testing.T, files map[string]string, name string) []map[string]any {
	t.Helper()
	var list []map[string]any
	if err := json.Unmarshal([]byte(files[name]), &list); err != nil {
		t.Fatalf("%s: %v\n%s", name, err, files[name])
	}
	return list
}

func names(files map[string]string) []string {
	var list []string
	for name := range files {
		list = append(list, name)
	}
	slices.Sort(list)
	return list
}

func TestAnExportHoldsEveryRecordOfEveryTypeItsFilesAndAReadme(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 3)
	w.seed("bob", 3)
	files := w.exportOf("alice")

	want := []string{
		"README.md", "files/alice-a1/photo.jpg", "notes/A note of alice.md",
		"records/attachment.json", "records/memo.json", "records/settings.json", "records/task.json",
	}
	if got := names(files); !slices.Equal(got, want) {
		t.Fatalf("got %v", got)
	}
	if files["files/alice-a1/photo.jpg"] != "the photo of alice" {
		t.Fatalf("photo %q", files["files/alice-a1/photo.jpg"])
	}
	var ids []string
	for _, r := range records(t, files, "records/task.json") {
		ids = append(ids, r["id"].(string))
	}
	// The deleted task too: it's still held for its 30 days.
	if !slices.Equal(ids, []string{"alice-gone", "alice-t0", "alice-t1", "alice-t2"}) {
		t.Fatalf("tasks %v", ids)
	}
	if settings := records(t, files, "records/settings.json"); len(settings) != 1 || settings[0]["week_start"] != float64(1) {
		t.Fatalf("settings %+v", settings)
	}
	if memo := records(t, files, "records/memo.json"); len(memo) != 1 || memo[0]["title"] != "A note of alice" {
		t.Fatalf("memo %+v", memo)
	}
	if !strings.Contains(files["README.md"], "records/") || !strings.Contains(files["README.md"], "2026-11-17") {
		t.Fatalf("README %q", files["README.md"])
	}
	for name, body := range files {
		if strings.Contains(body, "bob") || strings.Contains(name, "bob") {
			t.Fatalf("bob's data is in alice's export, in %s", name)
		}
	}
	// Counted, never who.
	if logs := w.logs.String(); !strings.Contains(logs, `"AccountExports":1`) || strings.Contains(logs, "alice") || strings.Contains(logs, obs.HashSub("alice")) {
		t.Fatalf("logs %s", logs)
	}
}

func TestEachNoteIsAlsoMarkdownWithItsPhotosBesideIt(t *testing.T) {
	w := newWorld(t)
	w.identity.add("alice")
	c := clockAt(w.now)
	f := func(v any) sync.Field { return sync.Field{V: v, C: c} }
	ctx := context.Background()
	_, err := w.store.Push(ctx, "alice", 0, []sync.Change{
		{Type: "memo", ID: "m1", Fields: sync.Fields{"title": f("Shopping list"), "body": f("- eggs\n- *bread*"), "saved_on": f("2026-11-17")}},
		{Type: "memo", ID: "m2", Fields: sync.Fields{"title": f("Shopping list"), "body": f("The other one")}},
		{Type: "memo", ID: "m3", Fields: sync.Fields{"title": f("Thrown away"), "deleted_at": f(w.now.Format(time.RFC3339))}},
		{Type: "attachment", ID: "p1", Fields: sync.Fields{"memo_id": f("m1"), "kind": f("photo"), "name": f("shelf.jpg"), "type": f("image/jpeg")}},
		{Type: "attachment", ID: "p2", Fields: sync.Fields{"memo_id": f("m1"), "kind": f("file"), "name": f("list [v2].pdf"), "type": f("application/pdf")}},
		{Type: "attachment", ID: "p3", Fields: sync.Fields{"memo_id": f("m1"), "kind": f("link"), "name": f("The shop"), "url": f("https://example.com/a shop")}},
		{Type: "attachment", ID: "p4", Fields: sync.Fields{"memo_id": f("m3"), "kind": f("photo"), "name": f("old.jpg"), "type": f("image/jpeg")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"p1", "p2", "p4"} {
		object := "u/" + obs.HashSub("alice") + "/" + id
		w.bucket.Put(ctx, object, strings.NewReader("bytes of "+id), "image/jpeg", "")
		w.put("alice", "file#"+id, map[string]types.AttributeValue{"key": &types.AttributeValueMemberS{Value: object}})
	}
	files := w.exportOf("alice")

	note := files["notes/Shopping list.md"]
	want := "# Shopping list\n\n- eggs\n- *bread*\n\n![shelf.jpg](<Shopping list/shelf.jpg>)\n\n[list \\[v2\\].pdf](<Shopping list/list [v2].pdf>)\n\n[The shop](https://example.com/a%20shop)\n"
	if note != want {
		t.Fatalf("note:\n%s\nwant:\n%s", note, want)
	}
	if files["notes/Shopping list/shelf.jpg"] != "bytes of p1" || files["notes/Shopping list/list [v2].pdf"] != "bytes of p2" {
		t.Fatalf("files beside the note: %v", names(files))
	}
	// The second note of the same name doesn't overwrite the first.
	if files["notes/Shopping list (2).md"] != "# Shopping list\n\nThe other one\n" {
		t.Fatalf("second note %q", files["notes/Shopping list (2).md"])
	}
	// A deleted note is only in its records, and its photo with the rest of the files.
	if _, ok := files["notes/Thrown away.md"]; ok {
		t.Fatal("a deleted note was written as Markdown")
	}
	if files["files/p4/old.jpg"] != "bytes of p4" {
		t.Fatalf("got %v", names(files))
	}
	if len(records(t, files, "records/memo.json")) != 3 {
		t.Fatal("memo.json should hold every note")
	}
}

func TestAnExportLinkIsHandedOutOnce(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	w.exportOf("alice")
	state, err := w.svc.Export(context.Background(), "alice")
	if err != nil || state.State != account.ExportNone || state.URL != "" {
		t.Fatalf("asked again: %+v, %v", state, err)
	}
}

func TestAnExportThatNeverFinishesCountsAsFailed(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	ctx := context.Background()
	w.svc.StartExport(ctx, "alice")
	w.now = w.now.Add(10 * time.Minute)
	if state, _ := w.svc.Export(ctx, "alice"); state.State != account.ExportBuilding {
		t.Fatalf("got %+v", state)
	}
	w.now = w.now.Add(11 * time.Minute)
	if state, _ := w.svc.Export(ctx, "alice"); state.State != account.ExportFailed {
		t.Fatalf("got %+v", state)
	}
	// Asking again starts afresh.
	if state, _ := w.svc.StartExport(ctx, "alice"); state.State != account.ExportBuilding || len(w.started) != 2 {
		t.Fatalf("got %+v, %d jobs", state, len(w.started))
	}
}

func TestAskingForAnExportWhileOneBuildsStartsNoOther(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	ctx := context.Background()
	w.svc.StartExport(ctx, "alice")
	w.svc.StartExport(ctx, "alice")
	if len(w.started) != 1 {
		t.Fatalf("started %d jobs", len(w.started))
	}
}

func TestAFailedExportSaysSo(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	ctx := context.Background()
	w.svc.StartExport(ctx, "alice")
	w.svc.Objects = brokenBucket{w.bucket}
	if err := w.run(w.started[0]); err == nil {
		t.Fatal("no error")
	}
	if state, _ := w.svc.Export(ctx, "alice"); state.State != account.ExportFailed {
		t.Fatalf("got %+v", state)
	}
	if !strings.Contains(w.logs.String(), `"AccountExportFailures":1`) {
		t.Fatalf("logs %s", w.logs.String())
	}
}

type brokenBucket struct{ account.Objects }

func (brokenBucket) Put(_ context.Context, _ string, body io.Reader, _, _ string) error {
	io.CopyN(io.Discard, body, 10)
	return errors.New("s3 unavailable")
}

func TestExportNamesStayInsideTheirFolders(t *testing.T) {
	w := newWorld(t)
	w.identity.add("alice")
	c := clockAt(w.now)
	f := func(v any) sync.Field { return sync.Field{V: v, C: c} }
	ctx := context.Background()
	_, err := w.store.Push(ctx, "alice", 0, []sync.Change{
		{Type: "attachment", ID: "../../x", Fields: sync.Fields{"name": f("../../etc/passwd"), "kind": f("file")}},
		{Type: "memo", ID: "m1", Fields: sync.Fields{"title": f("../../up")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	object := "u/" + obs.HashSub("alice") + "/x"
	w.bucket.Put(ctx, object, strings.NewReader("x"), "text/plain", "")
	w.put("alice", "file#../../x", map[string]types.AttributeValue{"key": &types.AttributeValueMemberS{Value: object}})
	for name := range w.exportOf("alice") {
		for _, part := range strings.Split(name, "/") {
			if part == ".." || part == "" || strings.HasPrefix(part, ".") {
				t.Fatalf("unsafe path %q", name)
			}
		}
	}
}

func TestAFiveYearHistoryExportsWhole(t *testing.T) {
	w := newWorld(t)
	w.identity.add("alice")
	c := clockAt(w.now)
	long := strings.Repeat("a long title ", 30)
	var changes []sync.Change
	for i := range 3000 {
		changes = append(changes, sync.Change{Type: "task", ID: fmt.Sprintf("t%05d", i), Fields: sync.Fields{"title": {V: long, C: c}}})
	}
	for start := 0; start < len(changes); start += 99 {
		if _, err := w.store.Push(context.Background(), "alice", 0, changes[start:min(start+99, len(changes))]); err != nil {
			t.Fatal(err)
		}
	}
	// Over a megabyte, so DynamoDB pages the read.
	if got := len(records(t, w.exportOf("alice"), "records/task.json")); got != 3000 {
		t.Fatalf("got %d tasks", got)
	}
}

func TestExportNeedsAFilesBucket(t *testing.T) {
	w := newWorld(t)
	w.svc.Objects, w.svc.Sign = nil, nil
	if _, err := w.svc.StartExport(context.Background(), "alice"); !errors.Is(err, account.ErrNoFiles) {
		t.Fatalf("got %v", err)
	}
	if _, err := w.svc.Export(context.Background(), "alice"); !errors.Is(err, account.ErrNoFiles) {
		t.Fatalf("got %v", err)
	}
}
