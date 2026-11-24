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

// A Mac app that replaced itself reports it on its first launch, with the app builds before and after, and an app it
// refused for its signature as a check's failure, which an alarm watches.
func TestTelemetryKeepsAppUpdatesInstalledAndTheirFailures(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, nil)
	body := `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.version","value":{"stringValue":"0.1.0-c2091ac"}}]},
  "scopeLogs":[{"logRecords":[
    {"eventName":"app.update.installed","attributes":[
      {"key":"app.update.from","value":{"intValue":"1793979385"}},
      {"key":"app.update.build","value":{"intValue":"1794000000"}}]},
    {"eventName":"app.update.check","attributes":[
      {"key":"app.update.outcome","value":{"stringValue":"failed"}},
      {"key":"app.update.failure","value":{"stringValue":"app-signature"}},
      {"key":"app.update.build","value":{"intValue":"1794000000"}}]}]}]}]}`
	if rec := do(s, "POST", "/v1/logs", body, testSub); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	events := clientEvents(t, logs)
	if len(events) != 2 {
		t.Fatalf("%d events: %s", len(events), logs)
	}
	installed, check := events[0], events[1]
	if installed["event"] != "app.update.installed" || installed["app.update.from"] != float64(1793979385) || installed["app.update.build"] != float64(1794000000) {
		t.Errorf("%+v", installed)
	}
	if check["app.update.failure"] != "app-signature" {
		t.Errorf("%+v", check)
	}
}

// Battery monitoring: each heartbeat's sync count and battery context, the Mac's CPU and idle wakeups for each process,
// and MetricKit's day and its CPU or disk exceptions from the iPhone, where only the top frame says where.
func TestTelemetryKeepsSyncCountsAndEnergy(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, nil)
	body := `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.version","value":{"stringValue":"0.1.0-c2091ac"}}]},
  "scopeLogs":[{"logRecords":[
    {"eventName":"app.sync.count","attributes":[
      {"key":"sync.count","value":{"intValue":"3"}},
      {"key":"sync.bytes","value":{"intValue":"5120"}}]},
    {"eventName":"app.heartbeat","attributes":[
      {"key":"device.battery.charging","value":{"boolValue":false}},
      {"key":"device.low_power","value":{"boolValue":true}},
      {"key":"device.thermal_state","value":{"stringValue":"fair"}}]},
    {"eventName":"app.energy.sample","attributes":[
      {"key":"energy.process","value":{"stringValue":"renderer"}},
      {"key":"energy.cpu_percent","value":{"doubleValue":0.4}},
      {"key":"energy.idle_wakeups_per_s","value":{"doubleValue":2.5}},
      {"key":"energy.window_visible","value":{"boolValue":false}}]},
    {"eventName":"app.energy.daily","attributes":[
      {"key":"energy.day","value":{"stringValue":"2026-11-15"}},
      {"key":"energy.cpu_seconds","value":{"doubleValue":100}},
      {"key":"energy.gpu_seconds","value":{"doubleValue":20}},
      {"key":"energy.cellular_bytes","value":{"intValue":"150000000"}},
      {"key":"energy.wifi_bytes","value":{"intValue":"110000000"}},
      {"key":"energy.foreground_seconds","value":{"intValue":"700"}},
      {"key":"energy.background_seconds","value":{"intValue":"40"}},
      {"key":"energy.hang_seconds","value":{"doubleValue":1.5}}]},
    {"eventName":"app.energy.exception","attributes":[
      {"key":"energy.exception.kind","value":{"stringValue":"cpu"}},
      {"key":"energy.exception.cpu_seconds","value":{"doubleValue":90}},
      {"key":"code.function","value":{"stringValue":"App+0x28a3c"}}]},
    {"eventName":"app.energy.exception","attributes":[
      {"key":"energy.exception.kind","value":{"stringValue":"disk"}},
      {"key":"energy.exception.disk_bytes","value":{"intValue":"2147483648"}},
      {"key":"code.function","value":{"stringValue":"closure #1 in Paint the fence"}}]}]}]}]}`
	if rec := do(s, "POST", "/v1/logs", body, testSub); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	events := clientEvents(t, logs)
	if len(events) != 6 {
		t.Fatalf("%d events: %s", len(events), logs)
	}
	want := []map[string]any{
		{"event": "app.sync.count", "sync.count": float64(3), "sync.bytes": float64(5120)},
		{"event": "app.heartbeat", "device.battery.charging": false, "device.low_power": true, "device.thermal_state": "fair"},
		{"event": "app.energy.sample", "energy.process": "renderer", "energy.cpu_percent": 0.4, "energy.idle_wakeups_per_s": 2.5, "energy.window_visible": false},
		{"event": "app.energy.daily", "energy.day": "2026-11-15", "energy.cpu_seconds": float64(100), "energy.gpu_seconds": float64(20),
			"energy.cellular_bytes": float64(150000000), "energy.wifi_bytes": float64(110000000), "energy.foreground_seconds": float64(700),
			"energy.background_seconds": float64(40), "energy.hang_seconds": 1.5},
		{"event": "app.energy.exception", "energy.exception.kind": "cpu", "energy.exception.cpu_seconds": float64(90), "code.function": "App+0x28a3c"},
		{"event": "app.energy.exception", "energy.exception.kind": "disk", "energy.exception.disk_bytes": float64(2147483648)},
	}
	for i, fields := range want {
		for key, value := range fields {
			if events[i][key] != value {
				t.Errorf("event %d: %s = %v, want %v", i, key, events[i][key], value)
			}
		}
	}
	// A name with spaces could carry what someone wrote, so it's dropped like any other free text.
	if _, ok := events[5]["code.function"]; ok {
		t.Errorf("free text kept: %+v", events[5])
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
