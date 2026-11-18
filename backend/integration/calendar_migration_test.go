package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

// googleRefreshToken consents straight with the local stack's Google stand-in, as the API from before per-person
// connections did, and returns the refresh token it gave.
func googleRefreshToken(t *testing.T, account string) string {
	t.Helper()
	const clientID, clientSecret, redirect = "local-google-client", "local-google-secret", "http://localhost/back"
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(target.APIURL + "/google/o/oauth2/auth?" + url.Values{
		"client_id": {clientID}, "response_type": {"code"}, "scope": {"calendar"}, "redirect_uri": {redirect},
		"access_type": {"offline"}, "login_hint": {account},
	}.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	back, err := res.Location()
	if err != nil {
		t.Fatal(err)
	}
	res, err = http.PostForm(target.APIURL+"/google/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {back.Query().Get("code")}, "redirect_uri": {redirect},
		"client_id": {clientID}, "client_secret": {clientSecret},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var token struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&token); err != nil || token.RefreshToken == "" {
		t.Fatalf("no refresh token: %v", err)
	}
	return token.RefreshToken
}

// From a deployment holding only the legacy connection, the schedule copies it to its person's own while their sync
// carries on at every step: no consent asked again, the same Time blocks and no second one, the legacy secret kept.
func TestTheLegacyConnectionMovesToItsPersonWithoutInterruption(t *testing.T) {
	needs(t, fakeGoogle, fakeClock, moto, localTables)
	clock := holdClock(t)
	ctx, secrets := context.Background(), motoSSM(t)
	a := signIn(t)
	sub := localSub(a.username)
	token := googleRefreshToken(t, a.googleAccount())
	legacy, _ := json.Marshal(map[string]string{"refresh_token": token, "sub": sub})
	name := aws.String(localSecrets + "refresh-token")
	if _, err := secrets.PutParameter(ctx, &ssm.PutParameterInput{
		Name: name, Value: aws.String(string(legacy)), Type: ssmtypes.ParameterTypeSecureString, Overwrite: aws.Bool(true),
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		a.reSignIn()
		request(t, "POST", "/calendar/disconnect", a.tokens.access, nil)
		secrets.DeleteParameter(ctx, &ssm.DeleteParameterInput{Name: name})
	})
	legacyKept := func(when string) {
		t.Helper()
		out, err := secrets.GetParameter(ctx, &ssm.GetParameterInput{Name: name, WithDecryption: aws.Bool(true)})
		if err != nil || aws.ToString(out.Parameter.Value) != string(legacy) {
			t.Fatalf("%s: the legacy secret changed: %v", when, err)
		}
	}
	start := clock.now.Add(2 * time.Hour)
	synced := func(when string, blocks int) {
		t.Helper()
		values := calendarFields(t, a)
		if values["connected"] != true || values["last_error"] != nil {
			t.Fatalf("%s: %+v", when, values)
		}
		if got := len(timeBlocks(t, a).Events); got != blocks {
			t.Fatalf("%s: %d events, want %d", when, got, blocks)
		}
		count := 0
		for _, c := range googleCalendars(t, a) {
			if c.Summary == "Time blocks" {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("%s: %d Time blocks calendars", when, count)
		}
	}

	// Before: the legacy connection alone syncs them, and they have no connection of their own.
	a.pushBlock(fresh("before"), "Before", start, start.Add(time.Hour))
	runWorker(t, a)
	synced("before", 1)
	timeBlocksID, _ := calendarID(a)
	if _, _, err := localConnection(t, a, sub); err == nil {
		t.Fatal("a connection of their own before the migration")
	}

	// The schedule copies it, sealed for them, and runs them on it.
	for _, when := range []string{"migrated", "again"} {
		clock.advance(31 * time.Minute)
		a.reSignIn()
		// A stream run may come first; the schedule follows, from this tick or the background one.
		for range 3 {
			if tick(t) == "" {
				break
			}
		}
		if _, own, err := localConnection(t, a, sub); err != nil || own != token {
			t.Fatalf("%s: their own connection isn't the legacy one: %v", when, err)
		}
		legacyKept(when)
	}
	a.pushBlock(fresh("after"), "After", start.Add(time.Hour), start.Add(2*time.Hour))
	runWorker(t, a)
	synced("after", 2)
	if id, _ := calendarID(a); id != timeBlocksID {
		t.Fatalf("Time blocks changed from %s to %s", timeBlocksID, id)
	}
}
