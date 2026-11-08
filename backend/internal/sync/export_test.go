package sync

import "time"

// SetThrottleWait makes every throttle wait d for a test, and returns what puts the real waits back.
func SetThrottleWait(d time.Duration) (restore func()) {
	old := throttleWait
	throttleWait = func(int) time.Duration { return d }
	return func() { throttleWait = old }
}

// SetThrottleBudget shortens how long a push waits out throttling for a test, and returns what puts it back.
func SetThrottleBudget(d time.Duration) (restore func()) {
	old := throttleBudget
	throttleBudget = d
	return func() { throttleBudget = old }
}
