package account

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"slices"
	"strings"
	gosync "sync"
	"time"
)

// maxTokenAge bounds how old a lapsed token may be and still be read: past the app's refresh tokens' 365 days, no
// device can still be signed in on one.
const maxTokenAge = 400 * 24 * time.Hour

// Tokens reads who an access token was issued to, for a device whose token has lapsed and whose refresh was refused: it
// asks whether its account was deleted. The signature, issuer, client and use are checked as the gateway checks them;
// the expiry isn't, since lapsed is the point.
type Tokens struct {
	Issuer    string
	ClientIDs []string
	Keys      func(ctx context.Context) (map[string]*rsa.PublicKey, error)
	Now       func() time.Time
}

type claims struct {
	Iss      string `json:"iss"`
	Sub      string `json:"sub"`
	ClientID string `json:"client_id"`
	TokenUse string `json:"token_use"`
	Iat      int64  `json:"iat"`
}

// Subject is the sub of a token the user pool signed, and whether it was one.
func (t *Tokens) Subject(ctx context.Context, token string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", false
	}
	var head struct{ Alg, Kid string }
	if !decode(parts[0], &head) || head.Alg != "RS256" {
		return "", false
	}
	keys, err := t.Keys(ctx)
	if err != nil || keys[head.Kid] == nil {
		return "", false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(keys[head.Kid], crypto.SHA256, sum[:], signature) != nil {
		return "", false
	}
	var c claims
	if !decode(parts[1], &c) {
		return "", false
	}
	issued := time.Unix(c.Iat, 0)
	now := t.Now()
	if c.Iss != t.Issuer || c.Sub == "" || c.TokenUse != "access" || !slices.Contains(t.ClientIDs, c.ClientID) ||
		issued.After(now.Add(5*time.Minute)) || now.Sub(issued) > maxTokenAge {
		return "", false
	}
	return c.Sub, true
}

func decode(segment string, into any) bool {
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	return err == nil && json.Unmarshal(raw, into) == nil
}

// JWKS fetches the user pool's signing keys, and keeps them for an hour.
type JWKS struct {
	URL    string
	Client *http.Client

	mu      gosync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

func (j *JWKS) Keys(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.keys != nil && time.Since(j.fetched) < time.Hour {
		return j.keys, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, j.URL, nil)
	if err != nil {
		return nil, err
	}
	res, err := j.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errors.New("account: signing keys answered " + res.Status)
	}
	var body struct {
		Keys []struct{ Kid, Kty, N, E string }
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range body.Keys {
		n, errN := base64.RawURLEncoding.DecodeString(k.N)
		e, errE := base64.RawURLEncoding.DecodeString(k.E)
		if k.Kty != "RSA" || errN != nil || errE != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	j.keys, j.fetched = keys, time.Now()
	return keys, nil
}
