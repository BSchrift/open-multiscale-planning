package integration

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

func TestUnknownRoutesAndMethodsAreNotFound(t *testing.T) {
	needs(t)
	a := signIn(t)
	for _, route := range [][2]string{
		{"GET", "/"}, {"POST", "/"}, {"GET", "/nothing"}, {"POST", "/sync/extra"}, {"POST", "/calendar"},
		{"GET", "/sync"}, {"PUT", "/sync"}, {"DELETE", "/sync"},
		{"GET", "/calendar/connect"}, {"GET", "/calendar/refresh"}, {"GET", "/calendar/disconnect"}, {"POST", "/calendar/callback"}, {"GET", "/v1/logs"},
	} {
		for _, token := range []string{"", a.tokens.access} {
			if res := request(t, route[0], route[1], token, nil); res.status != 404 {
				t.Errorf("%s %s (token %v): %d %s", route[0], route[1], token != "", res.status, truncated(res.body))
			}
		}
	}
}

// The desktop and phone apps load from file:// and capacitor://, so every call is cross-origin.
func TestSmokeBrowserClientsMayCall(t *testing.T) {
	needs(t)
	a := signIn(t)
	for _, path := range protectedRoutes {
		res := request(t, "OPTIONS", path, "", nil, "Origin", "capacitor://localhost", "Access-Control-Request-Method", "POST", "Access-Control-Request-Headers", "authorization,content-type")
		if res.status != 204 || res.header.Get("Access-Control-Allow-Origin") == "" {
			t.Errorf("preflight %s: %d %v", path, res.status, res.header)
		}
		methods := strings.ToUpper(res.header.Get("Access-Control-Allow-Methods"))
		headers := strings.ToLower(res.header.Get("Access-Control-Allow-Headers"))
		if !strings.Contains(methods, "POST") || !strings.Contains(headers, "authorization") || !strings.Contains(headers, "content-type") {
			t.Errorf("preflight %s allows %q and %q", path, methods, headers)
		}
	}
	res := request(t, "POST", "/sync", a.tokens.access, []byte(`{"cursor":0,"changes":[]}`), "Origin", "capacitor://localhost")
	if res.status != 200 || res.header.Get("Access-Control-Allow-Origin") == "" {
		t.Fatalf("%d %v", res.status, res.header)
	}
	res = request(t, "POST", "/sync", "", []byte(`{}`), "Origin", "capacitor://localhost")
	if res.status != 401 || res.header.Get("Access-Control-Allow-Origin") == "" {
		t.Fatalf("an app can't see a 401 without the header: %d %v", res.status, res.header)
	}
}

func nowClock() string { return clockAt(time.Now(), 0, "device") }

func changeBody(recordType, id, fields string) string {
	return fmt.Sprintf(`{"cursor":0,"changes":[{"type":%q,"id":%q,"fields":%s}]}`, recordType, id, fields)
}

func titled(value string) string {
	return fmt.Sprintf(`{"title":{"v":%s,"c":%q}}`, value, nowClock())
}

func nested(depth int) string {
	return strings.Repeat("[", depth) + strings.Repeat("]", depth)
}

// Nothing here reaches the table, so it's as safe on a deployment as anywhere.
func TestSyncRefusesBadRequests(t *testing.T) {
	needs(t)
	a := signIn(t)
	future := clockAt(time.Now().Add(maxClockAhead+time.Hour), 0, "device")
	longID := strings.Repeat("x", 201)
	tooMany := make([]string, 100)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf(`{"type":"task","id":"%s-%d","fields":{}}`, fresh("many"), i)
	}
	cases := []struct {
		name, body string
		status     int
		code       string
	}{
		{"empty body", ``, 400, "invalid_json"},
		{"not json", `hello`, 400, "invalid_json"},
		{"two documents", `{"cursor":0}{"cursor":0}`, 400, "invalid_json"},
		{"wrong shape", `[]`, 400, "invalid_json"},
		{"cursor as text", `{"cursor":"0"}`, 400, "invalid_json"},
		{"fractional cursor", `{"cursor":1.5}`, 400, "invalid_json"},
		{"cursor past int64", `{"cursor":9223372036854775808}`, 400, "invalid_json"},
		{"negative cursor", `{"cursor":-1}`, 400, "invalid_cursor"},
		{"changes not a list", `{"changes":{}}`, 400, "invalid_json"},
		{"100 changes", `{"cursor":0,"changes":[` + strings.Join(tooMany, ",") + `]}`, 400, "too_many_changes"},
		{"type in capitals", changeBody("Task", fresh("r"), titled(`"x"`)), 400, "unknown_type"},
		{"missing type", `{"changes":[{"id":"x","fields":{}}]}`, 400, "unknown_type"},
		{"type with a separator", changeBody("task#x", fresh("r"), titled(`"x"`)), 400, "unknown_type"},
		{"type too long", changeBody(strings.Repeat("x", 65), fresh("r"), titled(`"x"`)), 400, "unknown_type"},
		{"empty id", changeBody("task", "", titled(`"x"`)), 400, "invalid_id"},
		{"id with a space", changeBody("task", "a b", titled(`"x"`)), 400, "invalid_id"},
		{"id with a control", changeBody("task", "a\nb", titled(`"x"`)), 400, "invalid_id"},
		{"id too long", changeBody("task", longID, titled(`"x"`)), 400, "invalid_id"},
		{"no fields", `{"changes":[{"type":"task","id":"x"}]}`, 400, "invalid_field"},
		{"null fields", `{"changes":[{"type":"task","id":"x","fields":null}]}`, 400, "invalid_field"},
		{"field named id", changeBody("task", fresh("r"), fmt.Sprintf(`{"id":{"v":"x","c":%q}}`, nowClock())), 400, "invalid_field"},
		{"empty field name", changeBody("task", fresh("r"), fmt.Sprintf(`{"":{"v":"x","c":%q}}`, nowClock())), 400, "invalid_field"},
		{"field name too long", changeBody("task", fresh("r"), fmt.Sprintf(`{%q:{"v":"x","c":%q}}`, longID, nowClock())), 400, "invalid_field"},
		{"field not an object", changeBody("task", fresh("r"), `{"title":"x"}`), 400, "invalid_json"},
		{"no clock", changeBody("task", fresh("r"), `{"title":{"v":"x"}}`), 400, "invalid_clock"},
		{"empty clock", changeBody("task", fresh("r"), `{"title":{"v":"x","c":""}}`), 400, "invalid_clock"},
		{"short wall", changeBody("task", fresh("r"), `{"title":{"v":"x","c":"123-000000-d"}}`), 400, "invalid_clock"},
		{"no device", changeBody("task", fresh("r"), `{"title":{"v":"x","c":"1000000000000-000000-"}}`), 400, "invalid_clock"},
		{"clock with a space", changeBody("task", fresh("r"), `{"title":{"v":"x","c":"1000000000000-000000-a b"}}`), 400, "invalid_clock"},
		{"clock ahead", changeBody("task", fresh("r"), fmt.Sprintf(`{"title":{"v":"x","c":%q}}`, future)), 400, "clock_ahead"},
		{"number too large", changeBody("task", fresh("r"), titled(`1e126`)), 400, "invalid_value"},
		{"number too small", changeBody("task", fresh("r"), titled(`1e-131`)), 400, "invalid_value"},
		{"number too long", changeBody("task", fresh("r"), titled(strings.Repeat("1", 39))), 400, "invalid_value"},
		{"value nested too deep", changeBody("task", fresh("r"), titled(nested(26))), 400, "invalid_value"},
		{"empty key in a value", changeBody("task", fresh("r"), titled(`{"":1}`)), 400, "invalid_value"},
		{"record too large", changeBody("task", fresh("r"), titled(`"`+strings.Repeat("x", maxRecordBytes)+`"`)), 413, "record_too_large"},
	}
	before := a.startCursor()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := a.sendRaw([]byte(c.body))
			if res.status != c.status || res.errorCode() != c.code {
				t.Fatalf("got %d %s, want %d %s", res.status, truncated(res.body), c.status, c.code)
			}
		})
	}
	t.Run("body over the limit", func(t *testing.T) {
		// Just over the limit, and under the 6 MB Lambda takes, so the app answers on a deployment too.
		body := `{"cursor":0,"changes":[],"padding":"` + strings.Repeat("x", appconfig.Protocol.Sync.MaxBodyBytes) + `"}`
		if res := a.sendRaw([]byte(body)); res.status != 413 {
			t.Fatalf("%d %s", res.status, truncated(res.body))
		}
	})
	if after := a.startCursor(); after != before {
		t.Fatalf("a refused request moved the counter from %d to %d", before, after)
	}
}

func TestSmokeTelemetryTakesAnOTLPExport(t *testing.T) {
	needs(t)
	a := signIn(t)
	export := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"eventName":"app.heartbeat"},{"eventName":"not.ours"}]}]}]}`
	res := request(t, "POST", "/v1/logs", a.tokens.access, []byte(export))
	if res.status != 200 || strings.TrimSpace(string(res.body)) != `{"partialSuccess":{"rejectedLogRecords":1}}` {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
}

func TestSmokeCalendarRefreshReachable(t *testing.T) {
	needs(t)
	a := signIn(t)
	// Only the connected user's refresh does anything, so this is safe whoever the test user is.
	if res := request(t, "POST", "/calendar/refresh", a.tokens.access, nil); res.status != 204 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
}

// The consent is left unfinished, so the deployment's Google connection is never touched.
func TestConnectReturnsAConsentURL(t *testing.T) {
	needs(t, googleClient)
	a := signIn(t)
	res := request(t, "POST", "/calendar/connect", a.tokens.access, nil)
	if res.status != 200 {
		t.Fatalf("%d %s", res.status, truncated(res.body))
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(res.body, &body); err != nil {
		t.Fatal(err)
	}
	consent, err := url.Parse(body.URL)
	if err != nil {
		t.Fatal(err)
	}
	q := consent.Query()
	if q.Get("state") == "" || q.Get("access_type") != "offline" || q.Get("prompt") != "consent" || q.Get("response_type") != "code" {
		t.Fatalf("%s", body.URL)
	}
	if !strings.HasSuffix(q.Get("redirect_uri"), "/calendar/callback") {
		t.Fatalf("redirect %s", q.Get("redirect_uri"))
	}
	for _, scope := range []string{"calendar.app.created", "calendar.events.readonly", "calendar.calendarlist.readonly"} {
		if !strings.Contains(q.Get("scope"), scope) {
			t.Errorf("no %s in %s", scope, q.Get("scope"))
		}
	}
	if strings.Contains(q.Get("scope"), "auth/calendar ") || strings.HasSuffix(q.Get("scope"), "auth/calendar") {
		t.Errorf("asks for the whole calendar: %s", q.Get("scope"))
	}
}

func TestCallbackRefusesWhatItCantTrust(t *testing.T) {
	needs(t, googleClient)
	a := signIn(t)
	res := request(t, "POST", "/calendar/connect", a.tokens.access, nil)
	var body struct {
		URL string `json:"url"`
	}
	json.Unmarshal(res.body, &body)
	consent, err := url.Parse(body.URL)
	if err != nil {
		t.Fatal(err)
	}
	state := consent.Query().Get("state")
	payload, signature, _ := strings.Cut(state, ".")

	cases := map[string]string{
		"nothing":            "",
		"no code":            "state=" + url.QueryEscape(state),
		"no state":           "code=abc",
		"denied at consent":  "error=access_denied&state=" + url.QueryEscape(state),
		"junk state":         "code=abc&state=junk",
		"unsigned state":     "code=abc&state=" + payload,
		"bad signature":      "code=abc&state=" + payload + ".AAAA",
		"signature of other": "code=abc&state=e30." + signature,
	}
	for name, query := range cases {
		t.Run(name, func(t *testing.T) {
			res := request(t, "GET", "/calendar/callback?"+query, "", nil)
			if res.status != 400 || !strings.Contains(string(res.body), "not connected") {
				t.Fatalf("%d %s", res.status, res.body)
			}
		})
	}
}
