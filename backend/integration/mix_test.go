package integration

import (
	"os"
	"testing"
	"time"
)

// TestNightlyRequestMix is the fixed load the per-route latency targets are for (docs/performance.md): the same requests
// to each route every night on staging, so its access log's p50, p95 and p99 by route mean the same from night to night.
// On a deployment only with MULTISCALE_REQUEST_MIX=1, which the release pipeline's nightly sets, and locally always, where
// a skip would mean a test quietly stopped testing. It checks only that each request worked. The records it pushes are
// emptied and deleted afterwards, as every test's are.
func TestNightlyRequestMix(t *testing.T) {
	needs(t)
	if !target.local() && os.Getenv("MULTISCALE_REQUEST_MIX") != "1" {
		t.Skip("needs: MULTISCALE_REQUEST_MIX=1, which staging's nightly sets")
	}
	a := signIn(t)
	start := a.startCursor()
	// Pushes of a full batch, paced under the partition's write rate.
	cursor := start
	for push := 0; push < 10; push++ {
		batch := make([]record, 99)
		for i := range batch {
			batch[i] = a.record("task", fresh("mix"), "kind", "inbox", "title", "Request mix")
		}
		cursor = a.sync(cursor, batch...).Cursor
		time.Sleep(fullBatchPause)
	}
	// Pulls of full pages: 990 records from where the pushes began is two pages of 500.
	for pull := 0; pull < 10; pull++ {
		if got, _ := a.pullAll(start); len(got) < 990 {
			t.Fatalf("pulled %d of the 990 records pushed", len(got))
		}
	}
	export := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"eventName":"app.heartbeat"}]}]}]}`
	for batch := 0; batch < 20; batch++ {
		if res := request(t, "POST", "/v1/logs", a.tokens.access, []byte(export)); res.status != 200 {
			t.Fatalf("/v1/logs: %d %s", res.status, truncated(res.body))
		}
	}
	for call := 0; call < 20; call++ {
		// Answered as not configured where the environment stores no files, which is still the route's latency.
		if res := request(t, "GET", "/files/usage", a.tokens.access, nil); res.status >= 500 {
			t.Fatalf("/files/usage: %d %s", res.status, truncated(res.body))
		}
	}
	for call := 0; call < 5; call++ {
		// Only the connected user's refresh does anything, so this is safe whoever the test user is.
		if res := request(t, "POST", "/calendar/refresh", a.tokens.access, nil); res.status != 204 {
			t.Fatalf("/calendar/refresh: %d %s", res.status, truncated(res.body))
		}
	}
}
