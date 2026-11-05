package fakes

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
)

const (
	testClient   = "local-client"
	testRedirect = "multiscale://signed-in"
	testVerifier = "a-verifier-long-enough-to-meet-the-pkce-minimum-length"
)

func challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func newCognito(t *testing.T) (*Cognito, *httptest.Server, *Clock) {
	t.Helper()
	clock := &Clock{}
	clock.Set(time.Unix(1800000000, 0))
	c, err := NewCognito("http://issuer.test", testClient, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(c)
	t.Cleanup(srv.Close)
	return c, srv, clock
}

var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func authorize(t *testing.T, srv *httptest.Server, over map[string]string) *http.Response {
	t.Helper()
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {testClient},
		"redirect_uri":          {testRedirect},
		"code_challenge":        {challenge(testVerifier)},
		"code_challenge_method": {"S256"},
		"state":                 {"state-1"},
		"scope":                 {"openid"},
	}
	for k, v := range over {
		if v == "" {
			q.Del(k)
		} else {
			q.Set(k, v)
		}
	}
	res, err := noRedirect.Get(srv.URL + "/oauth2/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func signIn(t *testing.T, srv *httptest.Server, over map[string]string) string {
	t.Helper()
	res := authorize(t, srv, over)
	if res.StatusCode != http.StatusFound {
		t.Fatalf("authorize: status %d", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(res.Header.Get("Location"), testRedirect+"?") || loc.Query().Get("state") != "state-1" {
		t.Fatalf("redirect %q", res.Header.Get("Location"))
	}
	return loc.Query().Get("code")
}

func token(t *testing.T, srv *httptest.Server, form url.Values) (int, map[string]any) {
	t.Helper()
	res, err := http.PostForm(srv.URL+"/oauth2/token", form)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, body
}

func codeForm(code, verifier string) url.Values {
	return url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {testClient},
		"code":          {code},
		"redirect_uri":  {testRedirect},
		"code_verifier": {verifier},
	}
}

func claimsOf(t *testing.T, jwt string) map[string]any {
	t.Helper()
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", jwt)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}

func TestAuthorizationCodeWithPKCE(t *testing.T) {
	_, srv, _ := newCognito(t)
	status, tokens := token(t, srv, codeForm(signIn(t, srv, nil), testVerifier))
	if status != 200 || tokens["token_type"] != "Bearer" || tokens["expires_in"] != float64(3600) {
		t.Fatalf("%d %v", status, tokens)
	}
	access := claimsOf(t, tokens["access_token"].(string))
	if access["token_use"] != "access" || access["client_id"] != testClient || access["iss"] != "http://issuer.test" || access["sub"] == "" {
		t.Fatalf("access %v", access)
	}
	id := claimsOf(t, tokens["id_token"].(string))
	if id["token_use"] != "id" || id["aud"] != testClient || id["sub"] != access["sub"] {
		t.Fatalf("id %v", id)
	}
	if tokens["refresh_token"] == "" {
		t.Fatal("no refresh token")
	}
}

func TestUsersGetTheirOwnStableSub(t *testing.T) {
	_, srv, _ := newCognito(t)
	subOf := func(username string) any {
		over := map[string]string{"username": username}
		_, tokens := token(t, srv, codeForm(signIn(t, srv, over), testVerifier))
		return claimsOf(t, tokens["access_token"].(string))["sub"]
	}
	if subOf("one") != subOf("one") || subOf("one") == subOf("two") {
		t.Fatal("sub must identify the user")
	}
}

// The real pool signs in by email, and its ID tokens carry it.
func TestIDTokenCarriesTheEmail(t *testing.T) {
	_, srv, _ := newCognito(t)
	_, tokens := token(t, srv, codeForm(signIn(t, srv, map[string]string{"username": "reader@example.com"}), testVerifier))
	if email := claimsOf(t, tokens["id_token"].(string))["email"]; email != "reader@example.com" {
		t.Fatalf("email %v", email)
	}
}

func TestAuthorizeRefuses(t *testing.T) {
	_, srv, _ := newCognito(t)
	for name, over := range map[string]map[string]string{
		"unknown client":  {"client_id": "someone-else"},
		"no challenge":    {"code_challenge": ""},
		"plain challenge": {"code_challenge_method": "plain"},
		"no method":       {"code_challenge_method": ""},
		"implicit grant":  {"response_type": "token"},
		"no redirect":     {"redirect_uri": ""},
	} {
		if res := authorize(t, srv, over); res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status %d", name, res.StatusCode)
		}
	}
}

func TestTokenRefuses(t *testing.T) {
	_, srv, clock := newCognito(t)
	refuse := func(name string, form url.Values) {
		t.Helper()
		if status, body := token(t, srv, form); status != 400 || body["error"] == nil {
			t.Errorf("%s: %d %v", name, status, body)
		}
	}
	refuse("wrong verifier", codeForm(signIn(t, srv, nil), "the-wrong-verifier-the-wrong-verifier-the-wrong-verifier"))
	refuse("no verifier", codeForm(signIn(t, srv, nil), ""))
	refuse("unknown code", codeForm("no-such-code", testVerifier))

	wrongClient := codeForm(signIn(t, srv, nil), testVerifier)
	wrongClient.Set("client_id", "someone-else")
	refuse("wrong client", wrongClient)

	wrongRedirect := codeForm(signIn(t, srv, nil), testVerifier)
	wrongRedirect.Set("redirect_uri", "multiscale://elsewhere")
	refuse("wrong redirect", wrongRedirect)

	reused := signIn(t, srv, nil)
	if status, _ := token(t, srv, codeForm(reused, testVerifier)); status != 200 {
		t.Fatal("first use must work")
	}
	refuse("reused code", codeForm(reused, testVerifier))

	stale := signIn(t, srv, nil)
	clock.Set(clock.Now().Add(6 * time.Minute))
	refuse("expired code", codeForm(stale, testVerifier))

	refuse("unknown grant", url.Values{"grant_type": {"password"}, "client_id": {testClient}})
}

func TestRefresh(t *testing.T) {
	_, srv, clock := newCognito(t)
	_, first := token(t, srv, codeForm(signIn(t, srv, nil), testVerifier))
	refreshForm := url.Values{"grant_type": {"refresh_token"}, "client_id": {testClient}, "refresh_token": {first["refresh_token"].(string)}}

	clock.Set(clock.Now().Add(2 * time.Hour))
	status, next := token(t, srv, refreshForm)
	if status != 200 || next["access_token"] == first["access_token"] || next["refresh_token"] != nil {
		t.Fatalf("%d %v", status, next)
	}
	before, after := claimsOf(t, first["access_token"].(string)), claimsOf(t, next["access_token"].(string))
	if before["sub"] != after["sub"] || after["exp"].(float64) <= before["exp"].(float64) {
		t.Fatalf("before %v after %v", before, after)
	}

	wrong := url.Values{"grant_type": {"refresh_token"}, "client_id": {"someone-else"}, "refresh_token": {first["refresh_token"].(string)}}
	if status, _ := token(t, srv, wrong); status != 400 {
		t.Fatalf("wrong client: %d", status)
	}
	unknown := url.Values{"grant_type": {"refresh_token"}, "client_id": {testClient}, "refresh_token": {"nope"}}
	if status, _ := token(t, srv, unknown); status != 400 {
		t.Fatalf("unknown token: %d", status)
	}

	clock.Set(clock.Now().Add(31 * 24 * time.Hour))
	if status, _ := token(t, srv, refreshForm); status != 400 {
		t.Fatalf("expired refresh token: %d", status)
	}
}

func TestRevokeEndsARefreshToken(t *testing.T) {
	_, srv, _ := newCognito(t)
	_, first := token(t, srv, codeForm(signIn(t, srv, nil), testVerifier))
	refresh := first["refresh_token"].(string)
	revoke := func(client string) int {
		res, err := http.PostForm(srv.URL+"/oauth2/revoke", url.Values{"token": {refresh}, "client_id": {client}})
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if status := revoke("someone-else"); status != 400 {
		t.Fatalf("wrong client: %d", status)
	}
	if status := revoke(testClient); status != 200 {
		t.Fatalf("revoke: %d", status)
	}
	if status, _ := token(t, srv, url.Values{"grant_type": {"refresh_token"}, "client_id": {testClient}, "refresh_token": {refresh}}); status != 400 {
		t.Fatalf("revoked refresh token still works: %d", status)
	}
}

func TestLogoutReturnsToTheApp(t *testing.T) {
	_, srv, _ := newCognito(t)
	q := url.Values{"client_id": {testClient}, "logout_uri": {testRedirect}}
	res, err := noRedirect.Get(srv.URL + "/logout?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != testRedirect {
		t.Fatalf("logout: %d %q", res.StatusCode, res.Header.Get("Location"))
	}
	q.Set("client_id", "someone-else")
	if res, err = noRedirect.Get(srv.URL + "/logout?" + q.Encode()); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("wrong client: %d", res.StatusCode)
	}
}

func TestSigningKeysVerifyIssuedTokens(t *testing.T) {
	_, srv, _ := newCognito(t)
	_, tokens := token(t, srv, codeForm(signIn(t, srv, nil), testVerifier))
	jwt := tokens["access_token"].(string)

	res, err := http.Get(srv.URL + "/.well-known/jwks.json")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var set struct {
		Keys []struct{ Kid, Kty, Alg, Use, N, E string } `json:"keys"`
	}
	if err := json.Unmarshal(raw, &set); err != nil || len(set.Keys) != 1 {
		t.Fatalf("%s: %v", raw, err)
	}
	key := set.Keys[0]
	if key.Kty != "RSA" || key.Alg != "RS256" || key.Use != "sig" {
		t.Fatalf("%+v", key)
	}

	parts := strings.Split(jwt, ".")
	headerRaw, _ := base64.RawURLEncoding.DecodeString(parts[0])
	var header struct{ Alg, Kid string }
	if err := json.Unmarshal(headerRaw, &header); err != nil {
		t.Fatal(err)
	}
	if header.Alg != "RS256" || header.Kid != key.Kid {
		t.Fatalf("header %+v", header)
	}
	n, _ := base64.RawURLEncoding.DecodeString(key.N)
	e, _ := base64.RawURLEncoding.DecodeString(key.E)
	public := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if err := rsa.VerifyPKCS1v15(public, crypto.SHA256, sum[:], signature); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoveryDocument(t *testing.T) {
	_, srv, _ := newCognito(t)
	res, err := http.Get(srv.URL + "/.well-known/openid-configuration")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var doc map[string]any
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	if doc["issuer"] != "http://issuer.test" || doc["jwks_uri"] != "http://issuer.test/.well-known/jwks.json" ||
		doc["token_endpoint"] != "http://issuer.test/oauth2/token" || doc["authorization_endpoint"] != "http://issuer.test/oauth2/authorize" {
		t.Fatalf("%v", doc)
	}
}

// Gateway rules: what the API Gateway JWT authorizer checks.

func gatewayFor(t *testing.T, c *Cognito, clock *Clock) http.Handler {
	t.Helper()
	gw := &Gateway{Issuer: "http://issuer.test", Audience: testClient, Keys: c.PublicKeys, Now: clock.Now}
	return gw.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(api.SubFrom(r.Context())))
	}))
}

func call(h http.Handler, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/sync", nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func assertUnauthorized(t *testing.T, name string, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != 401 || strings.TrimSpace(rec.Body.String()) != `{"message":"Unauthorized"}` {
		t.Errorf("%s: %d %q", name, rec.Code, rec.Body.String())
	}
}

func signed(t *testing.T, key *rsa.PrivateKey, kid, alg string, claims map[string]any) string {
	t.Helper()
	head, _ := json.Marshal(map[string]string{"alg": alg, "kid": kid})
	body, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(body)
	sum := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func TestGatewayAcceptsBothCognitoTokenKinds(t *testing.T) {
	c, srv, clock := newCognito(t)
	h := gatewayFor(t, c, clock)
	_, tokens := token(t, srv, codeForm(signIn(t, srv, nil), testVerifier))
	sub := claimsOf(t, tokens["access_token"].(string))["sub"]
	for _, kind := range []string{"access_token", "id_token"} {
		rec := call(h, "Bearer "+tokens[kind].(string))
		if rec.Code != 200 || rec.Body.String() != sub {
			t.Errorf("%s: %d %q", kind, rec.Code, rec.Body.String())
		}
	}
}

func TestGatewayRefuses(t *testing.T) {
	c, srv, clock := newCognito(t)
	h := gatewayFor(t, c, clock)
	_, tokens := token(t, srv, codeForm(signIn(t, srv, nil), testVerifier))
	access := tokens["access_token"].(string)

	stranger, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := clock.Now().Unix()
	claims := func(over map[string]any) map[string]any {
		base := map[string]any{"iss": "http://issuer.test", "sub": "someone", "client_id": testClient, "iat": now, "exp": now + 3600}
		for k, v := range over {
			if v == nil {
				delete(base, k)
			} else {
				base[k] = v
			}
		}
		return base
	}
	kid := c.kid
	parts := strings.Split(access, ".")
	header := func(alg string) string {
		raw, _ := json.Marshal(map[string]string{"alg": alg, "kid": kid})
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	for name, authorization := range map[string]string{
		"no header":        "",
		"not a jwt":        "Bearer nope",
		"empty bearer":     "Bearer ",
		"bad base64":       "Bearer !!!.!!!.!!!",
		"tampered payload": "Bearer " + parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"x"}`)) + "." + parts[2],
		"tampered sig":     "Bearer " + parts[0] + "." + parts[1] + "." + base64.RawURLEncoding.EncodeToString([]byte("forged")),
		"alg none":         "Bearer " + header("none") + "." + parts[1] + ".",
		"alg hs256":        "Bearer " + header("HS256") + "." + parts[1] + "." + parts[2],
		"unknown key":      "Bearer " + signed(t, stranger, "someone-elses", "RS256", claims(nil)),
		"key id reused":    "Bearer " + signed(t, stranger, kid, "RS256", claims(nil)),
		"wrong issuer":     "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"iss": "http://elsewhere.test"})),
		"no issuer":        "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"iss": nil})),
		"wrong client":     "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"client_id": "someone-else"})),
		"no client or aud": "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"client_id": nil})),
		"wrong aud":        "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"client_id": nil, "aud": "someone-else"})),
		"expired":          "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"exp": now - 1})),
		"no exp":           "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"exp": nil})),
		"not yet valid":    "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"nbf": now + 60})),
		"issued in future": "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"iat": now + 60})),
		"no sub":           "Bearer " + signed(t, c.key, kid, "RS256", claims(map[string]any{"sub": nil})),
	} {
		assertUnauthorized(t, name, call(h, authorization))
	}
}

func TestGatewayRefusesATokenOnceItExpires(t *testing.T) {
	c, srv, clock := newCognito(t)
	h := gatewayFor(t, c, clock)
	_, tokens := token(t, srv, codeForm(signIn(t, srv, nil), testVerifier))
	bearer := "Bearer " + tokens["access_token"].(string)
	if rec := call(h, bearer); rec.Code != 200 {
		t.Fatalf("fresh token: %d", rec.Code)
	}
	clock.Set(clock.Now().Add(time.Hour + time.Second))
	assertUnauthorized(t, "expired", call(h, bearer))
}

func TestGatewayAudienceMayBeAList(t *testing.T) {
	c, _, clock := newCognito(t)
	h := gatewayFor(t, c, clock)
	now := clock.Now().Unix()
	jwt := signed(t, c.key, c.kid, "RS256", map[string]any{
		"iss": "http://issuer.test", "sub": "someone", "aud": []string{"other", testClient}, "iat": now, "exp": now + 60,
	})
	if rec := call(h, "Bearer "+jwt); rec.Code != 200 {
		t.Fatalf("%d", rec.Code)
	}
}

func TestClockFollowsSystemTimeUntilSet(t *testing.T) {
	var clock Clock
	if d := time.Since(clock.Now()); d < 0 || d > time.Minute {
		t.Fatalf("unset clock is %v off", d)
	}
	at := time.Unix(1800000000, 0)
	clock.Set(at)
	if !clock.Now().Equal(at) {
		t.Fatal("set clock must stay put")
	}
	clock.Set(time.Time{})
	if d := time.Since(clock.Now()); d < 0 || d > time.Minute {
		t.Fatalf("reset clock is %v off", d)
	}
}
