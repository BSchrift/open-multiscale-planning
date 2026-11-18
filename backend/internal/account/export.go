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
	"unicode/utf8"

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

// StartExport starts building an export of everything the caller has. One already building is the one they get: the
// table decides, so two requests at once start one export, never two.
func (s *Service) StartExport(ctx context.Context, sub string) (ExportState, error) {
	if s.Sign == nil {
		return ExportState{}, ErrNoFiles
	}
	now := s.Now()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return ExportState{}, err
	}
	id := hex.EncodeToString(random)
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                aws.String(s.Table),
		Key:                      key(userKey(sub), exportKey),
		UpdateExpression:         aws.String("SET #state = :building, id = :id, started_at = :now REMOVE #key"),
		ConditionExpression:      aws.String("attribute_not_exists(#state) OR #state <> :building OR started_at < :stale"),
		ExpressionAttributeNames: map[string]string{"#state": "state", "#key": "key"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":building": str(ExportBuilding), ":id": str(id), ":now": str(now.UTC().Format(time.RFC3339)),
			":stale": str(now.Add(-exportTimeout).UTC().Format(time.RFC3339)),
		},
	})
	var refused *types.ConditionalCheckFailedException
	if errors.As(err, &refused) {
		return ExportState{State: ExportBuilding}, nil
	}
	if err != nil {
		return ExportState{}, fmt.Errorf("account: start export: %w", err)
	}
	s.start(ctx, Job{Kind: JobExport, Sub: sub, ID: id})
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
	// Only ever a link to the person's own export, whatever the item says.
	if !strings.HasPrefix(current.key, exportPrefix(sub)) {
		return ExportState{}, errors.New("account: the export's key is outside the person's prefix")
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

func exportPrefix(sub string) string { return Prefixes(sub)[1] }

func filePrefixOf(sub string) string { return Prefixes(sub)[0] }

// BuildExport builds the export id, as a zip streamed to the bucket, so its size never meets the function's memory.
// It builds nothing once another export has replaced it. The bucket's lifecycle removes it a day later.
func (s *Service) BuildExport(ctx context.Context, sub, id string) error {
	if s.Objects == nil {
		return ErrNoFiles
	}
	current, err := s.readExport(ctx, sub)
	if err != nil || current.state != ExportBuilding || current.id != id {
		return err
	}
	now := s.Now()
	object := exportPrefix(sub) + current.id + ".zip"
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

// attachment is what the archive needs of an attachment's record: where it's shown, and what it's called.
type attachment struct {
	id, memoID, kind, name, url, contentType string
	deleted                                  bool
}

// writeArchive writes the zip: README.md; records/<type>.json for each type in the person's partition; notes/<title>.md
// for each note, with its photos and files in notes/<title>/ beside it; and files/<attachment id>/<name> for every other
// attachment's file in the bucket. Every path is relative, so the whole can nest in a folder of its own. It holds no
// more than the attachments' names in memory: records and notes go straight into the zip as they're read.
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
		if c.Type == attachmentType {
			attachments[c.ID] = attachment{
				id: c.ID, memoID: text(c.Fields, "memo_id"), kind: text(c.Fields, "kind"), name: text(c.Fields, "name"),
				url: text(c.Fields, "url"), contentType: text(c.Fields, "type"), deleted: c.Fields["deleted_at"].V != nil,
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

	// Each note again as Markdown, read a second time so no note's body waits in memory for another's.
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
	used := map[string]bool{}
	err = s.Records.EachOf(ctx, sub, memoType, func(c sync.Change) error {
		if c.Fields["deleted_at"].V != nil {
			return nil
		}
		title := text(c.Fields, "title")
		// The note's file and its folder both take the name, so a note called "x" and one called "x.md" never meet.
		stem := uniqueStem(fileName(title, "Untitled"), used)
		md := "# " + strings.TrimSpace(title) + "\n"
		if body := strings.TrimSpace(text(c.Fields, "body")); body != "" {
			md += "\n" + body + "\n"
		}
		own := byNote[c.ID]
		slices.SortFunc(own, func(a, b attachment) int { return strings.Compare(a.id, b.id) })
		usedFiles := map[string]bool{}
		var links []string
		for _, a := range own {
			label := markdownLabel(a.name)
			if _, stored := files[a.id]; stored {
				name := unique(fileName(a.name, "file"), extension(fileName(a.name, "file")), usedFiles)
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
		counts.notes++
		return err
	})
	if err != nil {
		return counts, err
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

// uniqueStem is a note's name for both its Markdown, stem.md, and its folder, stem: one neither of which is taken.
func uniqueStem(stem string, used map[string]bool) string {
	candidate := stem
	for n := 2; used[strings.ToLower(candidate)] || used[strings.ToLower(candidate)+".md"]; n++ {
		candidate = fmt.Sprintf("%s (%d)", stem, n)
	}
	used[strings.ToLower(candidate)], used[strings.ToLower(candidate)+".md"] = true, true
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

// file is a granted attachment's object in the bucket, from its file# item.
type file struct{ key, contentType string }

// fileItems reads the person's file# items: the object each granted attachment's file is at. A key outside the person's
// own prefix is refused, so an export can only ever read their own files.
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
			object := stringAttr(item["key"])
			if !strings.HasPrefix(object, filePrefixOf(sub)) {
				return nil, errors.New("account: a file's key is outside the person's prefix")
			}
			files[id] = file{key: object, contentType: stringAttr(item["type"])}
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

// maxNameBytes is the longest a name in the zip is before its " (2)" or ".md": with them, well under the 255 bytes most
// file systems take.
const maxNameBytes = 100

// safeName makes an id safe as one part of a path in the zip: letters, digits, dots, dashes and underscores. An id it
// had to change also gets a short hash of itself, so two ids never share a name.
func safeName(id string) string {
	var b strings.Builder
	for _, r := range id {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	name := portable(b.String(), "_", maxNameBytes-9)
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
		switch {
		case bidi(r):
		case strings.ContainsRune(`<>:"/\|?*`, r) || unicode.IsControl(r):
			b.WriteByte('_')
		default:
			b.WriteRune(r)
		}
	}
	return portable(b.String(), fallback, maxNameBytes)
}

// portable trims what Windows and macOS drop or refuse: leading dots and spaces, trailing dots and spaces, and
// Windows' device names such as CON and LPT1, with or without an extension. It cuts to limit bytes at a character.
func portable(name, fallback string, limit int) string {
	name = strings.TrimLeft(name, ". ")
	for len(name) > limit {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	name = strings.TrimRight(name, ". ")
	if name == "" {
		return fallback
	}
	if reserved[strings.ToUpper(strings.SplitN(name, ".", 2)[0])] {
		return "_" + name
	}
	return name
}

var reserved = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}

func init() {
	for n := 1; n <= 9; n++ {
		reserved[fmt.Sprintf("COM%d", n)], reserved[fmt.Sprintf("LPT%d", n)] = true, true
	}
}

// bidi is a character that changes which way text runs, which could make a name read as something else, such as
// "gpj.exe" shown as "exe.jpg".
func bidi(r rune) bool {
	return (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0x200e || r == 0x200f || r == 0x061c
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
