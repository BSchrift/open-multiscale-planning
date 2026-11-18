package account_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
)

var tokenNow = time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

func sign(t *testing.T, key *rsa.PrivateKey, kid string, alg string, claims map[string]any) string {
	t.Helper()
	head, _ := json.Marshal(map[string]string{"alg": alg, "kid": kid})
	body, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(body)
	sum := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestALapsedTokenStillSaysWhoItWasFor(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	tokens := &account.Tokens{
		Issuer: "https://issuer.test", ClientIDs: []string{"app", "tests"}, Now: func() time.Time { return tokenNow },
		Keys: func(context.Context) (map[string]*rsa.PublicKey, error) {
			return map[string]*rsa.PublicKey{"k1": &key.PublicKey}, nil
		},
	}
	claims := func(change map[string]any) map[string]any {
		c := map[string]any{
			"iss": "https://issuer.test", "sub": "alice", "client_id": "app", "token_use": "access",
			"iat": tokenNow.Add(-48 * time.Hour).Unix(), "exp": tokenNow.Add(-47 * time.Hour).Unix(),
		}
		for k, v := range change {
			c[k] = v
		}
		return c
	}
	if sub, ok := tokens.Subject(context.Background(), sign(t, key, "k1", "RS256", claims(nil))); !ok || sub != "alice" {
		t.Fatalf("a lapsed token: %q %v", sub, ok)
	}
	for name, token := range map[string]string{
		"another key":             sign(t, other, "k1", "RS256", claims(nil)),
		"an unknown key id":       sign(t, key, "k2", "RS256", claims(nil)),
		"another algorithm":       sign(t, key, "k1", "HS256", claims(nil)),
		"another issuer":          sign(t, key, "k1", "RS256", claims(map[string]any{"iss": "https://elsewhere.test"})),
		"another client":          sign(t, key, "k1", "RS256", claims(map[string]any{"client_id": "someone-elses"})),
		"an id token":             sign(t, key, "k1", "RS256", claims(map[string]any{"token_use": "id"})),
		"no sub":                  sign(t, key, "k1", "RS256", claims(map[string]any{"sub": ""})),
		"issued in the future":    sign(t, key, "k1", "RS256", claims(map[string]any{"iat": tokenNow.Add(time.Hour).Unix()})),
		"older than any sign-in":  sign(t, key, "k1", "RS256", claims(map[string]any{"iat": tokenNow.Add(-401 * 24 * time.Hour).Unix()})),
		"not a token":             "abc",
		"a body changed after it": sign(t, key, "k1", "RS256", claims(nil))[:20] + "x" + sign(t, key, "k1", "RS256", claims(nil))[21:],
	} {
		if sub, ok := tokens.Subject(context.Background(), token); ok {
			t.Fatalf("%s read as %q", name, sub)
		}
	}
}

func TestJWKSReadsTheUserPoolsKeys(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	fetches := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "k1", "kty": "RSA",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	defer server.Close()
	jwks := &account.JWKS{URL: server.URL, Client: server.Client()}
	for range 2 {
		keys, err := jwks.Keys(context.Background())
		if err != nil || keys["k1"] == nil || keys["k1"].N.Cmp(key.N) != 0 || keys["k1"].E != key.E {
			t.Fatalf("%v %v", keys, err)
		}
	}
	if fetches != 1 {
		t.Fatalf("fetched %d times", fetches)
	}
}
