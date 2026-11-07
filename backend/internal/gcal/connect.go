package gcal

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

const (
	// The names of the secrets under a deployment's prefix.
	SecretClientID     = "google/client-id"
	SecretClientSecret = "google/client-secret"
	SecretState        = "google/state-secret"
	SecretRefreshToken = "google/refresh-token"

	// StateTTL is how long a consent link works.
	StateTTL = 10 * time.Minute

	GoogleAuthURL   = "https://accounts.google.com/o/oauth2/auth"
	GoogleTokenURL  = "https://oauth2.googleapis.com/token"
	GoogleRevokeURL = "https://oauth2.googleapis.com/revoke"
)

// Scopes are the narrowest that do the job: making and managing Time blocks, reading other calendars' events, and listing calendars.
var Scopes = []string{
	"https://www.googleapis.com/auth/calendar.app.created",
	"https://www.googleapis.com/auth/calendar.events.readonly",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
}

// ErrNoSecret is what Secrets.Get returns for a secret that isn't set.
var ErrNoSecret = errors.New("gcal: secret not set")

// Secrets holds the Google client secret, the state key and the connection.
type Secrets interface {
	Get(ctx context.Context, name string) (string, error)
	Put(ctx context.Context, name, value string) error
	// Delete removes a secret, and succeeds when it isn't set.
	Delete(ctx context.Context, name string) error
}

// States remembers the one consent a user may finish, which is what makes a state single-use.
type States interface {
	Put(ctx context.Context, sub, nonce string) error
	// Consume reports whether nonce was the one to finish, and uses it up if so.
	Consume(ctx context.Context, sub, nonce string) (bool, error)
}

// connection is the stored form of the refresh token. The user is with it because a scheduled run has no request to say who it is for.
//
// shortcut: each deployment connects one Google account; store a token per user if this ever has several.
type connection struct {
	RefreshToken string `json:"refresh_token"`
	Sub          string `json:"sub"`
}

func (g *Google) connection(ctx context.Context) (connection, error) {
	var conn connection
	raw, err := g.Secrets.Get(ctx, SecretRefreshToken)
	if err != nil {
		return conn, err
	}
	if err := json.Unmarshal([]byte(raw), &conn); err != nil {
		// The error text could quote the secret.
		return conn, errors.New("gcal: stored connection is malformed")
	}
	return conn, nil
}

func (g *Google) oauthConfig(ctx context.Context) (*oauth2.Config, error) {
	id, err := g.Secrets.Get(ctx, SecretClientID)
	if err != nil {
		return nil, fmt.Errorf("gcal: client id: %w", err)
	}
	secret, err := g.Secrets.Get(ctx, SecretClientSecret)
	if err != nil {
		return nil, fmt.Errorf("gcal: client secret: %w", err)
	}
	return &oauth2.Config{
		ClientID: id, ClientSecret: secret, RedirectURL: g.RedirectURL, Scopes: Scopes,
		Endpoint: oauth2.Endpoint{AuthURL: g.AuthURL, TokenURL: g.TokenURL},
	}, nil
}

type stateClaims struct {
	Sub     string `json:"sub"`
	Nonce   string `json:"nonce"`
	Expires int64  `json:"exp"`
}

func signState(key, payload string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Connect returns the consent URL. Starting a new consent cancels any earlier one.
func (g *Google) Connect(ctx context.Context, sub string) (string, error) {
	cfg, err := g.oauthConfig(ctx)
	if err != nil {
		return "", err
	}
	key, err := g.Secrets.Get(ctx, SecretState)
	if err != nil {
		return "", fmt.Errorf("gcal: state key: %w", err)
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	nonce := hex.EncodeToString(random)
	if err := g.States.Put(ctx, sub, nonce); err != nil {
		return "", err
	}
	claims, err := json.Marshal(stateClaims{sub, nonce, g.Now().Add(StateTTL).Unix()})
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(claims)
	// prompt=consent because Google only returns a refresh token on a fresh consent.
	return cfg.AuthCodeURL(payload+"."+signState(key, payload), oauth2.AccessTypeOffline, oauth2.ApprovalForce), nil
}

// verifyState checks the signature and age and uses the state up, in that order so a forged state can't cancel a real one.
func (g *Google) verifyState(ctx context.Context, state string) (string, error) {
	key, err := g.Secrets.Get(ctx, SecretState)
	if err != nil {
		return "", fmt.Errorf("gcal: state key: %w", err)
	}
	payload, signature, ok := strings.Cut(state, ".")
	if !ok || !hmac.Equal([]byte(signature), []byte(signState(key, payload))) {
		return "", api.ErrInvalidState
	}
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return "", api.ErrInvalidState
	}
	var claims stateClaims
	if err := json.Unmarshal(decoded, &claims); err != nil || claims.Sub == "" {
		return "", api.ErrInvalidState
	}
	if g.Now().Unix() > claims.Expires {
		return "", api.ErrInvalidState
	}
	fresh, err := g.States.Consume(ctx, claims.Sub, claims.Nonce)
	if err != nil {
		return "", err
	}
	if !fresh {
		return "", api.ErrInvalidState
	}
	return claims.Sub, nil
}

// Callback finishes a consent: it stores the token, makes sure Time blocks exists, and starts a run.
func (g *Google) Callback(ctx context.Context, state, code string) error {
	sub, err := g.verifyState(ctx, state)
	if err != nil {
		return err
	}
	cfg, err := g.oauthConfig(ctx)
	if err != nil {
		return err
	}
	token, err := cfg.Exchange(ctx, code)
	if err != nil {
		return err
	}
	if token.RefreshToken == "" {
		return errors.New("gcal: consent returned no refresh token")
	}
	svc, err := g.serviceFor(ctx, cfg, token)
	if err != nil {
		return err
	}
	stored, err := g.calendarRecord(ctx, sub)
	if err != nil {
		return err
	}
	existing, _ := stored["calendar_id"].V.(string)
	calendarID, err := ensureCalendar(ctx, svc, existing)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(connection{RefreshToken: token.RefreshToken, Sub: sub})
	if err != nil {
		return err
	}
	// There is one connection, so another user's consent takes it over. Their app is told before it's replaced, so a
	// failure here leaves nothing replaced unannounced. Their Google access is left alone: it's theirs to remove.
	previous, err := g.connection(ctx)
	if err != nil && !errors.Is(err, ErrNoSecret) {
		return err
	}
	if previous.Sub != "" && previous.Sub != sub {
		theirs, err := g.calendarRecord(ctx, previous.Sub)
		if err != nil {
			return err
		}
		if err := g.writeCalendar(ctx, previous.Sub, theirs, disconnected()); err != nil {
			return err
		}
	}
	if err := g.Secrets.Put(ctx, SecretRefreshToken, string(encoded)); err != nil {
		return err
	}
	if err := g.writeCalendar(ctx, sub, stored, map[string]any{"connected": true, "calendar_id": calendarID, "last_error": nil}); err != nil {
		return err
	}
	// A first run that can't start now still happens at the next schedule, so this isn't worth failing a good consent.
	_ = g.Trigger(ctx)
	return nil
}

// Refresh starts a run for the connected user. It does nothing for anyone else, so another signed-in user, such as a
// test user on a deployment, can't run the worker over the real account.
func (g *Google) Refresh(ctx context.Context, sub string) error {
	conn, err := g.connection(ctx)
	if errors.Is(err, ErrNoSecret) || (err == nil && conn.Sub != sub) {
		return nil
	}
	if err != nil {
		return err
	}
	return g.Trigger(ctx)
}

// Disconnect ends the connection: Google's access is revoked, Time blocks is removed from Google, and the app shows it
// unconnected. Like Refresh, it leaves the connection alone for anyone but the connected user.
func (g *Google) Disconnect(ctx context.Context, sub string) error {
	conn, err := g.connection(ctx)
	if err != nil && !errors.Is(err, ErrNoSecret) {
		return err
	}
	stored, err := g.calendarRecord(ctx, sub)
	if err != nil {
		return err
	}
	if conn.Sub != "" && conn.Sub == sub {
		// Best effort with Google: access already removed there, or Time blocks already deleted, still disconnects here.
		failed := []string{}
		if id := fieldString(stored, "calendar_id"); id != "" {
			svc, err := g.service(ctx, conn.RefreshToken)
			if err == nil {
				err = svc.Calendars.Delete(id).Context(ctx).Do()
			}
			if err != nil && !hasStatus(err, http.StatusNotFound, http.StatusGone) && errorCode(err) != ErrorRevoked {
				failed = append(failed, "delete_calendar")
			}
		}
		if err := g.revoke(ctx, conn.RefreshToken); err != nil {
			failed = append(failed, "revoke")
		}
		g.Log.Info("calendar_disconnect", "user", obs.HashSub(sub), "google_failed", failed)
		if err := g.Secrets.Delete(ctx, SecretRefreshToken); err != nil {
			return err
		}
	}
	return g.writeCalendar(ctx, sub, stored, disconnected())
}

// disconnected is how the calendar record shows no connection.
func disconnected() map[string]any {
	return map[string]any{"connected": false, "calendar_id": nil, "events": []any{}, "last_error": nil}
}

// revoke asks Google to stop honouring a refresh token. Google answers 400 for one it already doesn't.
func (g *Google) revoke(ctx context.Context, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.RevokeURL, strings.NewReader(url.Values{"token": {token}}.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusBadRequest {
		return fmt.Errorf("gcal: revoke answered %d", res.StatusCode)
	}
	return nil
}
