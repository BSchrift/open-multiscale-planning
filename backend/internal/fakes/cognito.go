package fakes

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	stdsync "sync"
	"time"
)

const (
	accessTokenTTL  = time.Hour
	refreshTokenTTL = 30 * 24 * time.Hour
	codeTTL         = 5 * time.Minute
	defaultUsername = "local-user"
)

// Clock is the time the fakes and handlers share, so a test can expire tokens. It follows the system until Set, and again after Set with a zero time.
type Clock struct {
	mu    stdsync.Mutex
	fixed time.Time
}

func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fixed.IsZero() {
		return time.Now()
	}
	return c.fixed
}

func (c *Clock) Set(at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fixed = at
}

// Cognito stands in for a user pool's hosted endpoints: authorization code with PKCE, refresh, revoke, sign-out and signing keys. Sign-up
// is off in the real pool, so any username here is an existing user; authorize signs them straight in, with no page.
// Of the pool's own API it has ListUsers by email, which make storage-quota uses to find a person's sub.
type Cognito struct {
	issuer, clientID string
	now              func() time.Time
	key              *rsa.PrivateKey
	kid              string

	mu      stdsync.Mutex
	codes   map[string]authCode
	refresh map[string]refreshGrant
}

type authCode struct {
	username, challenge, redirect string
	expires                       time.Time
}

type refreshGrant struct {
	username string
	expires  time.Time
}

// NewCognito makes a stand-in with a fresh signing key. issuer is the URL it is served at.
func NewCognito(issuer, clientID string, now func() time.Time) (*Cognito, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	return &Cognito{
		issuer: issuer, clientID: clientID, now: now, key: key, kid: randomToken()[:16],
		codes: map[string]authCode{}, refresh: map[string]refreshGrant{},
	}, nil
}

// PublicKeys returns the signing keys by key id.
func (c *Cognito) PublicKeys() map[string]*rsa.PublicKey {
	return map[string]*rsa.PublicKey{c.kid: &c.key.PublicKey}
}

func (c *Cognito) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method + " " + r.URL.Path {
	case "POST /":
		c.listUsers(w, r)
	case "GET /oauth2/authorize":
		c.authorize(w, r)
	case "POST /oauth2/token":
		c.token(w, r)
	case "POST /oauth2/revoke":
		c.revoke(w, r)
	case "GET /logout":
		// There is no browser session here to end, so sign-out just goes back to the app.
		q := r.URL.Query()
		if q.Get("client_id") != c.clientID || q.Get("logout_uri") == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		http.Redirect(w, r, q.Get("logout_uri"), http.StatusFound)
	case "GET /.well-known/jwks.json":
		c.jwks(w)
	case "GET /.well-known/openid-configuration":
		writeJSON(w, http.StatusOK, map[string]any{
			"issuer":                 c.issuer,
			"authorization_endpoint": c.issuer + "/oauth2/authorize",
			"token_endpoint":         c.issuer + "/oauth2/token",
			"jwks_uri":               c.issuer + "/.well-known/jwks.json",
		})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
	}
}

func (c *Cognito) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	redirect := q.Get("redirect_uri")
	if q.Get("response_type") != "code" || q.Get("client_id") != c.clientID || redirect == "" ||
		q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	target, err := url.Parse(redirect)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	username := q.Get("username")
	if username == "" {
		username = defaultUsername
	}
	code := randomToken()
	c.mu.Lock()
	c.codes[code] = authCode{username, q.Get("code_challenge"), redirect, c.now().Add(codeTTL)}
	c.mu.Unlock()

	params := target.Query()
	params.Set("code", code)
	if state := q.Get("state"); state != "" {
		params.Set("state", state)
	}
	target.RawQuery = params.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func (c *Cognito) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil || r.PostForm.Get("client_id") != c.clientID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_client"})
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		c.exchangeCode(w, r.PostForm)
	case "refresh_token":
		c.useRefreshToken(w, r.PostForm)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
	}
}

// revoke ends a refresh token, as signing out does.
func (c *Cognito) revoke(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil || r.PostForm.Get("client_id") != c.clientID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_client"})
		return
	}
	c.mu.Lock()
	delete(c.refresh, r.PostForm.Get("token"))
	c.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (c *Cognito) exchangeCode(w http.ResponseWriter, form url.Values) {
	code := form.Get("code")
	c.mu.Lock()
	grant, found := c.codes[code]
	delete(c.codes, code) // single use, even when this attempt fails
	c.mu.Unlock()
	sum := sha256.Sum256([]byte(form.Get("code_verifier")))
	verified := base64.RawURLEncoding.EncodeToString(sum[:])
	if !found || c.now().After(grant.expires) || grant.redirect != form.Get("redirect_uri") ||
		subtle.ConstantTimeCompare([]byte(verified), []byte(grant.challenge)) != 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	refresh := randomToken()
	c.mu.Lock()
	c.refresh[refresh] = refreshGrant{grant.username, c.now().Add(refreshTokenTTL)}
	c.mu.Unlock()
	c.writeTokens(w, grant.username, refresh)
}

func (c *Cognito) useRefreshToken(w http.ResponseWriter, form url.Values) {
	c.mu.Lock()
	grant, found := c.refresh[form.Get("refresh_token")]
	c.mu.Unlock()
	if !found || c.now().After(grant.expires) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	c.writeTokens(w, grant.username, "")
}

// emailFilter is the one ListUsers filter the stand-in takes: an exact email.
var emailFilter = regexp.MustCompile(`^email\s*=\s*"([^"]+)"$`)

// listUsers answers ListUsers for one email with the user it stands for, as the AWS CLI calls it.
func (c *Cognito) listUsers(w http.ResponseWriter, r *http.Request) {
	var body struct{ Filter string }
	if r.Header.Get("X-Amz-Target") != "AWSCognitoIdentityProviderService.ListUsers" || json.NewDecoder(r.Body).Decode(&body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"__type": "InvalidParameterException"})
		return
	}
	match := emailFilter.FindStringSubmatch(body.Filter)
	if match == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"__type": "InvalidParameterException"})
		return
	}
	email := match[1]
	writeJSON(w, http.StatusOK, map[string]any{"Users": []any{map[string]any{
		"Username": email, "Enabled": true, "UserStatus": "CONFIRMED",
		"Attributes": []any{map[string]string{"Name": "sub", "Value": subOf(email)}, map[string]string{"Name": "email", "Value": email}},
	}}})
}

// subOf is the sub a username's tokens carry.
func subOf(username string) string {
	sum := sha256.Sum256([]byte(username))
	return hex.EncodeToString(sum[:16])
}

// writeTokens sends a new pair. A refresh response carries no refresh token, like a pool without rotation.
func (c *Cognito) writeTokens(w http.ResponseWriter, username, refresh string) {
	now := c.now()
	common := map[string]any{
		"iss": c.issuer, "sub": subOf(username), "iat": now.Unix(), "exp": now.Add(accessTokenTTL).Unix(),
		"jti": randomToken(), "username": username,
	}
	access, err := c.sign(common, map[string]any{"token_use": "access", "client_id": c.clientID, "scope": "openid"})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	// The real pool signs in by email, so the username stands for it.
	id, err := c.sign(common, map[string]any{"token_use": "id", "aud": c.clientID, "email": username})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	body := map[string]any{
		"access_token": access, "id_token": id, "token_type": "Bearer", "expires_in": int(accessTokenTTL.Seconds()),
	}
	if refresh != "" {
		body["refresh_token"] = refresh
	}
	writeJSON(w, http.StatusOK, body)
}

func (c *Cognito) sign(claims ...map[string]any) (string, error) {
	merged := map[string]any{}
	for _, part := range claims {
		for k, v := range part {
			merged[k] = v
		}
	}
	head, err := json.Marshal(map[string]string{"alg": "RS256", "kid": c.kid, "typ": "JWT"})
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(merged)
	if err != nil {
		return "", err
	}
	input := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(body)
	sum := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, c.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (c *Cognito) jwks(w http.ResponseWriter) {
	public := c.key.PublicKey
	writeJSON(w, http.StatusOK, map[string]any{"keys": []map[string]string{{
		"kid": c.kid, "kty": "RSA", "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(public.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(public.E)).Bytes()),
	}}})
}

func randomToken() string {
	raw := make([]byte, 32)
	rand.Read(raw)
	return hex.EncodeToString(raw)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}
