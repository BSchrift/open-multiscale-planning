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
	"slices"
	"strings"
	"time"

	"github.com/aws/smithy-go"
	"golang.org/x/oauth2"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

const (
	// The names of the secrets under a deployment's prefix.
	SecretClientID     = "google/client-id"
	SecretClientSecret = "google/client-secret"
	SecretState        = "google/state-secret"
	// SecretRefreshToken is the deployment's one connection from before each person had their own, which the migration
	// release copied to its person's own. It is read only to delete it.
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

// ErrNotConnected is what Connections.Get returns for a person with no connection of their own.
var ErrNotConnected = errors.New("gcal: not connected")

// errUnreadable is what Connections.Get returns for a stored token that will never open: sealed for someone else, or by
// another key. Not KMS being unreachable or throttled, which a later run gets past.
var errUnreadable = errors.New("gcal: the connection doesn't open")

// errConnectionChanged is what Connections.Delete returns when the connection was replaced since it was read.
var errConnectionChanged = errors.New("gcal: the connection changed")

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

// connection is one person's Google connection: the refresh token the worker uses for them, and whose it is. The JSON is
// the legacy secret's form.
type connection struct {
	RefreshToken string `json:"refresh_token"`
	Sub          string `json:"sub"`
	// Account names the Google account, by accountID, so that one Google account connects to one person. Empty in the
	// legacy secret.
	Account string `json:"-"`
	// Revoked is set once Google refused the token: their runs stop until they connect again or disconnect.
	Revoked bool `json:"-"`
	// sealed is the stored, encrypted token as read, so a change can be made only to the connection that was read.
	sealed []byte
	// legacy marks the deployment's one connection from before, read from SecretRefreshToken.
	legacy bool
}

// Connections keeps each person's connection, with its refresh token encrypted for them alone. DynamoConnections is the
// deployed one.
type Connections interface {
	// Peek returns sub's own connection without opening its token: its account, whether Google refused it, and what's
	// stored, for a change to that connection alone. It returns ErrNotConnected for none.
	Peek(ctx context.Context, sub string) (connection, error)
	// Get returns sub's own connection with its token, or ErrNotConnected.
	Get(ctx context.Context, sub string) (connection, error)
	// Holder returns who holds a Google account's connection, or "" for no one.
	Holder(ctx context.Context, account string) (string, error)
	// Put stores conn as its person's connection, claiming its Google account and releasing previous's, only if what's
	// stored is still previous, as Peek read it, or nothing for a zero previous. It returns errConnectionChanged if not,
	// and api.ErrAccountTaken when someone else holds the account.
	Put(ctx context.Context, conn connection, previous connection) error
	// MarkRevoked records that Google refused conn's token, if conn is still what's stored.
	MarkRevoked(ctx context.Context, conn connection) error
	// Delete removes conn and releases its account. It succeeds when there's nothing to remove, and returns
	// errConnectionChanged when conn was replaced since it was read, leaving the new one.
	Delete(ctx context.Context, conn connection) error
	// Has reports whether sub has a connection of their own that Google hasn't refused, without opening it.
	Has(ctx context.Context, sub string) (bool, error)
	// Each calls fn with the sub of every person with a connection of their own that Google hasn't refused.
	Each(ctx context.Context, fn func(sub string) error) error
}

// accountID names a Google account by a hash of its address, which is what its primary calendar's id is. A hash, so the
// table holds no address.
//
// shortcut: an address changed in Google gets a new id, so the account could be connected to a second person; read
// Google's own account id, with the openid scope, if that matters.
func accountID(address string) string {
	sum := sha256.Sum256([]byte("google-account:" + strings.ToLower(address)))
	return hex.EncodeToString(sum[:])
}

// legacyConnection reads the deployment's one connection from before, for its deletion.
//
// shortcut: remove it, with retireLegacy and the grants on the parameter, once every deployment logs it retired.
func (g *Google) legacyConnection(ctx context.Context) (connection, error) {
	var conn connection
	raw, err := g.Secrets.Get(ctx, SecretRefreshToken)
	if err != nil {
		return conn, err
	}
	if err := json.Unmarshal([]byte(raw), &conn); err != nil {
		// The error text could quote the secret.
		return conn, errors.New("gcal: stored connection is malformed")
	}
	conn.legacy = true
	return conn, nil
}

// connected reports whether sub has a connection to run, without opening a token.
func (g *Google) connected(ctx context.Context, sub string) (bool, error) {
	return g.Connections.Has(ctx, sub)
}

// awsError names an AWS failure by its code, such as AccessDeniedException, for a log line: never its message.
func awsError(err error) []any {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		return []any{"aws_error", apiErr.ErrorCode()}
	}
	return nil
}

// missingScopes returns the scopes asked for that a consent's token doesn't carry. Google lists the granted ones; someone
// can untick any of them on its consent screen.
func missingScopes(token *oauth2.Token) []string {
	granted, ok := token.Extra("scope").(string)
	if !ok {
		return nil
	}
	have := strings.Fields(granted)
	var missing []string
	for _, scope := range Scopes {
		if !slices.Contains(have, scope) {
			missing = append(missing, scope)
		}
	}
	return missing
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

// Callback finishes a consent: it stores the token as this person's connection, makes sure Time blocks exists, and starts
// a run. A Google account already connected to someone else is refused with api.ErrAccountTaken, before anything is made
// in it: revoking access, by either person, would end both connections, and each would make its own Time blocks there.
// The refused token is dropped, not revoked, since revoking it would end the other person's connection too.
func (g *Google) Callback(ctx context.Context, state, code string) error {
	sub, err := g.verifyState(ctx, state)
	if err != nil {
		return err
	}
	cfg, err := g.oauthConfig(ctx)
	if err != nil {
		return err
	}
	token, err := cfg.Exchange(context.WithValue(ctx, oauth2.HTTPClient, googleClient()), code)
	if err != nil {
		return err
	}
	if token.RefreshToken == "" {
		return errors.New("gcal: consent returned no refresh token")
	}
	if missing := missingScopes(token); len(missing) > 0 {
		g.Log.Info("calendar_connect_refused", "user", obs.HashSub(sub), "reason", "scopes_missing", "missing", missing)
		return api.ErrScopesMissing
	}
	svc, err := g.serviceFor(ctx, cfg, token)
	if err != nil {
		return err
	}
	primary, err := svc.CalendarList.Get("primary").Context(ctx).Do()
	if err != nil {
		return err
	}
	account := accountID(primary.Id)
	if holder, err := g.Connections.Holder(ctx, account); err != nil {
		return err
	} else if holder != "" && holder != sub {
		g.Log.Info("calendar_connect_refused", "user", obs.HashSub(sub), "reason", "account_taken")
		return api.ErrAccountTaken
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
	// Over the connection as read, without opening it, so one that won't open never stops a new consent. Another consent
	// of theirs landing meanwhile is older than this one, so it goes round and replaces it.
	for attempt := 0; ; attempt++ {
		var previous connection
		previous, err = g.Connections.Peek(ctx, sub)
		if err != nil && !errors.Is(err, ErrNotConnected) {
			return err
		}
		err = g.Connections.Put(ctx, connection{RefreshToken: token.RefreshToken, Sub: sub, Account: account}, previous)
		if !errors.Is(err, errConnectionChanged) || attempt == 2 {
			break
		}
	}
	if errors.Is(err, api.ErrAccountTaken) && calendarID != existing {
		// Someone else connected the same account a moment ago, so the calendar just made there is a second one.
		_ = svc.Calendars.Delete(calendarID).Context(ctx).Do()
	}
	if err != nil {
		return err
	}
	if err := g.writeCalendar(ctx, sub, stored, map[string]any{"connected": true, "calendar_id": calendarID, "last_error": nil}); err != nil {
		return err
	}
	// A first run that can't start now still happens at the next schedule, so this isn't worth failing a good consent.
	_ = g.Trigger(ctx, sub)
	return nil
}

// Refresh starts a run for this person, if they are connected.
func (g *Google) Refresh(ctx context.Context, sub string) error {
	connected, err := g.connected(ctx, sub)
	if err != nil || !connected {
		return err
	}
	return g.Trigger(ctx, sub)
}

// Disconnect ends this person's connection, as DeleteConnection does, and the app shows it unconnected.
func (g *Google) Disconnect(ctx context.Context, sub string) error {
	if err := g.DeleteConnection(ctx, sub); err != nil {
		return err
	}
	stored, err := g.calendarRecord(ctx, sub)
	if err != nil {
		return err
	}
	return g.writeCalendar(ctx, sub, stored, map[string]any{"connected": false, "calendar_id": nil, "events": []any{}, "last_error": nil})
}

// DeleteConnection ends this person's connection: Time blocks is removed from their Google, Google's access is revoked,
// the stored token is deleted, their own and the legacy one if it is theirs, and their Google account's claim released.
// It succeeds when they have none, so it can run again. A consent finishing at the same moment is ended too, by going
// round again. Disconnect calls it; deleting an account calls Forget.
func (g *Google) DeleteConnection(ctx context.Context, sub string) error {
	return g.endConnection(ctx, sub, "calendar_disconnect", "user", obs.HashSub(sub))
}

// Forget is what deleting an account does with Google (account.Google): DeleteConnection, called before the records go,
// since it reads Time blocks' id from the calendar record; with the records already gone, it still revokes and deletes.
// It writes no record, and its log line counts without saying who, since the account is going.
func (g *Google) Forget(ctx context.Context, sub string) error {
	return g.endConnection(ctx, sub, "calendar_forget")
}

func (g *Google) endConnection(ctx context.Context, sub, msg string, attrs ...any) error {
	for attempt := 0; ; attempt++ {
		err := g.deleteConnection(ctx, sub, msg, attrs)
		if !errors.Is(err, errConnectionChanged) || attempt == 2 {
			return err
		}
	}
}

func (g *Google) deleteConnection(ctx context.Context, sub, msg string, attrs []any) error {
	// Read as stored, then opened: one that won't open is still deleted, without the revoke it can't make.
	own, err := g.Connections.Peek(ctx, sub)
	if err != nil && !errors.Is(err, ErrNotConnected) {
		return err
	}
	failed := []string{}
	if own.Sub != "" {
		opened, err := g.Connections.Get(ctx, sub)
		if err == nil && string(opened.sealed) == string(own.sealed) {
			own = opened
		} else {
			failed = append(failed, "unreadable")
		}
	}
	legacy, err := g.legacyConnection(ctx)
	if err != nil && !errors.Is(err, ErrNoSecret) {
		return err
	}
	var tokens []string
	if own.RefreshToken != "" {
		tokens = append(tokens, own.RefreshToken)
	}
	if legacy.Sub == sub && legacy.RefreshToken != own.RefreshToken {
		tokens = append(tokens, legacy.RefreshToken)
	}
	if len(tokens) == 0 && own.Sub == "" {
		return nil
	}
	stored, err := g.calendarRecord(ctx, sub)
	if err != nil {
		return err
	}
	// Best effort with Google: access already removed there, or Time blocks already deleted, still disconnects here.
	if id := fieldString(stored, "calendar_id"); id != "" && len(tokens) > 0 {
		svc, err := g.service(ctx, tokens[0])
		if err == nil {
			err = svc.Calendars.Delete(id).Context(ctx).Do()
		}
		if err != nil && !hasStatus(err, http.StatusNotFound, http.StatusGone) && errorCode(err) != ErrorRevoked {
			failed = append(failed, "delete_calendar")
		}
	}
	for _, token := range tokens {
		if err := g.revoke(ctx, token); err != nil {
			failed = append(failed, "revoke")
		}
	}
	g.Log.Info(msg, append(attrs, "google_failed", failed)...)
	if own.Sub != "" {
		if err := g.Connections.Delete(ctx, own); err != nil {
			return err
		}
	}
	if legacy.Sub == sub {
		if err := g.Secrets.Delete(ctx, SecretRefreshToken); err != nil {
			return err
		}
	}
	// A connection made meanwhile, by a consent, goes round again.
	if _, err := g.Connections.Peek(ctx, sub); !errors.Is(err, ErrNotConnected) {
		if err == nil {
			return errConnectionChanged
		}
		return err
	}
	return nil
}

// revoke asks Google to stop honouring a refresh token. Google answers 400 for one it already doesn't.
func (g *Google) revoke(ctx context.Context, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.RevokeURL, strings.NewReader(url.Values{"token": {token}}.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := googleClient().Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusBadRequest {
		return fmt.Errorf("gcal: revoke answered %d", res.StatusCode)
	}
	return nil
}
