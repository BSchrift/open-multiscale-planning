package obs

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestHashSubIsStableAndHidesTheSub(t *testing.T) {
	sub := "11111111-2222-3333-4444-555555555555"
	if HashSub(sub) != HashSub(sub) || HashSub(sub) == HashSub("other") {
		t.Fatal("hash must identify the user")
	}
	if strings.Contains(HashSub(sub), sub) || len(HashSub(sub)) != 16 {
		t.Fatalf("got %q", HashSub(sub))
	}
}

func TestMetricsAreValidEMFOnOneLogLine(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(&buf)
	at := time.UnixMilli(1800000000000)
	log.Info("request", Metrics("staging", at, map[string]int{"SyncRecordsMerged": 3, "SyncConflictRetries": 0})...)

	if strings.Count(buf.String(), "\n") != 1 {
		t.Fatalf("want one line, got %q", buf.String())
	}
	var line struct {
		Aws struct {
			Timestamp         int64
			CloudWatchMetrics []struct {
				Namespace  string
				Dimensions [][]string
				Metrics    []struct{ Name, Unit string }
			}
		} `json:"_aws"`
		Merged  *int `json:"SyncRecordsMerged"`
		Retries *int `json:"SyncConflictRetries"`
	}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line.Aws.Timestamp != 1800000000000 || len(line.Aws.CloudWatchMetrics) != 1 {
		t.Fatalf("got %+v", line.Aws)
	}
	directive := line.Aws.CloudWatchMetrics[0]
	if directive.Namespace != "Multiscale/staging" {
		t.Fatalf("namespace %q", directive.Namespace)
	}
	// One empty dimension set: each dimension combination is billed as its own metric.
	if len(directive.Dimensions) != 1 || len(directive.Dimensions[0]) != 0 {
		t.Fatalf("dimensions %v", directive.Dimensions)
	}
	if len(directive.Metrics) != 2 {
		t.Fatalf("metrics %v", directive.Metrics)
	}
	for _, m := range directive.Metrics {
		if m.Unit != "Count" {
			t.Fatalf("unit %q", m.Unit)
		}
	}
	if line.Merged == nil || *line.Merged != 3 || line.Retries == nil || *line.Retries != 0 {
		t.Fatalf("values %+v %+v", line.Merged, line.Retries)
	}
}

func TestSizesAreDeclaredInGigabytesBesideTheCounts(t *testing.T) {
	var buf bytes.Buffer
	NewLogger(&buf).Info("request", Metrics("staging", time.UnixMilli(1800000000000), map[string]int{"SyncRecordsMerged": 3},
		GB{Name: "ItemCollectionSizeGB", Value: 1.5})...)

	var line struct {
		Aws struct {
			CloudWatchMetrics []struct{ Metrics []struct{ Name, Unit string } }
		} `json:"_aws"`
		Size *float64 `json:"ItemCollectionSizeGB"`
	}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	units := map[string]string{}
	for _, m := range line.Aws.CloudWatchMetrics[0].Metrics {
		units[m.Name] = m.Unit
	}
	if len(units) != 2 || units["SyncRecordsMerged"] != "Count" || units["ItemCollectionSizeGB"] != "Gigabytes" {
		t.Fatalf("declared %v", units)
	}
	if line.Size == nil || *line.Size != 1.5 {
		t.Fatalf("size %v", line.Size)
	}
}

func TestNewLoggerWritesJSONWithAtLeastInfo(t *testing.T) {
	var buf bytes.Buffer
	NewLogger(&buf).Info("hello")
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil || line["msg"] != "hello" {
		t.Fatalf("got %q: %v", buf.String(), err)
	}
}
