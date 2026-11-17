package gcal

import (
	"context"
	"errors"
	"time"

	"golang.org/x/oauth2"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

// The outcomes of a migration step, in its log line. Only migrated, superseded and none need nothing more.
const (
	migrationNone         = "none"
	migrationMigrated     = "migrated"
	migrationSuperseded   = "superseded"
	migrationUnverified   = "unverified"
	migrationRevoked      = "legacy_revoked"
	migrationAccountTaken = "account_taken"
	migrationDisconnected = "disconnected_meanwhile"
)

// MigrateLegacy copies the deployment's one connection from before into its person's own, and reports whether their own
// now holds it. It never deletes the legacy secret, so the release before still finds it if this one is rolled back.
//
// It runs with every schedule, so it runs within one schedule of a deploy and again until the legacy secret goes, and
// every step is safe to repeat or to run beside another:
//   - The copy is sealed with the legacy person's sub, and stored only if they have no connection of their own: a consent
//     of theirs made since is newer, and stays.
//   - Success is reported only once the copy, read back and decrypted, is the legacy token, and Google has honoured it
//     with a refresh. An interrupted step leaves either nothing or a true copy, which the next one verifies.
//   - A disconnect while it runs deletes the legacy secret; a copy made from it is then deleted too, so a disconnected
//     person isn't connected again.
//
// It logs calendar_legacy_migration and the metric CalendarLegacyUnmigrated: 1 while a legacy connection isn't safely in
// its person's own record, else 0.
func (g *Google) MigrateLegacy(ctx context.Context, requestID string) (string, error) {
	outcome, err := g.migrateLegacy(ctx)
	unmigrated := 1
	if outcome == migrationNone || outcome == migrationMigrated || outcome == migrationSuperseded || outcome == migrationDisconnected {
		unmigrated = 0
	}
	attrs := []any{"request_id", requestID, "outcome", outcome}
	if err != nil {
		attrs = append(append(attrs, "error_type", errorCode(err)), awsError(err)...)
	}
	g.Log.Info("calendar_legacy_migration", append(attrs, obs.Metrics(g.Env, g.Now(), map[string]int{"CalendarLegacyUnmigrated": unmigrated})...)...)
	return outcome, err
}

func (g *Google) migrateLegacy(ctx context.Context) (string, error) {
	legacy, err := g.legacyConnection(ctx)
	if errors.Is(err, ErrNoSecret) {
		return migrationNone, nil
	}
	if err != nil {
		return migrationUnverified, err
	}
	own, err := g.Connections.Get(ctx, legacy.Sub)
	if errors.Is(err, ErrNotConnected) {
		if outcome, err := g.copyLegacy(ctx, legacy); outcome != "" || err != nil {
			return outcome, err
		}
		own, err = g.Connections.Get(ctx, legacy.Sub)
		if errors.Is(err, ErrNotConnected) {
			// Deleted as soon as it was made: a disconnect, which takes the legacy secret too.
			return g.unlessDisconnected(ctx, legacy, migrationUnverified, err)
		}
	}
	if err != nil {
		return migrationUnverified, err
	}
	if own.RefreshToken != legacy.RefreshToken {
		// They connected again since: their own is newer, and the legacy one is no longer needed.
		return migrationSuperseded, nil
	}
	if err := g.refreshes(ctx, own.RefreshToken); err != nil {
		if errorCode(err) == ErrorRevoked {
			return g.unlessDisconnected(ctx, own, migrationRevoked, err)
		}
		return migrationUnverified, err
	}
	return g.unlessDisconnected(ctx, own, migrationMigrated, nil)
}

// copyLegacy stores the legacy connection as its person's own, with the Google account it's for. It returns an outcome
// only when it stops short of a copy to verify.
func (g *Google) copyLegacy(ctx context.Context, legacy connection) (string, error) {
	svc, err := g.service(ctx, legacy.RefreshToken)
	if err != nil {
		return migrationUnverified, err
	}
	primary, err := svc.CalendarList.Get("primary").Context(ctx).Do()
	if err != nil {
		if errorCode(err) == ErrorRevoked {
			return migrationRevoked, err
		}
		return migrationUnverified, err
	}
	account := accountID(primary.Id)
	holder, err := g.Connections.Holder(ctx, account)
	if err != nil {
		return migrationUnverified, err
	}
	if holder != "" && holder != legacy.Sub {
		// Someone else connected the same Google account since; the fallback keeps serving the legacy person meanwhile.
		return migrationAccountTaken, nil
	}
	sealed, err := g.Connections.PutNew(ctx, connection{RefreshToken: legacy.RefreshToken, Sub: legacy.Sub, Account: account})
	if errors.Is(err, errConnectionChanged) {
		// A consent of theirs got there first, and stays.
		return "", nil
	}
	if err != nil {
		return migrationUnverified, err
	}
	// Read back and opened. A copy that won't open, or opens as anything but the legacy token, is taken away again, so the
	// fallback keeps serving them; one a consent has replaced since is theirs, and stays.
	got, err := g.Connections.Get(ctx, legacy.Sub)
	if errors.Is(err, ErrNotConnected) || (err == nil && string(got.sealed) != string(sealed)) {
		// Gone already, by a disconnect, or replaced: the step goes on to say which.
		return "", nil
	}
	if err != nil || got.RefreshToken != legacy.RefreshToken {
		if removeErr := g.Connections.Delete(ctx, connection{Sub: legacy.Sub, Account: account, sealed: sealed}); removeErr != nil && !errors.Is(removeErr, errConnectionChanged) {
			return migrationUnverified, removeErr
		}
		if err == nil {
			err = errors.New("gcal: the copy doesn't read back as the legacy token")
		}
		return migrationUnverified, err
	}
	return "", nil
}

// unlessDisconnected reports outcome, unless the legacy secret went while the step ran: a disconnect deleted it, and the
// copy made from it goes too.
func (g *Google) unlessDisconnected(ctx context.Context, own connection, outcome string, cause error) (string, error) {
	_, err := g.legacyConnection(ctx)
	if !errors.Is(err, ErrNoSecret) {
		if err != nil {
			return migrationUnverified, err
		}
		return outcome, cause
	}
	if own.legacy {
		// Nothing of their own was left to delete.
		return migrationDisconnected, nil
	}
	if err := g.Connections.Delete(ctx, own); err != nil && !errors.Is(err, errConnectionChanged) {
		return migrationUnverified, err
	}
	return migrationDisconnected, nil
}

// refreshes asks Google for an access token with a refresh token, which is what proves Google still honours it.
func (g *Google) refreshes(ctx context.Context, refreshToken string) error {
	cfg, err := g.oauthConfig(ctx)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.WithValue(ctx, oauth2.HTTPClient, googleClient()), callTimeout)
	defer cancel()
	_, err = cfg.TokenSource(ctx, &oauth2.Token{RefreshToken: refreshToken, Expiry: time.Unix(1, 0)}).Token()
	return err
}
