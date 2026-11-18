package account_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	cognito "github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
)

const verifier = "a-verifier-long-enough-to-meet-the-pkce-minimum-length"

// signInTo signs username in to the stand-in pool and returns the token endpoint's answer, or its status on a refusal.
func signInTo(t *testing.T, srv *httptest.Server, username string) (int, map[string]any) {
	t.Helper()
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"response_type": {"code"}, "client_id": {"local-client"}, "redirect_uri": {"multiscale://signed-in"}, "username": {username},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(srv.URL + "/oauth2/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		return res.StatusCode, nil
	}
	location, _ := url.Parse(res.Header.Get("Location"))
	return post(t, srv, url.Values{
		"grant_type": {"authorization_code"}, "client_id": {"local-client"}, "code": {location.Query().Get("code")},
		"code_verifier": {verifier}, "redirect_uri": {"multiscale://signed-in"},
	})
}

func post(t *testing.T, srv *httptest.Server, form url.Values) (int, map[string]any) {
	t.Helper()
	res, err := http.Post(srv.URL+"/oauth2/token", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	json.NewDecoder(res.Body).Decode(&body)
	return res.StatusCode, body
}

func payload(t *testing.T, jwt string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(strings.Split(jwt, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	json.Unmarshal(raw, &claims)
	return claims
}

// The SDK calls the deployed pool makes, against the local stack's stand-in, so both agree on the wire.
func TestCognitoIdentityFindsAndDeletesASignIn(t *testing.T) {
	clock := &fakes.Clock{}
	clock.Set(time.Unix(1800000000, 0))
	pool, err := fakes.NewCognito("http://issuer.test", "local-client", clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(pool)
	defer srv.Close()
	identity := &account.CognitoIdentity{PoolID: "local", Client: cognito.New(cognito.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(srv.URL), Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})}
	ctx := context.Background()

	_, tokens := signInTo(t, srv, "alice@example.com")
	sub := payload(t, tokens["access_token"].(string))["sub"].(string)
	signInTo(t, srv, "bob@example.com")
	if exists, err := identity.Exists(ctx, sub); err != nil || !exists {
		t.Fatalf("Exists = %v, %v", exists, err)
	}
	if email, err := identity.Email(ctx, sub); err != nil || email != "alice@example.com" {
		t.Fatalf("Email = %q, %v", email, err)
	}
	// A refresh an hour later still says when the sign-in was.
	clock.Set(time.Unix(1800003600, 0))
	status, refreshed := post(t, srv, url.Values{"grant_type": {"refresh_token"}, "client_id": {"local-client"}, "refresh_token": {tokens["refresh_token"].(string)}})
	if status != 200 || payload(t, refreshed["access_token"].(string))["auth_time"] != float64(1800000000) {
		t.Fatalf("%d %v", status, refreshed)
	}

	if err := identity.Delete(ctx, sub); err != nil {
		t.Fatal(err)
	}
	if exists, err := identity.Exists(ctx, sub); err != nil || exists {
		t.Fatalf("Exists after delete = %v, %v", exists, err)
	}
	if status, _ := post(t, srv, url.Values{"grant_type": {"refresh_token"}, "client_id": {"local-client"}, "refresh_token": {tokens["refresh_token"].(string)}}); status != 400 {
		t.Fatalf("a deleted user's refresh: %d", status)
	}
	if status, _ := signInTo(t, srv, "alice@example.com"); status != 400 {
		t.Fatalf("a deleted user signed in again: %d", status)
	}
	// Deleting again is fine, and touched no one else.
	if err := identity.Delete(ctx, sub); err != nil {
		t.Fatal(err)
	}
	if status, _ := signInTo(t, srv, "bob@example.com"); status != 200 {
		t.Fatalf("bob can't sign in: %d", status)
	}
	if _, err := identity.Exists(ctx, `x" or sub = "y`); err == nil {
		t.Fatal("a sub that closes the filter's quote was sent")
	}
}

// A user the pool answers with whose sub isn't the one asked about is never taken for it.
func TestCognitoIdentityTakesOnlyTheUserWithThatSub(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		if r.Header.Get("X-Amz-Target") == "AWSCognitoIdentityProviderService.AdminDeleteUser" {
			t.Error("deleted a user whose sub didn't match")
		}
		json.NewEncoder(w).Encode(map[string]any{"Users": []any{map[string]any{
			"Username": "someone-else", "Attributes": []any{map[string]string{"Name": "sub", "Value": "another-sub"}},
		}}})
	}))
	defer srv.Close()
	identity := &account.CognitoIdentity{PoolID: "local", Client: cognito.New(cognito.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(srv.URL), Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})}
	if _, err := identity.Exists(context.Background(), "the-sub"); err == nil {
		t.Fatal("took another user for this sub")
	}
	if err := identity.Delete(context.Background(), "the-sub"); err == nil {
		t.Fatal("deleted, or said it had, another user")
	}
}
