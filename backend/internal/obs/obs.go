// Package obs holds the shared shape of log lines and metrics. Lines carry ids, counts and error types, never record
// values, titles or tokens.
package obs

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"slices"
	"time"
)

// NewLogger writes one JSON object per line, which CloudWatch Logs parses as it stands.
func NewLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, nil))
}

// HashSub identifies a user in logs without recording their id.
func HashSub(sub string) string {
	sum := sha256.Sum256([]byte(sub))
	return hex.EncodeToString(sum[:8])
}

// Metrics returns log attributes in Embedded Metric Format, which CloudWatch turns into metrics with no API calls. The
// empty dimension set keeps each one a single billed metric.
func Metrics(env string, at time.Time, values map[string]int) []any {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	slices.Sort(names)
	declared := make([]map[string]string, len(names))
	attrs := make([]any, 0, len(names)+1)
	for i, name := range names {
		declared[i] = map[string]string{"Name": name, "Unit": "Count"}
		attrs = append(attrs, slog.Int(name, values[name]))
	}
	return append(attrs, slog.Any("_aws", map[string]any{
		"Timestamp": at.UnixMilli(),
		"CloudWatchMetrics": []map[string]any{{
			"Namespace":  "Multiscale/" + env,
			"Dimensions": [][]string{{}},
			"Metrics":    declared,
		}},
	}))
}
