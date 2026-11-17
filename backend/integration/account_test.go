package integration

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// recordTypes is one of every kind of record the apps write today, and memo, a note, which the server has never heard
// of: an export takes every type alike.
var recordTypes = []string{
	"objective", "project", "milestone", "task", "task_completion", "time_block", "block_outcome", "practice",
	"week_plan", "week_pick", "away", "settings", "calendar_source", "attachment", "memo",
}

// subOf reads a token's sub, as a device does to tell accounts apart. Not verified: the API checks every token.
func subOf(t *testing.T, token string) string {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
	var claims struct{ Sub string }
	if err != nil || json.Unmarshal(raw, &claims) != nil || claims.Sub == "" {
		t.Fatalf("no sub in %q", token)
	}
	return claims.Sub
}

type exportAnswer struct {
	State string `json:"state"`
	URL   string `json:"url"`
}

// export asks for an export, waits for it to build and fetches it, as the app does, and returns its files by name.
func (a *account) export() map[string][]byte {
	a.t.Helper()
	res := request(a.t, "POST", "/account/export", a.tokens.access, nil)
	if res.status != 202 {
		a.t.Fatalf("start export: %d %s", res.status, truncated(res.body))
	}
	var answer exportAnswer
	for wait := time.Now().Add(3 * time.Minute); answer.State != "ready"; time.Sleep(time.Second) {
		if time.Now().After(wait) {
			a.t.Fatalf("the export never finished: %+v", answer)
		}
		res = request(a.t, "GET", "/account/export", a.tokens.access, nil)
		if res.status != 200 || json.Unmarshal(res.body, &answer) != nil || (answer.State != "building" && answer.State != "ready") {
			a.t.Fatalf("export: %d %s", res.status, truncated(res.body))
		}
	}
	// Handed out once.
	if again := request(a.t, "GET", "/account/export", a.tokens.access, nil); !strings.Contains(string(again.body), `"state":"none"`) {
		a.t.Fatalf("the link was handed out again: %s", truncated(again.body))
	}
	got := direct(a.t, "GET", answer.URL, nil, nil)
	if got.status != 200 || !strings.HasPrefix(got.header.Get("Content-Disposition"), `attachment; filename="multiscale-export-`) {
		a.t.Fatalf("download: %d %v", got.status, got.header)
	}
	archive, err := zip.NewReader(bytes.NewReader(got.body), int64(len(got.body)))
	if err != nil {
		a.t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, f := range archive.File {
		r, err := f.Open()
		if err != nil {
			a.t.Fatal(err)
		}
		files[f.Name], _ = io.ReadAll(r)
		r.Close()
	}
	return files
}

func exportedIDs(t *testing.T, files map[string][]byte, recordType string) []string {
	t.Helper()
	var list []struct{ ID string }
	if err := json.Unmarshal(files["records/"+recordType+".json"], &list); err != nil {
		t.Fatalf("records/%s.json: %v", recordType, err)
	}
	ids := make([]string, len(list))
	for i, r := range list {
		ids[i] = r.ID
	}
	return ids
}

// Every kind of record, a note's Markdown, and a photo, from the server's copy, in a zip behind a link that works once.
func TestAnExportHoldsEveryRecordTypeAndFile(t *testing.T) {
	needs(t, filesStored)
	a := signIn(t)
	ids := map[string]string{}
	var changes []record
	for _, kind := range recordTypes {
		ids[kind] = fresh(kind)
		changes = append(changes, a.record(kind, ids[kind], "title", "Exported "+kind))
	}
	a.sync(a.startCursor(), changes...)
	photo := []byte("a photo for the export, " + fresh("bytes"))
	photoID := fresh("photo")
	a.attach(photoID, photo, "name", "receipt.jpg")
	grant := a.grantUpload(photoID)
	if res := direct(t, "PUT", grant.URL, photo, grant.Headers); res.status != 200 {
		t.Fatalf("upload: %d", res.status)
	}

	files := a.export()
	for kind, id := range ids {
		if !slices.Contains(exportedIDs(t, files, kind), id) {
			t.Errorf("records/%s.json is missing %s", kind, id)
		}
	}
	if !bytes.Equal(files["files/"+photoID+"/receipt.jpg"], photo) {
		t.Errorf("the photo isn't in files/: %v", names(files))
	}
	if !bytes.Contains(files["README.md"], []byte("records/")) {
		t.Errorf("README %q", files["README.md"])
	}
	found := false
	for name, body := range files {
		found = found || (strings.HasPrefix(name, "notes/") && bytes.Contains(body, []byte("# Exported memo")))
	}
	if !found {
		t.Errorf("no note in notes/: %v", names(files))
	}
}

func names(files map[string][]byte) []string {
	var list []string
	for name := range files {
		list = append(list, name)
	}
	slices.Sort(list)
	return list
}

// One person's export never holds another's records or files.
func TestAnExportHoldsOnlyItsOwnersData(t *testing.T) {
	needs(t, filesStored, secondUser)
	a, other := signIn(t), signInOther(t)
	mine := fresh("task")
	a.sync(a.startCursor(), a.record("task", mine, "title", "Mine"))
	theirs := fresh("task")
	other.sync(other.startCursor(), other.record("task", theirs, "title", "Theirs"))
	for name, body := range other.export() {
		if bytes.Contains(body, []byte(mine)) || strings.Contains(name, mine) {
			t.Fatalf("the other user's export holds this one's task, in %s", name)
		}
	}
}

func TestTheAccountRoutesNeedTheirOwnersToken(t *testing.T) {
	needs(t)
	for _, route := range [][2]string{{"POST", "/account/export"}, {"GET", "/account/export"}, {"POST", "/account/delete"}} {
		if res := request(t, route[0], route[1], "", []byte(`{"confirm":"DELETE"}`)); res.status != 401 {
			t.Errorf("%v without a token: %d", route, res.status)
		}
	}
	for _, token := range []string{"", "not-a-token"} {
		if res := request(t, "POST", "/account/status", token, nil); res.status != 401 || res.errorCode() != "invalid_token" {
			t.Errorf("status with %q: %d %s", token, res.status, truncated(res.body))
		}
	}
	// A real token's account is there: this also proves the API reads the user pool's signing keys.
	a := signIn(t)
	if res := request(t, "POST", "/account/status", a.tokens.access, nil); res.status != 200 || strings.TrimSpace(string(res.body)) != `{"deleted":false}` {
		t.Errorf("status: %d %s", res.status, truncated(res.body))
	}
	// Deleting takes the typed confirmation.
	if res := request(t, "POST", "/account/delete", a.tokens.access, []byte(`{}`)); res.status != 400 {
		t.Errorf("delete without the confirmation: %d", res.status)
	}
}

// partition is every sort key the local table holds under a user's partition.
func partition(t *testing.T, sub string) []string {
	t.Helper()
	client := dynamodb.New(dynamodb.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(os.Getenv("INTEGRATION_DYNAMODB_ENDPOINT")),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	out, err := client.Query(context.Background(), &dynamodb.QueryInput{
		TableName: aws.String("multiscale-local"), KeyConditionExpression: aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": &types.AttributeValueMemberS{Value: "user#" + sub}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var sks []string
	for _, item := range out.Items {
		sks = append(sks, item["sk"].(*types.AttributeValueMemberS).Value)
	}
	return sks
}

// The whole deletion: a fresh sign-in and the typed confirmation, every device refused at once, the sign-in, files and
// records gone, and someone else's account as it was.
func TestDeletingAnAccountRemovesItAndLeavesOthersAlone(t *testing.T) {
	needs(t, disposableUser, fakeClock, localTables, filesStored, secondUser)
	clock := holdClock(t)
	a, other := signIn(t), signInOther(t)
	sub := subOf(t, a.tokens.access)
	secondDevice := newAccount(t, a.username, a.login)

	var changes []record
	for _, kind := range recordTypes {
		changes = append(changes, a.record(kind, fresh(kind), "title", "Gone with the account"))
	}
	a.sync(a.startCursor(), changes...)
	photo, photoID := []byte("a photo that goes with the account"), fresh("photo")
	a.attach(photoID, photo)
	// Deleted with the account, so nothing is left to tombstone.
	a.pushed = map[[2]string]bool{}
	grant := a.grantUpload(photoID)
	if res := direct(t, "PUT", grant.URL, photo, grant.Headers); res.status != 200 {
		t.Fatalf("upload: %d", res.status)
	}
	theirs, theirPhoto := fresh("task"), fresh("photo")
	other.sync(other.startCursor(), other.record("task", theirs, "title", "Kept"))
	other.attach(theirPhoto, photo)
	otherGrant := other.grantUpload(theirPhoto)
	if res := direct(t, "PUT", otherGrant.URL, photo, otherGrant.Headers); res.status != 200 {
		t.Fatalf("upload: %d", res.status)
	}
	otherBefore := partition(t, subOf(t, other.tokens.access))

	// A sign-in from more than 10 minutes ago isn't enough, however fresh its token.
	clock.advance(11 * time.Minute)
	a.tokens.access, _ = refreshAccess(t, a.tokens.refresh)
	if res := request(t, "POST", "/account/delete", a.tokens.access, []byte(`{"confirm":"DELETE"}`)); res.status != 403 || res.errorCode() != "sign_in_again" {
		t.Fatalf("an old sign-in: %d %s", res.status, truncated(res.body))
	}
	a.reSignIn()
	link := a.grantDownloads(photoID).Files[0].URL
	if res := request(t, "POST", "/account/delete", a.tokens.access, []byte(`{"confirm":"DELETE"}`)); res.status != 202 {
		t.Fatalf("delete: %d %s", res.status, truncated(res.body))
	}

	// Every device that still holds a good token is refused from now on, with a code the app wipes its copy on.
	for name, device := range map[string]*account{"this device": a, "a second device": secondDevice} {
		if res := device.send(0); res.status != 401 || res.errorCode() != "account_deleted" {
			t.Fatalf("%s's sync: %d %s", name, res.status, truncated(res.body))
		}
		if res := device.askUpload(photoID); res.status != 401 || res.errorCode() != "account_deleted" {
			t.Fatalf("%s's upload: %d %s", name, res.status, truncated(res.body))
		}
	}
	// The job runs at once: the file goes, and with it the sign-in.
	for wait := time.Now().Add(30 * time.Second); direct(t, "GET", link, nil, nil).status != 404; time.Sleep(200 * time.Millisecond) {
		if time.Now().After(wait) {
			t.Fatal("the photo is still in the bucket")
		}
	}
	if _, err := refreshAccess(t, a.tokens.refresh); err == nil {
		t.Fatal("the deleted account's refresh token still works")
	}
	if res := request(t, "POST", "/account/status", a.tokens.access, nil); strings.TrimSpace(string(res.body)) != `{"deleted":true}` {
		t.Fatalf("status: %d %s", res.status, truncated(res.body))
	}

	// Once no token from before can be good, the schedule's run leaves nothing at all.
	clock.advance(71 * time.Minute)
	if res := request(t, "POST", "/_local/account/resume", "", nil); res.status != 204 {
		t.Fatalf("resume: %d", res.status)
	}
	if left := partition(t, sub); len(left) != 0 {
		t.Fatalf("left in DynamoDB: %v", left)
	}
	// A lapsed token still learns its account is gone.
	if res := request(t, "POST", "/account/status", a.tokens.access, nil); strings.TrimSpace(string(res.body)) != `{"deleted":true}` {
		t.Fatalf("status with a lapsed token: %d %s", res.status, truncated(res.body))
	}

	// The other account is as it was.
	other.reSignIn()
	if got := partition(t, subOf(t, other.tokens.access)); !slices.Equal(got, otherBefore) {
		t.Fatalf("the other account's items changed: %v, want %v", got, otherBefore)
	}
	if _, ok := other.get("task", theirs); !ok {
		t.Fatal("the other account's task went")
	}
	if res := direct(t, "GET", other.grantDownloads(theirPhoto).Files[0].URL, nil, nil); res.status != 200 || !bytes.Equal(res.body, photo) {
		t.Fatalf("the other account's photo: %d", res.status)
	}
	if res := request(t, "POST", "/account/status", other.tokens.access, nil); strings.TrimSpace(string(res.body)) != `{"deleted":false}` {
		t.Fatalf("the other account's status: %s", truncated(res.body))
	}
}

// One person's token deletes only their own account, whatever the request says.
func TestADeletionNamesNoOneButTheTokensOwner(t *testing.T) {
	needs(t, disposableUser, secondUser)
	a, other := signIn(t), signInOther(t)
	kept := fresh("task")
	other.sync(other.startCursor(), other.record("task", kept, "title", "Kept"))
	body := []byte(fmt.Sprintf(`{"confirm":"DELETE","sub":%q,"user":%q}`, subOf(t, other.tokens.access), other.username))
	if res := request(t, "POST", "/account/delete?sub="+url.QueryEscape(subOf(t, other.tokens.access)), a.tokens.access, body); res.status != 202 {
		t.Fatalf("delete: %d %s", res.status, truncated(res.body))
	}
	if res := other.send(0); res.status != 200 {
		t.Fatalf("the other account was refused: %d %s", res.status, truncated(res.body))
	}
	if _, ok := other.get("task", kept); !ok {
		t.Fatal("the other account's task went")
	}
	if res := a.send(0); res.errorCode() != "account_deleted" {
		t.Fatalf("the caller's own account wasn't deleted: %d %s", res.status, truncated(res.body))
	}
}
