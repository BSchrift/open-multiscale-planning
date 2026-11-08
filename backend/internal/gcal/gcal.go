// Package gcal keeps the Time blocks calendar in Google matching the plan, and mirrors the person's other calendars into
// the calendar record. One worker run compares what should be there with what is and fixes the difference, so a failed
// run or an edit made in Google is put right by the next run with no retry or overwrite logic of its own.
package gcal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	// Lambda's base image has no time zone database, and all-day events need their calendar's zone.
	_ "time/tzdata"

	"golang.org/x/oauth2"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

const (
	// CalendarName is the calendar the worker owns.
	CalendarName = "Time blocks"
	// CalendarRecordID is the id of the one calendar record.
	CalendarRecordID = "calendar"

	// The values of last_error. The app turns them into its attention line.
	ErrorRevoked       = "calendar_revoked"
	ErrorRateLimited   = "calendar_rate_limited"
	ErrorFailed        = "calendar_failed"
	ErrorTooManyEvents = "too_many_events"

	window = 8 * 7 * 24 * time.Hour
	// The server has no zone for the person, so this covers the start of today in every zone.
	lookBack  = 24 * time.Hour
	eventText = "Edit in app"
	// For a block whose task or practice is gone.
	fallbackTitle = "Time block"
	// Titles come from devices with limits far above what Google takes.
	maxTitleRunes = 1000
	clockDevice   = "calendar"
	instantFormat = "2006-01-02T15:04:05Z"
)

// Leaves room for the other fields under the store's limit on a record.
var maxEventBytes = sync.MaxRecordBytes * 4 / 5

// Records is the part of the sync store the worker uses.
type Records interface {
	List(ctx context.Context, sub, recordType string) ([]sync.Change, error)
	Push(ctx context.Context, sub string, cursor int64, changes []sync.Change) (sync.Stats, error)
}

// Google is the connection to one Google account. It implements api.Calendar.
type Google struct {
	Records Records
	Secrets Secrets
	States  States
	Log     *slog.Logger
	Env     string
	Now     func() time.Time
	// APIURL is empty for the real Calendar API.
	AuthURL, TokenURL, RevokeURL, APIURL string
	RedirectURL                          string
	// Trigger starts a worker run, from the API's side.
	Trigger func(context.Context) error
}

type runCounts struct {
	inserted, updated, deleted, blocks, read, sources int
}

func (c runCounts) changed() int { return c.inserted + c.updated + c.deleted }

// Run makes one pass for the connected user. A failure is recorded for the app and in the metrics, and returns nil since
// the next run fixes it. Only a failure that couldn't be recorded is returned, so Lambda tries again.
func (g *Google) Run(ctx context.Context, trigger, requestID string) error {
	start := g.Now()
	attrs := []any{"request_id", requestID, "trigger", trigger}
	finish := func(extra ...any) {
		attrs = append(attrs, "duration_ms", g.Now().Sub(start).Milliseconds())
		g.Log.Info("calendar_run", append(attrs, extra...)...)
	}
	failed := func(code string) []any {
		return append([]any{"outcome", "failed", "error_type", code}, obs.Metrics(g.Env, g.Now(), map[string]int{"CalendarRunFailures": 1})...)
	}

	conn, err := g.connection(ctx)
	if errors.Is(err, ErrNoSecret) {
		// A success: not connected is the person's choice, so the alarm on the worker going quiet mustn't fire.
		finish(append([]any{"outcome", "not_connected"}, obs.Metrics(g.Env, g.Now(), map[string]int{
			"CalendarEventsChanged": 0, "CalendarRunFailures": 0,
		})...)...)
		return nil
	}
	if err != nil {
		finish(failed(ErrorFailed)...)
		return err
	}
	attrs = append(attrs, "user", obs.HashSub(conn.Sub))

	counts, err := g.pass(ctx, conn)
	attrs = append(attrs, "inserted", counts.inserted, "updated", counts.updated, "deleted", counts.deleted,
		"blocks", counts.blocks, "events_read", counts.read, "sources", counts.sources)
	if err == nil {
		// Every success emits CalendarEventsChanged, even at zero: the alarm on the worker going quiet counts these.
		finish(append([]any{"outcome", "ok"}, obs.Metrics(g.Env, g.Now(), map[string]int{
			"CalendarEventsChanged": counts.changed(), "CalendarRunFailures": 0,
		})...)...)
		return nil
	}
	if errors.Is(err, errConnectionGone) {
		// A success: a disconnect or another user's consent ended it, and has already said so in the record.
		finish(append([]any{"outcome", "connection_gone"}, obs.Metrics(g.Env, g.Now(), map[string]int{
			"CalendarEventsChanged": counts.changed(), "CalendarRunFailures": 0,
		})...)...)
		return nil
	}
	code := errorCode(err)
	finish(failed(code)...)
	return g.recordFailure(ctx, conn, code)
}

// errConnectionGone stops a run whose connection ended while it ran.
var errConnectionGone = errors.New("gcal: the connection ended during the run")

// stillConnected reports whether conn is still the connection. A disconnect or another user's consent can end it while a
// run is under way, and either has already shown this user unconnected, which the run's own writes would undo.
func (g *Google) stillConnected(ctx context.Context, conn connection) (bool, error) {
	current, err := g.connection(ctx)
	if errors.Is(err, ErrNoSecret) {
		return false, nil
	}
	return err == nil && current.Sub == conn.Sub, err
}

func (g *Google) pass(ctx context.Context, conn connection) (runCounts, error) {
	var counts runCounts
	stored, err := g.calendarRecord(ctx, conn.Sub)
	if err != nil {
		return counts, err
	}
	svc, err := g.service(ctx, conn.RefreshToken)
	if err != nil {
		return counts, err
	}
	calendarID, _ := stored["calendar_id"].V.(string)
	ensured, err := ensureCalendar(ctx, svc, calendarID)
	if err != nil {
		return counts, err
	}
	// Written at once: losing the id to a later failure would leave the next run making another calendar.
	if ensured != calendarID {
		if err := g.writeCalendar(ctx, conn.Sub, stored, map[string]any{"calendar_id": ensured}); err != nil {
			return counts, err
		}
		if stored, err = g.calendarRecord(ctx, conn.Sub); err != nil {
			return counts, err
		}
	}

	now := g.Now()
	from, to := now.Add(-lookBack), now.Add(window)
	want, err := g.desiredEvents(ctx, conn.Sub, from, to)
	if err != nil {
		return counts, err
	}
	counts.blocks = len(want)
	if err := reconcile(ctx, svc, ensured, want, now, from, to, &counts); err != nil {
		return counts, err
	}

	events, sourceChanges, err := g.readSources(ctx, svc, conn.Sub, ensured, from, to, &counts)
	if err != nil {
		return counts, err
	}
	still, err := g.stillConnected(ctx, conn)
	if err != nil {
		return counts, err
	}
	if !still {
		return counts, errConnectionGone
	}
	if len(sourceChanges) > 0 {
		if _, err := g.Records.Push(ctx, conn.Sub, 0, sourceChanges); err != nil {
			return counts, err
		}
	}
	kept, lastError := fitEvents(events)
	values := map[string]any{"connected": true, "events": kept, "last_error": lastError}
	// Every device downloads the whole record again when any field moves, so a run that changed nothing leaves it alone.
	if counts.changed() > 0 || len(changedFields(stored, values)) > 0 {
		values["synced_at"] = instant(now)
	}
	return counts, g.writeCalendar(ctx, conn.Sub, stored, values)
}

// EventID derives an event's id from its block's, so inserting twice can't make a duplicate. Lowercase hex is inside
// Google's id alphabet, which block ids aren't.
func EventID(blockID string) string {
	sum := sha256.Sum256([]byte(blockID))
	return hex.EncodeToString(sum[:])
}

func instant(at time.Time) string { return at.UTC().Format(instantFormat) }

func (g *Google) service(ctx context.Context, refreshToken string) (*calendar.Service, error) {
	cfg, err := g.oauthConfig(ctx)
	if err != nil {
		return nil, err
	}
	return g.serviceFor(ctx, cfg, &oauth2.Token{RefreshToken: refreshToken})
}

func (g *Google) serviceFor(ctx context.Context, cfg *oauth2.Config, token *oauth2.Token) (*calendar.Service, error) {
	opts := []option.ClientOption{option.WithHTTPClient(cfg.Client(ctx, token))}
	if g.APIURL != "" {
		opts = append(opts, option.WithEndpoint(g.APIURL))
	}
	return calendar.NewService(ctx, opts...)
}

// ensureCalendar returns the Time blocks calendar's id, creating it when there is none or the person deleted it.
func ensureCalendar(ctx context.Context, svc *calendar.Service, id string) (string, error) {
	if id != "" {
		_, err := svc.Calendars.Get(id).Context(ctx).Do()
		if err == nil {
			return id, nil
		}
		if !hasStatus(err, http.StatusNotFound) {
			return "", err
		}
	}
	created, err := svc.Calendars.Insert(&calendar.Calendar{Summary: CalendarName}).Context(ctx).Do()
	if err != nil {
		return "", err
	}
	return created.Id, nil
}

func hasStatus(err error, statuses ...int) bool {
	var apiErr *googleapi.Error
	return errors.As(err, &apiErr) && slices.Contains(statuses, apiErr.Code)
}

func fieldString(fields sync.Fields, name string) string {
	value, _ := fields[name].V.(string)
	return value
}

func isDeleted(fields sync.Fields) bool { return fields["deleted_at"].V != nil }

// desiredEvents returns the event each live block in the window should have, by event id.
//
// shortcut: this reads every block, task and practice record, which is fine for a few thousand; add an index by start
// date if runs get slow.
func (g *Google) desiredEvents(ctx context.Context, sub string, from, to time.Time) (map[string]*calendar.Event, error) {
	blocks, err := g.Records.List(ctx, sub, "time_block")
	if err != nil {
		return nil, err
	}
	titles := map[string]string{}
	for _, recordType := range []string{"task", "practice"} {
		records, err := g.Records.List(ctx, sub, recordType)
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			titles[record.Type+"#"+record.ID] = fieldString(record.Fields, "title")
		}
	}

	want := map[string]*calendar.Event{}
	for _, block := range blocks {
		start, end, ok := blockTimes(block.Fields)
		if !ok || isDeleted(block.Fields) || block.Fields["cancelled"].V == true || !end.After(from) || !start.Before(to) {
			continue
		}
		title := titles["task#"+fieldString(block.Fields, "task_id")]
		if title == "" {
			title = titles["practice#"+fieldString(block.Fields, "practice_id")]
		}
		if title == "" {
			title = fallbackTitle
		}
		id := EventID(block.ID)
		want[id] = &calendar.Event{
			Id: id, Summary: truncate(title, maxTitleRunes), Description: eventText, Status: "confirmed",
			Start:     &calendar.EventDateTime{DateTime: start.UTC().Format(time.RFC3339)},
			End:       &calendar.EventDateTime{DateTime: end.UTC().Format(time.RFC3339)},
			Reminders: &calendar.EventReminders{UseDefault: false, ForceSendFields: []string{"UseDefault"}},
		}
	}
	return want, nil
}

// blockTimes reads a block's times, with ended_at as its end. Devices write these, so a block with times that make no
// event, including one ended before it began, reports false rather than failing every run.
func blockTimes(fields sync.Fields) (start, end time.Time, ok bool) {
	start, err := time.Parse(time.RFC3339, fieldString(fields, "start"))
	if err != nil {
		return start, end, false
	}
	endField := fieldString(fields, "ended_at")
	if endField == "" {
		endField = fieldString(fields, "end")
	}
	end, err = time.Parse(time.RFC3339, endField)
	return start, end, err == nil && end.After(start)
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit])
}

func reconcile(ctx context.Context, svc *calendar.Service, calendarID string, want map[string]*calendar.Event, now, from, to time.Time, counts *runCounts) error {
	existing := map[string]*calendar.Event{}
	err := svc.Events.List(calendarID).TimeMin(from.Format(time.RFC3339)).TimeMax(to.Format(time.RFC3339)).SingleEvents(true).
		Pages(ctx, func(page *calendar.Events) error {
			for _, e := range page.Items {
				existing[e.Id] = e
			}
			return nil
		})
	if err != nil {
		return err
	}

	for _, id := range sortedKeys(want) {
		event := want[id]
		have, listed := existing[id]
		ended := !eventEnd(event).After(now)
		switch {
		case !listed && ended, listed && ended && !eventEnd(have).After(now), listed && same(have, event):
			continue
		case listed:
			if _, err := svc.Events.Update(calendarID, id, event).Context(ctx).Do(); err != nil {
				return err
			}
			counts.updated++
		default:
			_, err := svc.Events.Insert(calendarID, event).Context(ctx).Do()
			switch {
			case err == nil:
				counts.inserted++
			case hasStatus(err, http.StatusConflict):
				// The id is taken by an event outside the window, or one the person deleted, which keeps its id for good.
				if _, err := svc.Events.Update(calendarID, id, event).Context(ctx).Do(); err != nil {
					return err
				}
				counts.updated++
			default:
				return err
			}
		}
	}

	for _, id := range sortedKeys(existing) {
		if _, wanted := want[id]; wanted || !eventEnd(existing[id]).After(now) {
			continue
		}
		err := svc.Events.Delete(calendarID, id).Context(ctx).Do()
		switch {
		case err == nil:
			counts.deleted++
		case !hasStatus(err, http.StatusNotFound, http.StatusGone):
			return err
		}
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func parseEventTime(at *calendar.EventDateTime) time.Time {
	if at == nil {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, at.DateTime); err == nil {
		return t
	}
	t, _ := time.Parse(time.DateOnly, at.Date)
	return t
}

func eventEnd(e *calendar.Event) time.Time { return parseEventTime(e.End) }

// same says whether an event in Google already matches, by the fields the worker sets.
func same(have, want *calendar.Event) bool {
	if have.Summary != want.Summary || have.Description != want.Description {
		return false
	}
	if have.Start == nil || have.End == nil || have.Start.DateTime == "" || have.End.DateTime == "" {
		return false
	}
	if !parseEventTime(have.Start).Equal(parseEventTime(want.Start)) || !eventEnd(have).Equal(eventEnd(want)) {
		return false
	}
	return have.Reminders == nil || (!have.Reminders.UseDefault && len(have.Reminders.Overrides) == 0)
}

// readSources lists the person's calendars and reads the events of those not set to ignore. It returns the events for
// the calendar record and the changes to the calendar_source records: the worker owns the name, the device the mode.
func (g *Google) readSources(ctx context.Context, svc *calendar.Service, sub, ownCalendar string, from, to time.Time, counts *runCounts) ([]map[string]any, []sync.Change, error) {
	stored, err := g.Records.List(ctx, sub, "calendar_source")
	if err != nil {
		return nil, nil, err
	}
	byGoogleID := map[string]sync.Change{}
	for _, source := range stored {
		byGoogleID[fieldString(source.Fields, "google_id")] = source
	}

	var (
		events  = []map[string]any{}
		changes []sync.Change
		listed  = map[string]bool{}
	)
	err = svc.CalendarList.List().Pages(ctx, func(page *calendar.CalendarList) error {
		for _, cal := range page.Items {
			if cal.Id == ownCalendar {
				continue
			}
			listed[cal.Id] = true
			counts.sources++
			source, known := byGoogleID[cal.Id]
			values := map[string]any{}
			switch {
			case !known:
				source.ID = EventID(cal.Id)
				values = map[string]any{"google_id": cal.Id, "name": cal.Summary, "mode": "block"}
			default:
				if fieldString(source.Fields, "name") != cal.Summary {
					values["name"] = cal.Summary
				}
				if isDeleted(source.Fields) {
					values["deleted_at"] = nil
				}
			}
			if len(values) > 0 {
				changes = append(changes, g.change("calendar_source", source.ID, source.Fields, values))
			}
			if fieldString(source.Fields, "mode") == "ignore" {
				continue
			}
			read, err := readCalendar(ctx, svc, cal, from, to)
			if err != nil {
				return err
			}
			counts.read += len(read)
			events = append(events, read...)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	for _, id := range sortedKeys(byGoogleID) {
		if source := byGoogleID[id]; !listed[id] && !isDeleted(source.Fields) {
			changes = append(changes, g.change("calendar_source", source.ID, source.Fields, map[string]any{"deleted_at": instant(g.Now())}))
		}
	}
	return events, changes, nil
}

func readCalendar(ctx context.Context, svc *calendar.Service, cal *calendar.CalendarListEntry, from, to time.Time) ([]map[string]any, error) {
	zone, err := time.LoadLocation(cal.TimeZone)
	if err != nil {
		zone = time.UTC
	}
	var events []map[string]any
	err = svc.Events.List(cal.Id).TimeMin(from.Format(time.RFC3339)).TimeMax(to.Format(time.RFC3339)).SingleEvents(true).
		Pages(ctx, func(page *calendar.Events) error {
			for _, e := range page.Items {
				start, startOK := eventInstant(e.Start, zone)
				end, endOK := eventInstant(e.End, zone)
				if !startOK || !endOK {
					continue
				}
				event := map[string]any{"id": e.Id, "calendar": cal.Id, "title": truncate(e.Summary, maxTitleRunes), "start": start, "end": end}
				if e.Start.DateTime == "" {
					event["all_day"] = true
				}
				events = append(events, event)
			}
			return nil
		})
	return events, err
}

// eventInstant gives an event's time in the form devices compare as text. An all-day date is midnight in its calendar's zone.
func eventInstant(at *calendar.EventDateTime, zone *time.Location) (string, bool) {
	if at == nil {
		return "", false
	}
	if at.DateTime != "" {
		t, err := time.Parse(time.RFC3339, at.DateTime)
		return instant(t), err == nil
	}
	t, err := time.ParseInLocation(time.DateOnly, at.Date, zone)
	return instant(t), err == nil
}

// fitEvents keeps the soonest events that fit in one record, and says when some were left out.
func fitEvents(events []map[string]any) ([]any, any) {
	slices.SortFunc(events, func(a, b map[string]any) int {
		return strings.Compare(a["start"].(string)+a["id"].(string), b["start"].(string)+b["id"].(string))
	})
	kept, size := []any{}, 0
	for _, event := range events {
		encoded, _ := json.Marshal(event)
		size += len(encoded) + 1
		if size > maxEventBytes {
			return kept, ErrorTooManyEvents
		}
		kept = append(kept, event)
	}
	return kept, nil
}

func (g *Google) calendarRecord(ctx context.Context, sub string) (sync.Fields, error) {
	records, err := g.Records.List(ctx, sub, "calendar")
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		if record.ID == CalendarRecordID {
			return record.Fields, nil
		}
	}
	return nil, nil
}

// writeCalendar writes the fields that differ from what's stored, plus anything never written yet.
func (g *Google) writeCalendar(ctx context.Context, sub string, stored sync.Fields, values map[string]any) error {
	changed := changedFields(stored, values)
	if len(changed) == 0 {
		return nil
	}
	_, err := g.Records.Push(ctx, sub, 0, []sync.Change{g.change("calendar", CalendarRecordID, stored, changed)})
	return err
}

func changedFields(stored sync.Fields, values map[string]any) map[string]any {
	changed := map[string]any{}
	for name, value := range values {
		if field, ok := stored[name]; !ok || !reflect.DeepEqual(field.V, value) {
			changed[name] = value
		}
	}
	return changed
}

var clockWall = regexp.MustCompile(`^\d{13}`)

// change builds a write that wins over what's stored even if a device with a clock ahead of this one wrote there, which
// would otherwise freeze the field until real time caught up.
func (g *Google) change(recordType, id string, stored sync.Fields, values map[string]any) sync.Change {
	wall := g.Now().UnixMilli()
	for name := range values {
		if digits := clockWall.FindString(stored[name].C); digits != "" {
			if ms, err := strconv.ParseInt(digits, 10, 64); err == nil && ms >= wall {
				wall = ms + 1
			}
		}
	}
	clock := fmt.Sprintf("%013d-000000-%s", wall, clockDevice)
	fields := make(sync.Fields, len(values))
	for name, value := range values {
		fields[name] = sync.Field{V: value, C: clock}
	}
	return sync.Change{Type: recordType, ID: id, Fields: fields}
}

func (g *Google) recordFailure(ctx context.Context, conn connection, code string) error {
	if still, err := g.stillConnected(ctx, conn); err != nil || !still {
		return err
	}
	stored, err := g.calendarRecord(ctx, conn.Sub)
	if err != nil {
		return err
	}
	values := map[string]any{"last_error": code}
	if code == ErrorRevoked {
		values["connected"] = false
	}
	return g.writeCalendar(ctx, conn.Sub, stored, values)
}

func errorCode(err error) string {
	var retrieve *oauth2.RetrieveError
	if errors.As(err, &retrieve) && retrieve.ErrorCode == "invalid_grant" {
		return ErrorRevoked
	}
	var apiErr *googleapi.Error
	if !errors.As(err, &apiErr) {
		return ErrorFailed
	}
	switch apiErr.Code {
	case http.StatusUnauthorized:
		return ErrorRevoked
	case http.StatusTooManyRequests:
		return ErrorRateLimited
	case http.StatusForbidden:
		for _, item := range apiErr.Errors {
			if item.Reason == "rateLimitExceeded" || item.Reason == "userRateLimitExceeded" {
				return ErrorRateLimited
			}
		}
	}
	return ErrorFailed
}
