package integration

import (
	"fmt"
	"testing"
	"time"
)

// heldClock fixes the local stack's time for one test and gives it back afterwards.
type heldClock struct {
	t   *testing.T
	now time.Time
}

// holdClock goes first in a test, so that it's released last, after the test's accounts have cleaned up.
func holdClock(t *testing.T) *heldClock {
	t.Helper()
	c := &heldClock{t, time.Now().UTC().Truncate(time.Second)}
	c.set()
	t.Cleanup(func() {
		if res := request(t, "POST", "/_local/clock", "", []byte(`{"now":""}`)); res.status != 204 {
			t.Errorf("release clock: %d", res.status)
		}
	})
	return c
}

func (c *heldClock) advance(by time.Duration) {
	c.t.Helper()
	c.now = c.now.Add(by)
	c.set()
}

func (c *heldClock) to(at time.Time) {
	c.t.Helper()
	c.now = at.UTC().Truncate(time.Second)
	c.set()
}

func (c *heldClock) set() {
	c.t.Helper()
	res := request(c.t, "POST", "/_local/clock", "", []byte(fmt.Sprintf(`{"now":%q}`, c.now.Format(time.RFC3339))))
	if res.status != 204 {
		c.t.Fatalf("set clock: %d", res.status)
	}
}
