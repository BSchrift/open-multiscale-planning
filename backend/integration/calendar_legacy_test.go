package integration

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

// A legacy connection left beside its person's own goes with the next schedule, and their sync carries on, on their own.
func TestALeftoverLegacyConnectionIsRetired(t *testing.T) {
	needs(t, fakeGoogle, fakeClock, moto, localTables)
	clock := holdClock(t)
	ctx, secrets := context.Background(), motoSSM(t)
	a := connectedUser(t)
	_, token, err := localConnection(t, a, localSub(a.username))
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(map[string]string{"refresh_token": token, "sub": localSub(a.username)})
	name := aws.String(localSecrets + "refresh-token")
	if _, err := secrets.PutParameter(ctx, &ssm.PutParameterInput{
		Name: name, Value: aws.String(string(legacy)), Type: ssmtypes.ParameterTypeSecureString, Overwrite: aws.Bool(true),
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { secrets.DeleteParameter(ctx, &ssm.DeleteParameterInput{Name: name}) })

	clock.advance(31 * time.Minute)
	a.reSignIn()
	// A stream run may come first; the schedule follows, from this tick or the background one.
	for range 3 {
		if tick(t) == "" {
			break
		}
	}
	if _, err := secrets.GetParameter(ctx, &ssm.GetParameterInput{Name: name}); err == nil {
		t.Fatal("the legacy connection is still there")
	}
	start := clock.now.Add(2 * time.Hour)
	a.pushBlock(fresh("after"), "After", start, start.Add(time.Hour))
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != "After" || calendarFields(t, a)["last_error"] != nil {
		t.Fatalf("%+v %+v", event, calendarFields(t, a))
	}
}
