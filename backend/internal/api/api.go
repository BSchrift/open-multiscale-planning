// Package api holds the HTTP handlers, shared by the Lambda and the local server. The gateway in front has already
// checked the token by the time a request gets here; each front end passes the sub it found through WithSub.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
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

// ErrInvalidState is what Calendar.Callback returns for a state it won't honour.
var ErrInvalidState = errors.New("api: invalid state")

// Server is every route of the API. A nil Calendar answers its routes with 501.
type Server struct {
	Sync     Syncer
	Calendar Calendar
	Log      *slog.Logger
	Env      string
	Now      func() time.Time
}

type contextKey int

const (
	subKey contextKey = iota
	requestIDKey
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

// Handler returns the routes. A route that needs a user refuses a request with none, so a front end that forgets to
// verify tokens fails closed.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	route := func(pattern string, protected bool, h handler) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			start := s.Now()
			sub := SubFrom(r.Context())
			var out outcome
			if protected && sub == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "Unauthorized"})
				out = outcome{status: http.StatusUnauthorized, errorType: "unauthorized"}
			} else {
				out = h(w, r, sub)
			}
			s.logRequest(r.Context(), pattern, sub, start, out)
		})
	}
	route("POST /sync", true, s.sync)
	route("POST /calendar/connect", true, s.calendarConnect)
	route("GET /calendar/callback", false, s.calendarCallback)
	route("POST /calendar/refresh", true, s.calendarRefresh)
	route("POST /calendar/disconnect", true, s.calendarDisconnect)
	route("POST /v1/logs", true, s.telemetry)
	return mux
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
	writeJSON(w, http.StatusOK, res)
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
