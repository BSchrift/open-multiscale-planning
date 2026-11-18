package gcal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aws/smithy-go"
)

// A copy that doesn't read back as the legacy token is taken away again, so the legacy one keeps serving them.
func TestACopyThatDoesntReadBackIsRemoved(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	w.g.Connections = unreadableAfterPut{w.conns}
	if got := w.migrate(); got != migrationUnverified {
		t.Fatalf("%s", got)
	}
	if _, kept := w.conns.conns[testSub]; kept {
		t.Fatal("left a copy that doesn't open")
	}
	w.g.Connections = w.conns
	w.conns.unreadable = nil
	w.block("b1", "Write the report", at(1), at(2))
	w.run()
	if w.eventFor("b1") == nil {
		t.Fatal("stopped syncing")
	}
}

// unreadableAfterPut makes every token stored by the migration fail to open, as one sealed wrongly would.
type unreadableAfterPut struct{ *memConnections }

func (u unreadableAfterPut) PutNew(ctx context.Context, conn connection) ([]byte, error) {
	sealed, err := u.memConnections.PutNew(ctx, conn)
	u.memConnections.mu.Lock()
	u.memConnections.unreadable = map[string]bool{conn.Sub: true}
	u.memConnections.mu.Unlock()
	return sealed, err
}

// A disconnect that read no connection of their own, then lost the race to the migration's copy, goes round and
// removes the copy too.
func TestADisconnectThatTheMigrationRacesStillEndsTheConnection(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	migrated := false
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if !migrated {
			migrated = true
			if got := w.migrate(); got != migrationMigrated {
				t.Errorf("migration: %s", got)
			}
		}
		w.fake.ServeHTTP(rw, r)
	}))
	t.Cleanup(srv.Close)
	w.g.RevokeURL = srv.URL + "/revoke"
	if err := w.g.Disconnect(context.Background(), testSub); err != nil {
		t.Fatal(err)
	}
	if _, kept := w.conns.conns[testSub]; kept || !migrated {
		t.Fatalf("the migration's copy survived the disconnect (migrated %v)", migrated)
	}
	if _, ok := w.secrets.values[SecretRefreshToken]; ok {
		t.Fatal("legacy secret kept")
	}
}

// A failure in AWS names its code in the migration's line.
func TestAMigrationFailureNamesTheAWSErrorCode(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	w.conns.failing = &smithy.GenericAPIError{Code: "AccessDeniedException", Message: "not allowed"}
	if _, err := w.g.MigrateLegacy(context.Background(), "r"); !errors.Is(err, w.conns.failing) && err == nil {
		t.Fatal("no error")
	}
	if line := w.migrationLines()[0]; line["aws_error"] != "AccessDeniedException" || line["CalendarLegacyUnmigrated"] != float64(1) {
		t.Fatalf("%+v", line)
	}
}

// A copy marked refused stops its person's runs and keeps the fallback from serving them, so it isn't migrated, even
// with Google honouring the token again: they connect again, which replaces it.
func TestARevokedCopyIsNotMigrated(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	if got := w.migrate(); got != migrationMigrated {
		t.Fatalf("%s", got)
	}
	copied, _ := w.conns.Peek(context.Background(), testSub)
	w.conns.MarkRevoked(context.Background(), copied)
	if got := w.migrate(); got != migrationCopyRevoked {
		t.Fatalf("%s", got)
	}
	lines := w.migrationLines()
	if lines[len(lines)-1]["CalendarLegacyUnmigrated"] != float64(1) {
		t.Fatalf("%+v", lines[len(lines)-1])
	}
	w.connect(testSub)
	if got := w.migrate(); got != migrationSuperseded {
		t.Fatalf("after connecting again: %s", got)
	}
}
