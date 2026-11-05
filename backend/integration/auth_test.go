package integration

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"crypto"
)

var protectedRoutes = []string{"/sync", "/calendar/connect", "/calendar/refresh", "/calendar/disconnect"}

func TestSmokeNoTokenIsRefused(t *testing.T) {
	needs(t)
	for _, path := range protectedRoutes {
		res := request(t, "POST", path, "", []byte(`{}`))
		if res.status != 401 {
			t.Errorf("%s: %d %s", path, res.status, res.body)
		}
	}
}

func signedToken(t *testing.T, head, claims map[string]any, key *rsa.PrivateKey) string {
	t.Helper()
	input := segment(t, head) + "." + segment(t, claims)
	sum := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func segment(t *testing.T, value any) string {
	t.Helper()
	return base64.RawURLEncoding.EncodeToString(mustJSON(t, value))
}

func decodeSegment(t *testing.T, part string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(part)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBadTokensAreRefused(t *testing.T) {
	needs(t)
	a := signIn(t)
	parts := strings.Split(a.tokens.access, ".")
	if len(parts) != 3 {
		t.Fatal("an access token should be a JWT")
	}
	head, claims := decodeSegment(t, parts[0]), decodeSegment(t, parts[1])
	strangerKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	withClaim := func(name string, value any) map[string]any {
		changed := map[string]any{}
		for k, v := range claims {
			changed[k] = v
		}
		changed[name] = value
		return changed
	}
	none := map[string]any{"alg": "none", "typ": "JWT", "kid": head["kid"]}
	cases := map[string]string{
		"garbage":                   "not-a-token",
		"empty segments":            "..",
		"signature stripped":        parts[0] + "." + parts[1] + ".",
		"alg none":                  segment(t, none) + "." + parts[1] + ".",
		"changed sub, old sig":      parts[0] + "." + segment(t, withClaim("sub", "someone-else")) + "." + parts[2],
		"extended, old sig":         parts[0] + "." + segment(t, withClaim("exp", time.Now().Add(1000*time.Hour).Unix())) + "." + parts[2],
		"signature of another":      parts[0] + "." + parts[1] + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 256)),
		"signed by a stranger":      signedToken(t, head, claims, strangerKey),
		"stranger with unknown kid": signedToken(t, map[string]any{"alg": "RS256", "kid": "unknown"}, claims, strangerKey),
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			for _, path := range protectedRoutes {
				if res := request(t, "POST", path, token, []byte(`{"cursor":0,"changes":[]}`)); res.status != 401 {
					t.Errorf("%s: %d %s", path, res.status, truncated(res.body))
				}
			}
		})
	}
	// The real token still works, so the refusals above came from what was changed.
	a.sync(a.startCursor())
}

func TestSmokeRefreshTokenGivesAWorkingToken(t *testing.T) {
	needs(t)
	a := signIn(t)
	if a.tokens.refresh == "" {
		t.Fatal("sign-in gave no refresh token")
	}
	access, err := refreshAccess(t, a.tokens.refresh)
	if err != nil {
		t.Fatal(err)
	}
	a.tokens.access = access
	a.sync(a.startCursor())
}

func TestBadRefreshTokenIsRefused(t *testing.T) {
	needs(t)
	if access, err := refreshAccess(t, "not-a-refresh-token"); err == nil {
		t.Fatalf("got a token: %q", access)
	}
}

func TestExpiredTokenIsRefusedAndRefreshRecovers(t *testing.T) {
	needs(t, fakeClock)
	clock := holdClock(t)
	a := signIn(t)
	a.sync(0)

	clock.advance(59 * time.Minute)
	a.sync(0)

	clock.advance(2 * time.Minute)
	for _, path := range protectedRoutes {
		if res := request(t, "POST", path, a.tokens.access, []byte(`{}`)); res.status != 401 {
			t.Errorf("%s with an expired token: %d", path, res.status)
		}
	}
	access, err := refreshAccess(t, a.tokens.refresh)
	if err != nil {
		t.Fatal(err)
	}
	a.tokens.access = access
	a.sync(0)

	// A sign-in lasts longer than a token, but not for ever.
	clock.advance(31 * 24 * time.Hour)
	if _, err := refreshAccess(t, a.tokens.refresh); err == nil {
		t.Fatal("an expired refresh token still worked")
	}
}

func TestTokenFromTheFutureIsRefused(t *testing.T) {
	needs(t, fakeClock)
	clock := holdClock(t)
	clock.advance(2 * time.Hour)
	a := signIn(t)
	clock.advance(-time.Hour)
	if res := request(t, "POST", "/sync", a.tokens.access, []byte(`{}`)); res.status != 401 {
		t.Fatalf("%d", res.status)
	}
}
