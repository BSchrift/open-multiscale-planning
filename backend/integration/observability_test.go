package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

func motoSSM(t *testing.T) *ssm.Client {
	t.Helper()
	endpoint := os.Getenv("INTEGRATION_SSM_ENDPOINT")
	if endpoint == "" {
		t.Fatal("INTEGRATION_SSM_ENDPOINT is required for moto")
	}
	return ssm.New(ssm.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
}

const localSecrets = "/multiscale/local/google/"

func TestMotoKeepsSecureStringsEncrypted(t *testing.T) {
	needs(t, moto)
	client, ctx := motoSSM(t), context.Background()
	name := "/" + fresh("secure") + "/value"
	const plain = "a-value-only-a-decrypting-read-sees"
	if _, err := client.PutParameter(ctx, &ssm.PutParameterInput{
		Name: aws.String(name), Value: aws.String(plain), Type: ssmtypes.ParameterTypeSecureString,
	}); err != nil {
		t.Fatal(err)
	}
	decrypted, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name), WithDecryption: aws.Bool(true)})
	if err != nil {
		t.Fatal(err)
	}
	if aws.ToString(decrypted.Parameter.Value) != plain || decrypted.Parameter.Type != ssmtypes.ParameterTypeSecureString {
		t.Fatalf("%+v", decrypted.Parameter)
	}
	raw, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name), WithDecryption: aws.Bool(false)})
	if err != nil {
		t.Fatal(err)
	}
	if aws.ToString(raw.Parameter.Value) == plain {
		t.Fatal("a read without decryption saw the value")
	}
}

// localConnection reads a's Google connection from the local stack's table, and opens its token with Moto's KMS under
// the context of the person given, as the worker does.
func localConnection(t *testing.T, a *account, as string) (map[string]dynamotypes.AttributeValue, string, error) {
	t.Helper()
	creds := credentials.NewStaticCredentialsProvider("dummy", "dummy", "")
	db := dynamodb.New(dynamodb.Options{Region: "us-west-2", BaseEndpoint: aws.String(os.Getenv("INTEGRATION_DYNAMODB_ENDPOINT")), Credentials: creds})
	item, err := db.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String("multiscale-local"),
		Key: map[string]dynamotypes.AttributeValue{
			"pk": &dynamotypes.AttributeValueMemberS{Value: "google#connection"},
			"sk": &dynamotypes.AttributeValueMemberS{Value: localSub(a.username)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	sealed, ok := item.Item["token"].(*dynamotypes.AttributeValueMemberB)
	if !ok {
		return item.Item, "", errors.New("no token stored")
	}
	keys := kms.New(kms.Options{Region: "us-west-2", BaseEndpoint: aws.String(os.Getenv("INTEGRATION_SSM_ENDPOINT")), Credentials: creds})
	opened, err := keys.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob: sealed.Value, EncryptionContext: map[string]string{"purpose": "google-refresh-token", "env": "local", "sub": as},
	})
	if err != nil {
		return item.Item, "", err
	}
	return item.Item, string(opened.Plaintext), nil
}

// A person's connection is in the table, sealed by KMS for them alone, and the deployment's one connection from before
// isn't written any more.
func TestConnectionIsStoredEncryptedForThePersonAlone(t *testing.T) {
	needs(t, moto, fakeGoogle, localTables)
	client, ctx := motoSSM(t), context.Background()
	a := connectedUser(t)
	for _, name := range []string{"client-id", "client-secret", "state-secret"} {
		out, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(localSecrets + name), WithDecryption: aws.Bool(true)})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if out.Parameter.Type != ssmtypes.ParameterTypeSecureString {
			t.Errorf("%s is %s", name, out.Parameter.Type)
		}
	}
	if _, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(localSecrets + "refresh-token")}); err == nil {
		t.Fatal("the connection was stored as the deployment's one")
	}
	item, token, err := localConnection(t, a, localSub(a.username))
	if err != nil || token == "" {
		t.Fatalf("their own connection doesn't open for them: %v", err)
	}
	for name, value := range item {
		if strings.Contains(fmt.Sprint(value), token) {
			t.Fatalf("%s holds the token in the clear", name)
		}
	}
	if _, _, err := localConnection(t, a, localSub("someone-else")); err == nil {
		t.Fatal("opened for another person")
	}
}

// The local Cognito's sub for a username. Only used to check that it never reaches a log.
func localSub(username string) string {
	sum := sha256.Sum256([]byte(username))
	return hex.EncodeToString(sum[:16])
}

// A known marker goes everywhere a value can go, through sync and the worker, then nothing may have logged it.
func TestLogsNeverCarryValuesTitlesOrTokens(t *testing.T) {
	needs(t, capturedLogs, fakeGoogle, moto, localTables)
	path := os.Getenv("INTEGRATION_LOGS")
	if path == "" {
		t.Fatal("INTEGRATION_LOGS is required for capturedLogs")
	}
	offset, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	marker := "marker" + strings.ToLower(runID)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)

	// As an id, a field name, a device, a title, a time zone and a nested value.
	block := marker + "-block"
	clock := clockAt(time.Now(), 0, marker)
	a.sync(a.startCursor(),
		record{"task", "task-" + block, map[string]field{"title": {marker, clock}, marker: {map[string]any{"deep": []any{marker}}, clock}}},
		record{"time_block", block, map[string]field{
			"task_id": {"task-" + block, clock}, "start": {instantOf(start), clock}, "end": {instantOf(start.Add(time.Hour)), clock}, "tz": {marker, clock},
		}},
	)
	// In a calendar the worker reads, and in a calendar's name.
	home := marker + "@example.test"
	googleControl(t, a, "calendars", map[string]string{"id": home, "summary": marker})
	t.Cleanup(func() { request(t, "POST", "/google/_test/calendars/"+url.PathEscape(home)+"/delete", "", nil) })
	addGoogleEvent(t, a, home, marker, start, start.Add(time.Hour))
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != marker {
		t.Fatalf("the marker didn't reach Google: %+v", event)
	}
	if got := mirrored(t, a, home); len(got) != 1 || got[0]["title"] != marker {
		t.Fatalf("the marker didn't come back from Google: %+v", got)
	}
	// In what gets refused, where an error is the tempting thing to log.
	for _, body := range []string{
		changeBody(marker, marker, titled(`"`+marker+`"`)),
		changeBody("task", marker+" bad", titled(`"`+marker+`"`)),
		changeBody("task", marker, fmt.Sprintf(`{"title":{"v":%q,"c":%q}}`, marker, marker)),
		`{"marker":"` + marker + ``,
	} {
		if res := a.sendRaw([]byte(body)); res.status != 400 {
			t.Fatalf("%d %s", res.status, res.body)
		}
	}
	request(t, "POST", "/sync", marker, []byte(`{}`))
	request(t, "GET", "/calendar/callback?state="+marker+"&code="+marker, "", nil)
	request(t, "GET", "/"+marker, "", nil)
	// A run Google holds back for quota, which is where an error's text could quote Google.
	googleControl(t, a, "rate_limit", map[string]int{"calls": 1})
	runWorker(t, a)
	runWorker(t, a)
	// And one that fails, with no answer from Google.
	cutGoogle(t, outage{Account: a.googleAccount(), Calls: 1, Status: 503})
	runWorker(t, a)
	liftOutage(t)

	_, googleToken, err := localConnection(t, a, localSub(a.username))
	if err != nil || googleToken == "" {
		t.Fatalf("no stored connection: %v", err)
	}
	clientSecret, err := motoSSM(t).GetParameter(context.Background(), &ssm.GetParameterInput{Name: aws.String(localSecrets + "client-secret"), WithDecryption: aws.Bool(true)})
	if err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	captured := string(raw[offset.Size():])
	leaks := map[string]string{
		"the marker": marker, "the access token": a.tokens.access, "the refresh token": a.tokens.refresh,
		"the user's sub": localSub(a.username), "the username": a.username, "the Google token": googleToken,
		"the Google account's address": a.googleAccount(),
		"the client secret":            aws.ToString(clientSecret.Parameter.Value), "a Google calendar id": timeBlocks(t, a).ID,
	}
	for name, value := range leaks {
		if strings.Contains(captured, value) {
			t.Errorf("%s reached the logs", name)
		}
	}

	// The scan only means something if the lines it read are the ones that matter.
	seen := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(captured), "\n") {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Errorf("not a JSON line: %s", line)
			continue
		}
		switch {
		case entry["route"] == "POST /sync" && entry["status"] == float64(200):
			seen["sync ok"]++
			if entry["request_id"] == "" || entry["user"] == nil || entry["duration_ms"] == nil || entry["changes"] == nil {
				t.Errorf("thin request line: %s", line)
			}
			checkMetrics(t, entry, "SyncRecordsMerged", "SyncConflictRetries", "SyncRequestsRejected")
		case entry["route"] == "POST /sync" && entry["status"] == float64(400):
			seen["sync rejected"]++
			if entry["SyncRequestsRejected"] != float64(1) || entry["error_type"] == nil {
				t.Errorf("rejection not counted: %s", line)
			}
		case entry["msg"] == "calendar_run" && entry["outcome"] == "ok":
			seen["worker ok"]++
			if entry["blocks"] == nil || entry["events_read"] == nil || entry["user"] == nil {
				t.Errorf("thin worker line: %s", line)
			}
			checkMetrics(t, entry, "CalendarEventsChanged", "CalendarRunFailures")
		case entry["msg"] == "calendar_run" && entry["outcome"] == "rate_limited":
			seen["worker held back by quota"]++
			if entry["error_type"] != "calendar_rate_limited" || entry["CalendarRunFailures"] != float64(0) {
				t.Errorf("one person's quota counted as the worker failing: %s", line)
			}
			checkMetrics(t, entry, "CalendarRateLimited", "CalendarRunFailures")
		case entry["msg"] == "calendar_run" && entry["outcome"] == "failed":
			seen["worker failed"]++
			if entry["error_type"] != "calendar_failed" {
				t.Errorf("worker failure: %s", line)
			}
			checkMetrics(t, entry, "CalendarRunFailures")
		case entry["route"] == "GET /calendar/callback" && entry["status"] == float64(400):
			seen["callback refused"]++
		}
	}
	for _, want := range []string{"sync ok", "sync rejected", "worker ok", "worker held back by quota", "worker failed", "callback refused"} {
		if seen[want] == 0 {
			t.Errorf("no %s line among %d captured bytes", want, len(captured))
		}
	}
}

func checkMetrics(t *testing.T, entry map[string]any, names ...string) {
	t.Helper()
	emf, _ := entry["_aws"].(map[string]any)
	if emf == nil {
		t.Errorf("no metrics on %v", entry["msg"])
		return
	}
	directive := emf["CloudWatchMetrics"].([]any)[0].(map[string]any)
	if directive["Namespace"] != "Multiscale/local" {
		t.Errorf("namespace %v", directive["Namespace"])
	}
	dimensions := directive["Dimensions"].([]any)
	if len(dimensions) != 1 || len(dimensions[0].([]any)) != 0 {
		t.Errorf("each dimension is a billed metric: %v", dimensions)
	}
	for _, name := range names {
		if _, ok := entry[name].(float64); !ok {
			t.Errorf("no %s in %v", name, entry)
		}
	}
}
