// Package api holds the HTTP handlers, shared by the Lambda and the local server. The gateway in front has already
// checked the token by the time a request gets here; each front end passes the sub it found through WithSub.
package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/files"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

// Syncer is what POST /sync needs. *sync.Store implements it.
type Syncer interface {
	Sync(ctx context.Context, sub string, req sync.Request) (sync.Response, sync.Stats, error)
}

// Calendar is the Google connection behind the /calendar routes.
type Calendar interface {
	// Connect returns the Google consent URL for this user.
	Connect(ctx context.Context, sub string) (string, error)
	// Callback finishes a consent from Google's redirect. It returns ErrInvalidState for a state that is forged, expired
	// or used. The state, not a token, says who it is for.
	Callback(ctx context.Context, state, code string) error
	// Refresh runs the calendar worker for this user.
	Refresh(ctx context.Context, sub string) error
	// Disconnect ends this user's connection to Google.
	Disconnect(ctx context.Context, sub string) error
}

// Files is the attachments' storage behind the /files routes. *files.Service implements it.
type Files interface {
	GrantUpload(ctx context.Context, sub, id string) (files.Upload, error)
	GrantDownloads(ctx context.Context, sub string, ids []string) (files.Downloads, error)
	Usage(ctx context.Context, sub string) (files.Usage, error)
}

// Account is the caller's own account behind the /account routes. *account.Service implements it.
type Account interface {
	StartExport(ctx context.Context, sub string) (account.ExportState, error)
	Export(ctx context.Context, sub string) (account.ExportState, error)
	Delete(ctx context.Context, sub string) error
	Deleted(ctx context.Context, sub string) (bool, error)
	Gone(ctx context.Context, sub string) (bool, error)
}

// Tokens reads who a sign-in token was issued to, whether or not it has lapsed. *account.Tokens implements it.
type Tokens interface {
	Subject(ctx context.Context, token string) (string, bool)
}

// ErrInvalidState is what Calendar.Callback returns for a state it won't honour.
var ErrInvalidState = errors.New("api: invalid state")

// ErrAccountTaken is what Calendar.Callback returns for a Google account another person has connected.
var ErrAccountTaken = errors.New("api: Google account connected to someone else")

// ErrScopesMissing is what Calendar.Callback returns for a consent with a permission unticked.
var ErrScopesMissing = errors.New("api: consent left out a permission")

// Server is every route of the API. A nil Calendar, Files or Account answers its routes with 501.
type Server struct {
	Sync     Syncer
	Calendar Calendar
	Files    Files
	Account  Account
	Tokens   Tokens
	Log      *slog.Logger
	Env      string
	Now      func() time.Time
}

type contextKey int

const (
	subKey contextKey = iota
	requestIDKey
	authTimeKey
)

// WithSub marks a request as coming from the user the gateway verified.
func WithSub(ctx context.Context, sub string) context.Context {
	return context.WithValue(ctx, subKey, sub)
}

// SubFrom returns the verified user, or "" if there is none.
func SubFrom(ctx context.Context) string {
	sub, _ := ctx.Value(subKey).(string)
	return sub
}

// WithAuthTime marks when the verified user last signed in, from the token's auth_time claim, which a refresh keeps.
func WithAuthTime(ctx context.Context, at time.Time) context.Context {
	return context.WithValue(ctx, authTimeKey, at)
}

// AuthTimeFrom is when the verified user last signed in, or zero if the token didn't say.
func AuthTimeFrom(ctx context.Context) time.Time {
	at, _ := ctx.Value(authTimeKey).(time.Time)
	return at
}

// AuthTimeClaim reads a token's auth_time claim as the gateway passes it on: seconds since the epoch, as text.
func AuthTimeClaim(claim string) (time.Time, bool) {
	seconds, err := strconv.ParseInt(claim, 10, 64)
	if err != nil || seconds <= 0 {
		return time.Time{}, false
	}
	return time.Unix(seconds, 0), true
}

// WithRequestID sets the id logged with a request.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// outcome is what a handler reports for the request's log line.
type outcome struct {
	status    int
	errorType string
	attrs     []any
}

type handler func(w http.ResponseWriter, r *http.Request, sub string) outcome

// access is who may use a route, and whether its log line names them.
type access int

const (
	// public routes prove who they're for some other way, or not at all.
	public access = iota
	// signedIn routes need the user the gateway verified, and their log lines carry its hash.
	signedIn
	// unnamed routes are signedIn ones whose log lines carry a count, never who: the account routes.
	unnamed
)

// Handler returns the routes. A route that needs a user refuses a request with none, so a front end that forgets to
// verify tokens fails closed.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	route := func(pattern string, who access, h handler) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			start := s.Now()
			sub := SubFrom(r.Context())
			var out outcome
			if who != public && sub == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "Unauthorized"})
				out = outcome{status: http.StatusUnauthorized, errorType: "unauthorized"}
			} else {
				out = h(w, r, sub)
			}
			named := sub
			if who == unnamed {
				named = ""
			}
			s.logRequest(r.Context(), pattern, named, start, out)
		})
	}
	route("POST /sync", signedIn, s.sync)
	route("POST /calendar/connect", signedIn, s.live(s.calendarConnect))
	route("GET /calendar/callback", public, s.calendarCallback)
	route("POST /calendar/refresh", signedIn, s.live(s.calendarRefresh))
	route("POST /calendar/disconnect", signedIn, s.live(s.calendarDisconnect))
	route("POST /v1/logs", signedIn, s.live(s.telemetry))
	route("POST /files/upload", signedIn, s.live(s.filesUpload))
	route("POST /files/download", signedIn, s.live(s.filesDownload))
	route("GET /files/usage", signedIn, s.live(s.filesUsage))
	route("POST /account/export", unnamed, s.live(s.exportStart))
	route("GET /account/export", unnamed, s.live(s.exportState))
	route("POST /account/delete", unnamed, s.accountDelete)
	// A device whose token has lapsed asks whether its account was deleted: the token's signature says who's asking.
	route("POST /account/status", public, s.accountStatus)
	return mux
}

// live refuses an account being deleted, so a device that still holds a good token can't write anything back, such as
// a calendar consent or a file. /sync refuses it in the store, from the read it makes anyway.
func (s *Server) live(h handler) handler {
	return func(w http.ResponseWriter, r *http.Request, sub string) outcome {
		if s.Account == nil {
			return h(w, r, sub)
		}
		deleted, err := s.Account.Deleted(r.Context(), sub)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
			return outcome{status: http.StatusInternalServerError, errorType: "internal", attrs: sync.ErrorAttrs(err)}
		}
		if deleted {
			return accountDeleted(w)
		}
		return h(w, r, sub)
	}
}

func (s *Server) logRequest(ctx context.Context, route, sub string, start time.Time, out outcome) {
	requestID, _ := ctx.Value(requestIDKey).(string)
	attrs := []any{
		"request_id", requestID, "route", route, "status", out.status, "duration_ms", s.Now().Sub(start).Milliseconds(),
	}
	if sub != "" {
		attrs = append(attrs, "user", obs.HashSub(sub))
	}
	if out.errorType != "" {
		attrs = append(attrs, "error_type", out.errorType)
	}
	s.Log.Info("request", append(attrs, out.attrs...)...)
}

func (s *Server) sync(w http.ResponseWriter, r *http.Request, sub string) outcome {
	var stats sync.Stats
	changes := 0
	finish := func(status int, errorType string) outcome {
		rejected := 0
		if status >= 400 && status < 500 && errorType != "conflict" {
			rejected = 1
		}
		// Only a write reports the size, so its Maximum is the largest writing user's. A 0 would read as an empty one.
		var sizes []obs.GB
		if stats.ItemCollectionGB > 0 {
			sizes = append(sizes, obs.GB{Name: "ItemCollectionSizeGB", Value: stats.ItemCollectionGB})
		}
		attrs := []any{"changes", changes, "pulled", stats.Pulled, "dropped", stats.Dropped}
		if stats.ExpiryReset {
			attrs = append(attrs, "reset", sync.ResetExpired)
		}
		return outcome{status: status, errorType: errorType, attrs: append(
			attrs,
			obs.Metrics(s.Env, s.Now(), map[string]int{
				"SyncRecordsMerged":    stats.Merged,
				"SyncConflictRetries":  stats.Retries,
				"SyncRequestsRejected": rejected,
			}, sizes...)...,
		)}
	}
	fail := func(err error) outcome {
		var rejection *sync.Rejection
		switch {
		case errors.As(err, &rejection):
			writeJSON(w, rejection.Status, map[string]string{"error": rejection.Code})
			return finish(rejection.Status, rejection.Code)
		case errors.Is(err, sync.ErrAccountDeleted):
			return finish(accountDeleted(w).status, "account_deleted")
		case errors.Is(err, sync.ErrConflict):
			// 409, not 503: a designed "send it again" (devices resend on their next sync) must stay out of the 5xx alarm.
			writeJSON(w, http.StatusConflict, map[string]string{"error": "conflict"})
			return finish(http.StatusConflict, "conflict")
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		out := finish(http.StatusInternalServerError, "internal")
		out.attrs = append(out.attrs, sync.ErrorAttrs(err)...)
		return out
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, int64(sync.MaxBodyBytes)))
	if err != nil {
		return fail(sync.RejectedBodyTooLarge)
	}
	req, err := sync.ParseRequest(body, s.Now())
	if err != nil {
		return fail(err)
	}
	changes = len(req.Changes)
	var res sync.Response
	res, stats, err = s.Sync.Sync(r.Context(), sub, req)
	if err != nil {
		return fail(err)
	}
	writeGzippable(w, r, http.StatusOK, res)
	return finish(http.StatusOK, "")
}

func (s *Server) calendarConnect(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Calendar == nil {
		return notImplemented(w)
	}
	url, err := s.Calendar.Connect(r.Context(), sub)
	if err != nil {
		return calendarFailed(w)
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
	return outcome{status: http.StatusOK}
}

func (s *Server) calendarCallback(w http.ResponseWriter, r *http.Request, _ string) outcome {
	if s.Calendar == nil {
		return notImplemented(w)
	}
	q := r.URL.Query()
	state, code := q.Get("state"), q.Get("code")
	if state == "" || code == "" {
		return callbackPage(w, http.StatusBadRequest, "invalid_callback", "Calendar not connected.")
	}
	err := s.Calendar.Callback(r.Context(), state, code)
	switch {
	case errors.Is(err, ErrInvalidState):
		return callbackPage(w, http.StatusBadRequest, "invalid_state", "Calendar not connected.")
	case errors.Is(err, ErrScopesMissing):
		return callbackPage(w, http.StatusBadRequest, "google_scopes_missing",
			"Calendar not connected. Leave every permission Google asks for ticked, then connect again.")
	case errors.Is(err, ErrAccountTaken):
		return callbackPage(w, http.StatusConflict, "google_account_taken",
			"Calendar not connected. This Google account is connected to another Multiscale account. Disconnect it there, or connect a different Google account.")
	case err != nil:
		return callbackPage(w, http.StatusBadGateway, "calendar_failed", "Calendar not connected.")
	}
	return callbackPage(w, http.StatusOK, "", "Calendar connected. You can close this window.")
}

func (s *Server) calendarRefresh(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Calendar == nil {
		return notImplemented(w)
	}
	if err := s.Calendar.Refresh(r.Context(), sub); err != nil {
		return calendarFailed(w)
	}
	w.WriteHeader(http.StatusNoContent)
	return outcome{status: http.StatusNoContent}
}

func (s *Server) calendarDisconnect(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Calendar == nil {
		return notImplemented(w)
	}
	if err := s.Calendar.Disconnect(r.Context(), sub); err != nil {
		return calendarFailed(w)
	}
	w.WriteHeader(http.StatusNoContent)
	return outcome{status: http.StatusNoContent}
}

// maxFilesBodyBytes bounds a /files request, which holds at most a few ids.
const maxFilesBodyBytes = 16 << 10

// filesUpload grants an upload for an attachment the caller synced. The body names only the attachment: its size, type
// and hash are read from the synced record.
func (s *Server) filesUpload(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Files == nil {
		return filesNotConfigured(w)
	}
	var body struct {
		ID string `json:"id"`
	}
	if !readFilesBody(w, r, &body) {
		return filesFailed(w, files.ErrInvalidRequest)
	}
	upload, err := s.Files.GrantUpload(r.Context(), sub, body.ID)
	if err != nil {
		return filesFailed(w, err)
	}
	writeJSON(w, http.StatusOK, upload)
	return outcome{status: http.StatusOK}
}

func (s *Server) filesDownload(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Files == nil {
		return filesNotConfigured(w)
	}
	var body struct {
		IDs []string `json:"ids"`
	}
	if !readFilesBody(w, r, &body) {
		return filesFailed(w, files.ErrInvalidRequest)
	}
	downloads, err := s.Files.GrantDownloads(r.Context(), sub, body.IDs)
	if err != nil {
		return filesFailed(w, err)
	}
	writeJSON(w, http.StatusOK, downloads)
	return outcome{status: http.StatusOK}
}

func (s *Server) filesUsage(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Files == nil {
		return filesNotConfigured(w)
	}
	usage, err := s.Files.Usage(r.Context(), sub)
	if err != nil {
		return filesFailed(w, err)
	}
	writeJSON(w, http.StatusOK, usage)
	return outcome{status: http.StatusOK}
}

func readFilesBody(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFilesBodyBytes))
	return err == nil && json.Unmarshal(raw, into) == nil
}

// filesFailed answers a refusal with its code, and the hour it lifts or the usage that caused it. Its log line carries
// the code alone, and an internal error's AWS codes.
func filesFailed(w http.ResponseWriter, err error) outcome {
	var refusal *files.Refusal
	switch {
	case errors.As(err, &refusal):
		body := map[string]any{"error": refusal.Code}
		if !refusal.RetryAt.IsZero() {
			body["retry_at"] = refusal.RetryAt.UTC().Format(time.RFC3339)
		}
		if refusal.Usage != nil {
			body["used_bytes"], body["quota_bytes"] = refusal.Usage.UsedBytes, refusal.Usage.QuotaBytes
		}
		writeJSON(w, refusal.Status, body)
		return outcome{status: refusal.Status, errorType: refusal.Code}
	case errors.Is(err, files.ErrBusy):
		// 409, as sync's: asking again is safe, and a designed retry stays out of the 5xx alarm.
		writeJSON(w, http.StatusConflict, map[string]string{"error": "conflict"})
		return outcome{status: http.StatusConflict, errorType: "conflict"}
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
	return outcome{status: http.StatusInternalServerError, errorType: "internal", attrs: sync.ErrorAttrs(err)}
}

func filesNotConfigured(w http.ResponseWriter) outcome {
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "files_not_configured"})
	return outcome{status: http.StatusNotImplemented, errorType: "files_not_configured"}
}

// accountDeleted answers a deleted account's device. 401, so an app from before this signs out as for any refused token:
// its refresh then fails too, since the sign-in is gone. An app that knows the code wipes its copy.
func accountDeleted(w http.ResponseWriter) outcome {
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "account_deleted"})
	return outcome{status: http.StatusUnauthorized, errorType: "account_deleted"}
}

func (s *Server) exportStart(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Account == nil {
		return accountNotConfigured(w)
	}
	state, err := s.Account.StartExport(r.Context(), sub)
	return exportAnswer(w, http.StatusAccepted, state, err)
}

func (s *Server) exportState(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Account == nil {
		return accountNotConfigured(w)
	}
	state, err := s.Account.Export(r.Context(), sub)
	return exportAnswer(w, http.StatusOK, state, err)
}

func exportAnswer(w http.ResponseWriter, status int, state account.ExportState, err error) outcome {
	switch {
	case errors.Is(err, account.ErrNoFiles):
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "export_not_configured"})
		return outcome{status: http.StatusNotImplemented, errorType: "export_not_configured"}
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return outcome{status: http.StatusInternalServerError, errorType: "internal", attrs: sync.ErrorAttrs(err)}
	}
	writeJSON(w, status, state)
	return outcome{status: status, attrs: []any{"export", state.State}}
}

// maxSignInAge is how recent a sign-in deleting an account takes.
var maxSignInAge = time.Duration(appconfig.Protocol.Account.MaxSignInAgeMinutes) * time.Minute

// deleteConfirmation is what the app sends once the person has typed it, so a stray request deletes nothing.
const deleteConfirmation = "DELETE"

// accountDelete starts deleting the caller's account, after a sign-in of the last few minutes. Asking again while it's
// under way answers the same and starts nothing more, so a lost answer can be asked for again.
func (s *Server) accountDelete(w http.ResponseWriter, r *http.Request, sub string) outcome {
	if s.Account == nil {
		return accountNotConfigured(w)
	}
	var body struct {
		Confirm string `json:"confirm"`
		// Sub is the account the app means to delete: the one its data belongs to.
		Sub string `json:"sub"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFilesBodyBytes))
	if err != nil || json.Unmarshal(raw, &body) != nil || body.Confirm != deleteConfirmation {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return outcome{status: http.StatusBadRequest, errorType: "invalid_request"}
	}
	// Signed in again as another account than the one the app holds: that one isn't the person's to delete here.
	if body.Sub != sub {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "wrong_account"})
		return outcome{status: http.StatusConflict, errorType: "wrong_account"}
	}
	signedInAt := AuthTimeFrom(r.Context())
	if signedInAt.IsZero() || s.Now().Sub(signedInAt) > maxSignInAge {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "sign_in_again"})
		return outcome{status: http.StatusForbidden, errorType: "sign_in_again"}
	}
	deleted, err := s.Account.Deleted(r.Context(), sub)
	if err == nil && !deleted {
		err = s.Account.Delete(r.Context(), sub)
	}
	if errors.Is(err, account.ErrProtected) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "protected_account"})
		return outcome{status: http.StatusForbidden, errorType: "protected_account"}
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return outcome{status: http.StatusInternalServerError, errorType: "internal", attrs: sync.ErrorAttrs(err)}
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"state": "deleting"})
	if deleted {
		return outcome{status: http.StatusAccepted}
	}
	return outcome{status: http.StatusAccepted, attrs: obs.Metrics(s.Env, s.Now(), map[string]int{"AccountDeletionsStarted": 1})}
}

// accountStatus tells a device whose token has lapsed whether its account was deleted, so it wipes its copy rather than
// waiting to sign in again. The token's signature proves it was issued to the account asked about.
func (s *Server) accountStatus(w http.ResponseWriter, r *http.Request, _ string) outcome {
	if s.Account == nil || s.Tokens == nil {
		return accountNotConfigured(w)
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	var sub string
	if ok {
		sub, ok = s.Tokens.Subject(r.Context(), token)
	}
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
		return outcome{status: http.StatusUnauthorized, errorType: "invalid_token"}
	}
	gone, err := s.Account.Gone(r.Context(), sub)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return outcome{status: http.StatusInternalServerError, errorType: "internal", attrs: sync.ErrorAttrs(err)}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": gone})
	return outcome{status: http.StatusOK}
}

func accountNotConfigured(w http.ResponseWriter) outcome {
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "account_not_configured"})
	return outcome{status: http.StatusNotImplemented, errorType: "account_not_configured"}
}

func callbackPage(w http.ResponseWriter, status int, errorType, text string) outcome {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	io.WriteString(w, text)
	return outcome{status: status, errorType: errorType}
}

func notImplemented(w http.ResponseWriter) outcome {
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "calendar_not_configured"})
	return outcome{status: http.StatusNotImplemented, errorType: "calendar_not_configured"}
}

func calendarFailed(w http.ResponseWriter) outcome {
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "calendar_failed"})
	return outcome{status: http.StatusBadGateway, errorType: "calendar_failed"}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

// gzipMinBytes is the smallest body worth gzipping: below it, gzip's own header and the work cost more than they save.
const gzipMinBytes = 1024

// writeGzippable is writeJSON gzipped, at the default level, when the body is over gzipMinBytes and the request takes
// gzip. A page of a first sync is up to 2 MB of JSON, which gzip makes about eight times smaller. Browsers, Electron and
// the iPhone's web view all ask for gzip and unpack it before the app sees the body, so no app changes; a client that
// doesn't ask gets JSON as before.
func writeGzippable(w http.ResponseWriter, r *http.Request, status int, body any) {
	var buf bytes.Buffer
	json.NewEncoder(&buf).Encode(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Vary", "Accept-Encoding")
	if buf.Len() <= gzipMinBytes || !takesGzip(r.Header.Values("Accept-Encoding")) {
		w.WriteHeader(status)
		w.Write(buf.Bytes())
		return
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.WriteHeader(status)
	zw := gzip.NewWriter(w)
	zw.Write(buf.Bytes())
	zw.Close()
}

// takesGzip is whether Accept-Encoding lists gzip, other than as refused with q=0.
func takesGzip(values []string) bool {
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			name, params, _ := strings.Cut(part, ";")
			if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
				continue
			}
			if q, ok := strings.CutPrefix(strings.ReplaceAll(params, " ", ""), "q="); ok {
				if weight, err := strconv.ParseFloat(q, 64); err == nil && weight == 0 {
					return false
				}
			}
			return true
		}
	}
	return false
}
