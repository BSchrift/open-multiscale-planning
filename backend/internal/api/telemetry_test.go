package api

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func clientEvents(t *testing.T, logs *bytes.Buffer) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(line), &decoded); err != nil {
			t.Fatalf("log %q: %v", line, err)
		}
		if decoded["msg"] == "client_event" {
			events = append(events, decoded)
		}
	}
	return events
}

// An OTLP/HTTP JSON export, as the app sends it.
const export = `{"resourceLogs":[{
  "resource":{"attributes":[
    {"key":"service.name","value":{"stringValue":"multiscale-app"}},
    {"key":"os.name","value":{"stringValue":"ios"}},
    {"key":"app.platform","value":{"stringValue":"mobile"}},
    {"key":"service.version","value":{"stringValue":"0.1.0-cb510fd"}},
    {"key":"device.model.identifier","value":{"stringValue":"iPhone14,2"}},
    {"key":"session.id","value":{"stringValue":"s-1"}},
    {"key":"user.email","value":{"stringValue":"someone@example.test"}}]},
  "scopeLogs":[{"logRecords":[
    {"timeUnixNano":"1800000000000000000","eventName":"app.heartbeat","attributes":[
      {"key":"app.screen.name","value":{"stringValue":"week"}},
      {"key":"process.memory.usage","value":{"intValue":"220200960"}},
      {"key":"process.memory.peak","value":{"doubleValue":230000000}},
      {"key":"task.title","value":{"stringValue":"Paint the fence"}}]},
    {"timeUnixNano":"1800000000000000000","eventName":"exception","attributes":[
      {"key":"exception.type","value":{"stringValue":"TypeError"}},
      {"key":"exception.message","value":{"stringValue":"Paint the fence is undefined"}},
      {"key":"code.file.path","value":{"stringValue":"assets/index-Cc.js"}},
      {"key":"code.line.number","value":{"intValue":1}}]},
    {"timeUnixNano":"1800000000000000000","eventName":"my.own.event"},
    {"timeUnixNano":"1800000000000000000","eventName":"app.start","attributes":[
      {"key":"app.screen.name","value":{"stringValue":"a free text title"}}]}]}]}]}`

func TestTelemetryLogsOnlyAllowedEventsAndAttributes(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, nil)
	rec := do(s, "POST", "/v1/logs", export, testSub)
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"partialSuccess":{"rejectedLogRecords":1}}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if strings.Contains(logs.String(), "Paint the fence") || strings.Contains(logs.String(), "someone@") || strings.Contains(logs.String(), "free text") {
		t.Fatalf("leak: %s", logs)
	}
	events := clientEvents(t, logs)
	if len(events) != 3 {
		t.Fatalf("%d events: %s", len(events), logs)
	}
	beat := events[0]
	want := map[string]any{
		"event": "app.heartbeat", "os.name": "ios", "app.platform": "mobile", "service.version": "0.1.0-cb510fd",
		"device.model.identifier": "iPhone14,2", "session.id": "s-1",
		"app.screen.name": "week", "process.memory.usage": float64(220200960), "process.memory.peak": float64(230000000),
	}
	for key, value := range want {
		if beat[key] != value {
			t.Errorf("%s = %v, want %v", key, beat[key], value)
		}
	}
	if beat["user"] == nil || beat["user"] == testSub || beat["at"] != "2027-01-15T08:00:00Z" {
		t.Errorf("%+v", beat)
	}
	if events[1]["exception.type"] != "TypeError" || events[1]["code.line.number"] != float64(1) || events[1]["code.file.path"] != "assets/index-Cc.js" {
		t.Errorf("%+v", events[1])
	}
	if _, ok := events[2]["app.screen.name"]; ok {
		t.Errorf("free text kept: %+v", events[2])
	}
}

func TestTelemetryKeepsUpdateChecksAndRollbacks(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, nil)
	body := `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.version","value":{"stringValue":"0.1.0-c2091ac"}}]},
  "scopeLogs":[{"logRecords":[
    {"eventName":"app.update.check","attributes":[
      {"key":"app.update.outcome","value":{"stringValue":"failed"}},
      {"key":"app.update.failure","value":{"stringValue":"rolled-back"}},
      {"key":"app.update.build","value":{"intValue":"1793979385"}}]},
    {"eventName":"app.update.rollback","attributes":[
      {"key":"app.update.build","value":{"intValue":1793979385}}]}]}]}]}`
	if rec := do(s, "POST", "/v1/logs", body, testSub); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	events := clientEvents(t, logs)
	if len(events) != 2 {
		t.Fatalf("%d events: %s", len(events), logs)
	}
	check, rollback := events[0], events[1]
	if check["event"] != "app.update.check" || check["app.update.outcome"] != "failed" || check["app.update.failure"] != "rolled-back" || check["app.update.build"] != float64(1793979385) {
		t.Errorf("%+v", check)
	}
	if rollback["event"] != "app.update.rollback" || rollback["app.update.build"] != float64(1793979385) || rollback["service.version"] != "0.1.0-c2091ac" {
		t.Errorf("%+v", rollback)
	}
}

func TestTelemetryRefusesWhatIsNotAnExport(t *testing.T) {
	s, _ := newServer(&fakeSyncer{}, nil)
	if rec := do(s, "POST", "/v1/logs", `not json`, testSub); rec.Code != 400 {
		t.Fatalf("%d", rec.Code)
	}
	if rec := do(s, "POST", "/v1/logs", `{"resourceLogs":"`+strings.Repeat("x", 70<<10)+`"}`, testSub); rec.Code != 413 {
		t.Fatalf("%d", rec.Code)
	}
	if rec := do(s, "POST", "/v1/logs", export, ""); rec.Code != 401 {
		t.Fatalf("%d", rec.Code)
	}
}
