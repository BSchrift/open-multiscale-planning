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
	// SecretRefreshToken is the deployment's one connection from before each person had their own. It is read only as a
	// fallback, for the person it names, until the migration has copied it to their own connection.
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
	// sealed is the stored, encrypted token as read, so a change can be made only to the connection that was read.
	sealed []byte
	// legacy marks the deployment's one connection from before, read from SecretRefreshToken.
	legacy bool
}

// Connections keeps each person's connection, with its refresh token encrypted for them alone. DynamoConnections is the
// deployed one.
type Connections interface {
	// Get returns sub's own connection, or ErrNotConnected.
	Get(ctx context.Context, sub string) (connection, error)
	// Holder returns who holds a Google account's connection, or "" for no one.
	Holder(ctx context.Context, account string) (string, error)
	// Put stores conn as its person's connection and claims its Google account, releasing previous, the account they held
	// before, if it's another. It returns api.ErrAccountTaken when someone else holds the account.
	Put(ctx context.Context, conn connection, previous string) error
	// PutNew stores conn as Put does, only if its person has no connection of their own, and returns errConnectionChanged
	// if they have one.
	PutNew(ctx context.Context, conn connection) error
	// Delete removes conn and releases its account. It succeeds when there's nothing to remove, and returns
	// errConnectionChanged when conn was replaced since it was read, leaving the new one.
	Delete(ctx context.Context, conn connection) error
	// Has reports whether sub has a connection of their own, without decrypting it.
	Has(ctx context.Context, sub string) (bool, error)
	// Each calls fn with the sub of every person who has a connection of their own.
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

// legacyConnection reads the deployment's one connection from before.
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

// connectionOf returns sub's connection: their own, else the legacy one if it is theirs, else ErrNotConnected. The
// fallback lets the worker keep running for the person connected before per-person connections, until the migration has
// copied theirs.
func (g *Google) connectionOf(ctx context.Context, sub string) (connection, error) {
	conn, err := g.Connections.Get(ctx, sub)
	if !errors.Is(err, ErrNotConnected) {
		return conn, err
	}
	legacy, err := g.legacyConnection(ctx)
	if errors.Is(err, ErrNoSecret) || (err == nil && legacy.Sub != sub) {
		return connection{}, ErrNotConnected
	}
	return legacy, err
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
	previous, err := g.Connections.Get(ctx, sub)
	if err != nil && !errors.Is(err, ErrNotConnected) {
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
	err = g.Connections.Put(ctx, connection{RefreshToken: token.RefreshToken, Sub: sub, Account: account}, previous.Account)
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
	_, err := g.connectionOf(ctx, sub)
	if errors.Is(err, ErrNotConnected) {
		return nil
	}
	if err != nil {
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
// and the stored token is deleted, their own and the legacy one if it is theirs. It succeeds when they have none, so it
// can run again. Deleting an account calls it before the records go, since it reads Time blocks' id from the calendar
// record; with the records already gone, it still revokes and deletes. A consent finishing at the same moment is ended
// too, by going round again.
func (g *Google) DeleteConnection(ctx context.Context, sub string) error {
	for attempt := 0; ; attempt++ {
		err := g.deleteConnection(ctx, sub)
		if !errors.Is(err, errConnectionChanged) || attempt == 2 {
			return err
		}
	}
}

func (g *Google) deleteConnection(ctx context.Context, sub string) error {
	own, err := g.Connections.Get(ctx, sub)
	if err != nil && !errors.Is(err, ErrNotConnected) {
		return err
	}
	legacy, err := g.legacyConnection(ctx)
	if err != nil && !errors.Is(err, ErrNoSecret) {
		return err
	}
	var tokens []string
	if own.Sub != "" {
		tokens = append(tokens, own.RefreshToken)
	}
	if legacy.Sub == sub && legacy.RefreshToken != own.RefreshToken {
		tokens = append(tokens, legacy.RefreshToken)
	}
	if len(tokens) == 0 {
		return nil
	}
	stored, err := g.calendarRecord(ctx, sub)
	if err != nil {
		return err
	}
	// Best effort with Google: access already removed there, or Time blocks already deleted, still disconnects here.
	failed := []string{}
	if id := fieldString(stored, "calendar_id"); id != "" {
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
	g.Log.Info("calendar_disconnect", "user", obs.HashSub(sub), "google_failed", failed)
	if own.Sub != "" {
		if err := g.Connections.Delete(ctx, own); err != nil {
			return err
		}
	}
	if legacy.Sub == sub {
		return g.Secrets.Delete(ctx, SecretRefreshToken)
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
