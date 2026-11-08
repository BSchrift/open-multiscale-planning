package api

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/config"
)

// POST /v1/logs takes OpenTelemetry events in OTLP/HTTP JSON, the standard path and wire format, so the app could
// export to any OTel collector instead. Each kept event becomes a client_event log line.
//
// Only what a device says about how it runs is kept, never what a person wrote: listed events and attributes, numbers,
// and strings that look like identifiers, so free text can't ride along in an allowed field.

const maxTelemetryBytes = 64 << 10

// The most the app sends at once, from config/protocol.yaml.
var maxTelemetryRecords = config.Protocol.Telemetry.MaxBatchEvents

var (
	telemetryEvents = set("app.start", "app.last_session", "app.heartbeat", "app.hidden", "device.memory_warning", "exception",
		"app.update.check", "app.update.rollback")
	// Resource attributes describe the device and this run of the app; record attributes describe the event.
	telemetryResource = set("service.version", "os.name", "os.version", "device.id", "device.model.identifier",
		"session.id", "deployment.environment.name", "app.platform")
	telemetryAttributes = set("app.screen.name", "app.page_loads", "app.uptime", "app.memory_warnings", "app.last_session.state",
		"process.memory.usage", "process.memory.peak", "browser.dom.nodes",
		"exception.type", "code.file.path", "code.line.number", "code.column.number",
		"app.update.outcome", "app.update.failure", "app.update.build")
	telemetryString = regexp.MustCompile(`^[A-Za-z0-9._,/:-]{1,80}$`)
)

func set(names ...string) map[string]bool {
	out := make(map[string]bool, len(names))
	for _, name := range names {
		out[name] = true
	}
	return out
}

type otlpKeyValue struct {
	Key   string `json:"key"`
	Value struct {
		StringValue *string      `json:"stringValue"`
		IntValue    *json.Number `json:"intValue"` // proto3 JSON writes int64 as a string, and either form is accepted
		DoubleValue *float64     `json:"doubleValue"`
		BoolValue   *bool        `json:"boolValue"`
	} `json:"value"`
}

type otlpLogs struct {
	ResourceLogs []struct {
		Resource struct {
			Attributes []otlpKeyValue `json:"attributes"`
		} `json:"resource"`
		ScopeLogs []struct {
			LogRecords []struct {
				TimeUnixNano string         `json:"timeUnixNano"`
				EventName    string         `json:"eventName"`
				Attributes   []otlpKeyValue `json:"attributes"`
			} `json:"logRecords"`
		} `json:"scopeLogs"`
	} `json:"resourceLogs"`
}

// allowed returns the attributes in the list whose values pass, as log attributes.
func allowed(list []otlpKeyValue, names map[string]bool) []any {
	var out []any
	for _, kv := range list {
		if !names[kv.Key] {
			continue
		}
		v := kv.Value
		switch {
		case v.StringValue != nil && telemetryString.MatchString(*v.StringValue):
			out = append(out, kv.Key, *v.StringValue)
		case v.IntValue != nil:
			if n, err := v.IntValue.Float64(); err == nil {
				out = append(out, kv.Key, n)
			}
		case v.DoubleValue != nil && !math.IsInf(*v.DoubleValue, 0) && !math.IsNaN(*v.DoubleValue):
			out = append(out, kv.Key, *v.DoubleValue)
		case v.BoolValue != nil:
			out = append(out, kv.Key, *v.BoolValue)
		}
	}
	return out
}

func (s *Server) telemetry(w http.ResponseWriter, r *http.Request, sub string) outcome {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxTelemetryBytes))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "too_large"})
		return outcome{status: http.StatusRequestEntityTooLarge, errorType: "too_large"}
	}
	var req otlpLogs
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return outcome{status: http.StatusBadRequest, errorType: "invalid"}
	}
	kept, rejected := 0, 0
	for _, resource := range req.ResourceLogs {
		about := allowed(resource.Resource.Attributes, telemetryResource)
		for _, scope := range resource.ScopeLogs {
			for _, record := range scope.LogRecords {
				if !telemetryEvents[record.EventName] || kept >= maxTelemetryRecords {
					rejected++
					continue
				}
				kept++
				attrs := []any{"user", obs.HashSub(sub), "event", record.EventName}
				if ns, err := strconv.ParseInt(record.TimeUnixNano, 10, 64); err == nil {
					attrs = append(attrs, "at", time.Unix(0, ns).UTC().Format(time.RFC3339))
				}
				attrs = append(attrs, about...)
				s.Log.Info("client_event", append(attrs, allowed(record.Attributes, telemetryAttributes)...)...)
			}
		}
	}
	// OTLP's answer: an empty object, or how many records were dropped.
	response := map[string]any{}
	if rejected > 0 {
		response["partialSuccess"] = map[string]int{"rejectedLogRecords": rejected}
	}
	writeJSON(w, http.StatusOK, response)
	return outcome{status: http.StatusOK, attrs: []any{"events", kept, "rejected", rejected}}
}
