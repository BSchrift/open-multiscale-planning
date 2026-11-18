package fakes

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
)

// Gateway checks tokens by the rules of API Gateway's JWT authorizer: an RS256 signature from a known key, the issuer,
// an aud or client_id in the audience, and exp, nbf and iat against the clock.
type Gateway struct {
	Issuer   string
	Audience string
	Keys     func() map[string]*rsa.PublicKey
	Now      func() time.Time
}

// Require passes only requests with a valid token, carrying its sub the way the Lambda adapter does.
func (g *Gateway) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := g.verify(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if !ok {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "Unauthorized"})
			return
		}
		ctx := api.WithSub(r.Context(), claims.Sub)
		if claims.AuthTime != nil {
			ctx = api.WithAuthTime(ctx, time.Unix(*claims.AuthTime, 0))
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type tokenClaims struct {
	Iss      string          `json:"iss"`
	Sub      string          `json:"sub"`
	ClientID string          `json:"client_id"`
	Aud      json.RawMessage `json:"aud"`
	Exp      *int64          `json:"exp"`
	Nbf      *int64          `json:"nbf"`
	Iat      *int64          `json:"iat"`
	AuthTime *int64          `json:"auth_time"`
}

func (g *Gateway) verify(token string) (tokenClaims, bool) {
	var claims tokenClaims
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims, false
	}
	var head struct{ Alg, Kid string }
	if !decodeSegment(parts[0], &head) || head.Alg != "RS256" {
		return claims, false
	}
	key := g.Keys()[head.Kid]
	if key == nil {
		return claims, false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return claims, false
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], signature) != nil {
		return claims, false
	}
	if !decodeSegment(parts[1], &claims) {
		return claims, false
	}
	now := g.Now().Unix()
	if claims.Iss != g.Issuer || claims.Sub == "" || claims.Exp == nil || *claims.Exp <= now ||
		(claims.Nbf != nil && *claims.Nbf > now) || (claims.Iat != nil && *claims.Iat > now) {
		return claims, false
	}
	return claims, claims.ClientID == g.Audience || audienceHas(claims.Aud, g.Audience)
}

func audienceHas(raw json.RawMessage, want string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == want
	}
	var many []string
	return json.Unmarshal(raw, &many) == nil && slices.Contains(many, want)
}

func decodeSegment(segment string, into any) bool {
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	return err == nil && json.Unmarshal(raw, into) == nil
}
