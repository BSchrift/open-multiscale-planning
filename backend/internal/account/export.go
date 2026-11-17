package account

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

const (
	ExportNone     = "none"
	ExportBuilding = "building"
	ExportReady    = "ready"
	ExportFailed   = "failed"
	// exportDelivered is a ready export whose link has been handed out, which is once.
	exportDelivered = "delivered"

	// exportKey holds the person's latest export: its state, id and start, and once built, its key in the bucket. It has
	// no sequence number, so no pull returns it, and it goes with the rest of the partition when the account does.
	exportKey = "meta#export"
	// ExportLinkLife is how long an export's download link works, as long as an attachment's.
	ExportLinkLife = 5 * time.Minute
	// exportTimeout is when an export still building counts as failed: past the account function's 15 minutes.
	exportTimeout  = 20 * time.Minute
	attachmentType = "attachment"
	// memoType is a note's record. Each note is also written as Markdown.
	memoType   = "memo"
	filePrefix = "file#"
)

// ErrNoFiles is what the export routes answer where the environment stores no files, so has nowhere to put one.
var ErrNoFiles = errors.New("account: no files bucket")

// ExportState is what the export routes answer: how the latest export stands, and once it's ready, its link.
type ExportState struct {
	State     string     `json:"state"`
	URL       string     `json:"url,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

type export struct {
	state, id, key string
	started        time.Time
}

func (e export) stale(now time.Time) bool { return now.After(e.started.Add(exportTimeout)) }

func (s *Service) readExport(ctx context.Context, sub string) (export, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table), Key: key(userKey(sub), exportKey), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return export{}, fmt.Errorf("account: read export: %w", err)
	}
	if out.Item == nil {
		return export{state: ExportNone}, nil
	}
	started, _ := time.Parse(time.RFC3339, stringAttr(out.Item["started_at"]))
	return export{state: stringAttr(out.Item["state"]), id: stringAttr(out.Item["id"]), key: stringAttr(out.Item["key"]), started: started}, nil
}

// StartExport starts building an export of everything the caller has. One already building is the one they get.
func (s *Service) StartExport(ctx context.Context, sub string) (ExportState, error) {
	if s.Sign == nil {
		return ExportState{}, ErrNoFiles
	}
	now := s.Now()
	current, err := s.readExport(ctx, sub)
	if err != nil {
		return ExportState{}, err
	}
	if current.state == ExportBuilding && !current.stale(now) {
		return ExportState{State: ExportBuilding}, nil
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return ExportState{}, err
	}
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                aws.String(s.Table),
		Key:                      key(userKey(sub), exportKey),
		UpdateExpression:         aws.String("SET #state = :building, id = :id, started_at = :now REMOVE #key"),
		ExpressionAttributeNames: map[string]string{"#state": "state", "#key": "key"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":building": str(ExportBuilding), ":id": str(hex.EncodeToString(random)), ":now": str(now.UTC().Format(time.RFC3339)),
		},
	})
	if err != nil {
		return ExportState{}, fmt.Errorf("account: start export: %w", err)
	}
	s.start(ctx, Job{Kind: JobExport, Sub: sub})
	return ExportState{State: ExportBuilding}, nil
}

// Export says how the caller's latest export stands. A ready one's link is handed out once, and works for
// ExportLinkLife; asked for again, it's gone, and the person exports again.
func (s *Service) Export(ctx context.Context, sub string) (ExportState, error) {
	if s.Sign == nil {
		return ExportState{}, ErrNoFiles
	}
	now := s.Now()
	current, err := s.readExport(ctx, sub)
	if err != nil {
		return ExportState{}, err
	}
	switch current.state {
	case ExportBuilding:
		if current.stale(now) {
			return ExportState{State: ExportFailed}, nil
		}
		return ExportState{State: ExportBuilding}, nil
	case ExportFailed:
		return ExportState{State: ExportFailed}, nil
	case ExportReady:
	default:
		return ExportState{State: ExportNone}, nil
	}
	expires := now.Add(ExportLinkLife).UTC().Truncate(time.Second)
	url, err := s.Sign(ctx, current.key, expires)
	if err != nil {
		return ExportState{}, err
	}
	_, err = s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       key(userKey(sub), exportKey),
		UpdateExpression:          aws.String("SET #state = :delivered"),
		ConditionExpression:       aws.String("#state = :ready AND id = :id"),
		ExpressionAttributeNames:  map[string]string{"#state": "state"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":delivered": str(exportDelivered), ":ready": str(ExportReady), ":id": str(current.id)},
	})
	// Another request took the link first.
	var refused *types.ConditionalCheckFailedException
	if errors.As(err, &refused) {
		return ExportState{State: ExportNone}, nil
	}
	if err != nil {
		return ExportState{}, fmt.Errorf("account: hand out export: %w", err)
	}
	return ExportState{State: ExportReady, URL: url, ExpiresAt: &expires}, nil
}

// BuildExport builds the export the person asked for, as a zip streamed to the bucket, so its size never meets the
// function's memory. The bucket's lifecycle removes it a day later.
func (s *Service) BuildExport(ctx context.Context, sub string) error {
	if s.Objects == nil {
		return ErrNoFiles
	}
	current, err := s.readExport(ctx, sub)
	if err != nil || current.state != ExportBuilding {
		return err
	}
	now := s.Now()
	object := "exports/" + obs.HashSub(sub) + "/" + current.id + ".zip"
	name := "multiscale-export-" + now.UTC().Format("2006-01-02") + ".zip"
	reader, writer := io.Pipe()
	var counts archiveCounts
	written := make(chan error, 1)
	go func() {
		var err error
		counts, err = s.writeArchive(ctx, sub, writer, now)
		writer.CloseWithError(err)
		written <- err
	}()
	err = s.Objects.Put(ctx, object, reader, "application/zip", `attachment; filename="`+name+`"`)
	// A failed upload stops the writer too.
	reader.CloseWithError(err)
	if archiveErr := <-written; err == nil {
		err = archiveErr
	}
	next, metric := ExportReady, "AccountExports"
	if err != nil {
		next, metric = ExportFailed, "AccountExportFailures"
	}
	_, updateErr := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                aws.String(s.Table),
		Key:                      key(userKey(sub), exportKey),
		UpdateExpression:         aws.String("SET #state = :next, #key = :key"),
		ConditionExpression:      aws.String("#state = :building AND id = :id"),
		ExpressionAttributeNames: map[string]string{"#state": "state", "#key": "key"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":next": str(next), ":key": str(object), ":building": str(ExportBuilding), ":id": str(current.id),
		},
	})
	var refused *types.ConditionalCheckFailedException
	// A newer export replaced this one meanwhile, or the account is going: nothing to record.
	if errors.As(updateErr, &refused) {
		updateErr = nil
	}
	// Counted, never who.
	attrs := []any{"outcome", next, "records", counts.records, "notes", counts.notes, "files", counts.files}
	if err != nil {
		attrs = append(attrs, sync.ErrorAttrs(err)...)
	}
	s.Log.Info("account_export", append(attrs, obs.Metrics(s.Env, now, map[string]int{metric: 1})...)...)
	return errors.Join(err, updateErr)
}

type archiveCounts struct{ records, notes, files int }

// file is a granted attachment's object in the bucket, from its file# item.
type file struct{ key, contentType string }

// attachment is what the archive needs of an attachment's record: where it's shown, and what it's called.
type attachment struct {
	id, memoID, kind, name, url, contentType string
	deleted                                  bool
}

// note is a note's record, which the archive also writes as Markdown.
type note struct{ id, title, body string }

// writeArchive writes the zip: README.md; records/<type>.json for each type in the person's partition; notes/<title>.md
// for each note, with its photos and files in notes/<title>/ beside it; and files/<attachment id>/<name> for every other
// attachment's file in the bucket. Every path is relative, so the whole can nest in a folder of its own.
func (s *Service) writeArchive(ctx context.Context, sub string, w io.Writer, at time.Time) (archiveCounts, error) {
	var counts archiveCounts
	files, err := s.fileItems(ctx, sub)
	if err != nil {
		return counts, err
	}
	archive := zip.NewWriter(w)
	create := func(name string, method uint16) (io.Writer, error) {
		return archive.CreateHeader(&zip.FileHeader{Name: name, Method: method, Modified: at})
	}
	readme, err := create("README.md", zip.Deflate)
	if err != nil {
		return counts, err
	}
	if _, err := io.WriteString(readme, strings.ReplaceAll(readmeText, "{at}", at.UTC().Format(time.RFC3339))); err != nil {
		return counts, err
	}
	// Records come in type order, so each type's file is written whole before the next opens.
	var out io.Writer
	current := ""
	attachments := map[string]attachment{}
	var notes []note
	err = s.Records.Each(ctx, sub, func(c sync.Change) error {
		if c.Type != current || out == nil {
			if out != nil {
				if _, err := io.WriteString(out, "\n]\n"); err != nil {
					return err
				}
			}
			var err error
			if out, err = create("records/"+safeName(c.Type)+".json", zip.Deflate); err != nil {
				return err
			}
			if _, err := io.WriteString(out, "[\n"); err != nil {
				return err
			}
			current = c.Type
		} else if _, err := io.WriteString(out, ",\n"); err != nil {
			return err
		}
		line, err := recordJSON(c)
		if err != nil {
			return err
		}
		if _, err := out.Write(line); err != nil {
			return err
		}
		counts.records++
		deleted := c.Fields["deleted_at"].V != nil
		switch c.Type {
		case attachmentType:
			attachments[c.ID] = attachment{
				id: c.ID, memoID: text(c.Fields, "memo_id"), kind: text(c.Fields, "kind"), name: text(c.Fields, "name"),
				url: text(c.Fields, "url"), contentType: text(c.Fields, "type"), deleted: deleted,
			}
		case memoType:
			if !deleted {
				notes = append(notes, note{id: c.ID, title: text(c.Fields, "title"), body: text(c.Fields, "body")})
			}
		}
		return nil
	})
	if err != nil {
		return counts, err
	}
	if out != nil {
		if _, err := io.WriteString(out, "\n]\n"); err != nil {
			return counts, err
		}
	}

	// Where each attachment's file goes: beside its note, or under files/.
	paths := map[string]string{}
	byNote := map[string][]attachment{}
	ids := make([]string, 0, len(attachments))
	for id, a := range attachments {
		ids = append(ids, id)
		if a.memoID != "" && !a.deleted {
			byNote[a.memoID] = append(byNote[a.memoID], a)
		}
	}
	slices.Sort(ids)
	usedNotes := map[string]bool{}
	for _, n := range notes {
		stem := unique(fileName(n.title, "Untitled"), "", usedNotes)
		md := "# " + strings.TrimSpace(n.title) + "\n"
		if body := strings.TrimSpace(n.body); body != "" {
			md += "\n" + body + "\n"
		}
		own := byNote[n.id]
		slices.SortFunc(own, func(a, b attachment) int { return strings.Compare(a.id, b.id) })
		usedFiles := map[string]bool{}
		var links []string
		for _, a := range own {
			label := markdownLabel(a.name)
			if _, stored := files[a.id]; stored {
				name := unique(fileName(a.name, "file"), extension(a.name), usedFiles)
				paths[a.id] = "notes/" + stem + "/" + name
				link := "[" + label + "](<" + stem + "/" + name + ">)"
				if strings.HasPrefix(a.contentType, "image/") {
					link = "!" + link
				}
				links = append(links, link)
			} else if a.kind == "link" && a.url != "" {
				links = append(links, "["+label+"]("+markdownURL(a.url)+")")
			}
		}
		if len(links) > 0 {
			md += "\n" + strings.Join(links, "\n\n") + "\n"
		}
		entry, err := create("notes/"+stem+".md", zip.Deflate)
		if err == nil {
			_, err = io.WriteString(entry, md)
		}
		if err != nil {
			return counts, err
		}
		counts.notes++
	}

	for _, id := range ids {
		stored, ok := files[id]
		if !ok {
			continue
		}
		body, err := s.Objects.Get(ctx, stored.key)
		if err != nil {
			return counts, err
		}
		// Granted, but its upload never finished.
		if body == nil {
			continue
		}
		path, ok := paths[id]
		if !ok {
			path = "files/" + safeName(id) + "/" + fileName(attachments[id].name, "file")
		}
		// Stored, not compressed: photos and most documents already are.
		entry, err := create(path, zip.Store)
		if err == nil {
			_, err = io.Copy(entry, body)
		}
		body.Close()
		if err != nil {
			return counts, err
		}
		counts.files++
	}
	return counts, archive.Close()
}

func text(fields sync.Fields, name string) string {
	value, _ := fields[name].V.(string)
	return value
}

// unique is name, or name with " (2)", " (3)" and so on before its extension, whichever used doesn't hold yet, ignoring
// case, as macOS and Windows do.
func unique(name, ext string, used map[string]bool) string {
	stem := strings.TrimSuffix(name, ext)
	candidate := name
	for n := 2; used[strings.ToLower(candidate)]; n++ {
		candidate = fmt.Sprintf("%s (%d)%s", stem, n, ext)
	}
	used[strings.ToLower(candidate)] = true
	return candidate
}

// extension is a file name's extension with its dot, or "" when it has none.
func extension(name string) string {
	if i := strings.LastIndex(name, "."); i > 0 {
		return name[i:]
	}
	return ""
}

// markdownLabel escapes what would end a link's text early.
func markdownLabel(s string) string {
	return strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`, "\n", " ").Replace(s)
}

// markdownURL escapes what would end a link's address early.
func markdownURL(s string) string {
	return strings.NewReplacer(" ", "%20", "(", "%28", ")", "%29", "<", "%3C", ">", "%3E", "\n", "").Replace(s)
}

// fileItems reads the person's file# items: the object each granted attachment's file is at.
func (s *Service) fileItems(ctx context.Context, sub string) (map[string]file, error) {
	files := map[string]file{}
	var start map[string]types.AttributeValue
	for {
		out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.Table),
			ConsistentRead:         aws.Bool(true),
			ExclusiveStartKey:      start,
			KeyConditionExpression: aws.String("pk = :user AND begins_with(sk, :file)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":user": str(userKey(sub)), ":file": str(filePrefix),
			},
		})
		if err != nil {
			return nil, fmt.Errorf("account: read files: %w", err)
		}
		for _, item := range out.Items {
			id := strings.TrimPrefix(stringAttr(item["sk"]), filePrefix)
			files[id] = file{key: stringAttr(item["key"]), contentType: stringAttr(item["type"])}
		}
		if len(out.LastEvaluatedKey) == 0 {
			return files, nil
		}
		start = out.LastEvaluatedKey
	}
}

// recordJSON is a record as the export holds it: its id, then each field's value by name, without the clocks sync
// keeps beside them.
func recordJSON(c sync.Change) ([]byte, error) {
	names := make([]string, 0, len(c.Fields))
	for name := range c.Fields {
		names = append(names, name)
	}
	slices.Sort(names)
	var buf bytes.Buffer
	id, err := json.Marshal(c.ID)
	if err != nil {
		return nil, err
	}
	buf.WriteString(`  {"id":`)
	buf.Write(id)
	for _, name := range names {
		k, err := json.Marshal(name)
		if err != nil {
			return nil, err
		}
		v, err := json.Marshal(c.Fields[name].V)
		if err != nil {
			return nil, err
		}
		buf.WriteByte(',')
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// safeName makes an id safe as one part of a path in the zip: letters, digits, dots, dashes and underscores, with no
// leading dot. An id it had to change also gets a short hash of itself, so two ids never share a name.
func safeName(id string) string {
	var b strings.Builder
	for _, r := range id {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	name := strings.TrimLeft(b.String(), ".")
	if len(name) > 80 {
		name = name[:80]
	}
	if name == id {
		return name
	}
	sum := sha256.Sum256([]byte(id))
	return name + "-" + hex.EncodeToString(sum[:4])
}

// fileName is a name made safe as the last part of a path on any computer, or fallback if nothing is left.
func fileName(name, fallback string) string {
	var b strings.Builder
	for _, r := range name {
		if strings.ContainsRune(`<>:"/\|?*`, r) || unicode.IsControl(r) {
			b.WriteByte('_')
		} else {
			b.WriteRune(r)
		}
	}
	safe := strings.TrimSpace(strings.TrimLeft(b.String(), ". "))
	if len([]rune(safe)) > 120 {
		safe = strings.TrimSpace(string([]rune(safe)[:120]))
	}
	if safe == "" {
		return fallback
	}
	return safe
}

const readmeText = `# Your Multiscale data

Exported {at}. This is everything Multiscale's server held for your account at that time.

## What's here

- ` + "`records/`" + `: one JSON file per kind of record, such as ` + "`task.json`" + `, ` + "`project.json`" + ` and ` + "`time_block.json`" + `. Each
  is a list of records, and each record is an object: its ` + "`id`" + `, then each of its fields by name. Your settings are in
  ` + "`settings.json`" + `, and your notes in ` + "`memo.json`" + `.
- ` + "`notes/`" + `: each note again, as Markdown you can open anywhere: its title as the heading, then what it says. Its
  photos and files are in the folder of the same name beside it, and the note links to them.
- ` + "`files/`" + `: the photos and files attached to your tasks, and to notes you've deleted, in a folder named after the
  attachment's id, under the name it was added with. The matching record in ` + "`records/attachment.json`" + ` says which
  task or note it's on.

## Reading the records

- Times such as ` + "`done_at`" + ` are in UTC, in ISO 8601: ` + "`2026-11-17T09:30:00.000Z`" + `. Dates such as ` + "`week_start`" + ` are
  ` + "`YYYY-MM-DD`" + `.
- Records point at each other by id: a task's ` + "`project_id`" + ` is the ` + "`id`" + ` of a record in ` + "`project.json`" + `.
- A record with ` + "`deleted_at`" + ` was deleted then. It's kept for 30 days so Undo can bring it back, and then removed.
  Deleted notes are in ` + "`memo.json`" + ` but not in ` + "`notes/`" + `.
- ` + "`expires_at`" + ` is when a record will be removed under the data retention periods Settings shows.
- A field that's missing, or ` + "`null`" + `, isn't set.

## What isn't here

- Choices kept on one device only, such as its appearance, which never reach the server.
- A photo or file whose upload from your device hadn't finished.
- Your Google Calendar's own events. Your calendar records list what the app read from it.
`
