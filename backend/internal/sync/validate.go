package sync

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/BSchrift/open-multiscale-planning/config"
)

// The limits the apps share, from config/protocol.yaml, which says why each is what it is.
var (
	// MaxChanges leaves room for the counter in one 100-action transaction.
	MaxChanges = config.Protocol.Sync.MaxChanges
	// MaxRecordBytes is measured on a record's fields as JSON, for what a device sends.
	MaxRecordBytes = config.Protocol.Sync.MaxRecordBytes
	// mergedRoom is how far a merge may pass that, so that a record at the limit can still take deleted_at.
	mergedRoom = config.Protocol.Sync.MergedRoomBytes
	// MaxBodyBytes stays under the 6 MB Lambda takes, so the API answers a bigger body itself. A device's batch stops
	// near 4 MB, plus at most one record.
	MaxBodyBytes = config.Protocol.Sync.MaxBodyBytes
	// maxClockAhead stops a device with a bad clock winning every future conflict.
	maxClockAhead = time.Duration(config.Protocol.Sync.MaxClockAheadHours) * time.Hour
)

const (
	// The value limits DynamoDB enforces, checked here so a bad value is a refused request and not a failed write.
	// A record's values sit three levels down in the item, and DynamoDB allows 32.
	maxValueDepth = 25
	maxNumDigits  = 38
)

var (
	idPattern    = regexp.MustCompile(`^[\x21-\x7e]{1,200}$`)
	clockPattern = regexp.MustCompile(`^\d{13}-\d{6}-[\x21-\x7e]+$`)
	// Any type, not a list: an app with a new one may be released before the server knows it. No # either, so the
	// sort key still splits into type and id.
	typePattern = regexp.MustCompile(`^[a-z_]{1,64}$`)
)

// Rejection is a request refused at the trust boundary. Code is stable for clients and safe to log.
type Rejection struct {
	Status int
	Code   string
}

func (r *Rejection) Error() string { return "sync: rejected: " + r.Code }

func rejected(code string) *Rejection { return &Rejection{http.StatusBadRequest, code} }

func tooLarge(code string) *Rejection { return &Rejection{http.StatusRequestEntityTooLarge, code} }

// RejectedBodyTooLarge is for a caller that stops reading a body over MaxBodyBytes.
var RejectedBodyTooLarge = tooLarge("request_too_large")

// Change is one record's changed fields, as sent to and received from a device.
type Change struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Fields Fields `json:"fields"`
}

// Request is the body of POST /sync.
type Request struct {
	Cursor  int64    `json:"cursor"`
	Changes []Change `json:"changes"`
}

// ParseRequest decodes and validates a request body. Any error is a *Rejection.
func ParseRequest(body []byte, now time.Time) (Request, error) {
	var req Request
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&req); err != nil {
		return Request{}, rejected("invalid_json")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Request{}, rejected("invalid_json")
	}
	if req.Cursor < 0 {
		return Request{}, rejected("invalid_cursor")
	}
	if len(req.Changes) > MaxChanges {
		return Request{}, rejected("too_many_changes")
	}
	latest := now.Add(maxClockAhead).UnixMilli()
	for _, change := range req.Changes {
		if err := validateChange(change, latest); err != nil {
			return Request{}, err
		}
	}
	return req, nil
}

func validateChange(change Change, latestClock int64) error {
	if !typePattern.MatchString(change.Type) {
		return rejected("unknown_type")
	}
	if !idPattern.MatchString(change.ID) {
		return rejected("invalid_id")
	}
	if change.Fields == nil {
		return rejected("invalid_field")
	}
	for name, field := range change.Fields {
		if !idPattern.MatchString(name) || name == "id" {
			return rejected("invalid_field")
		}
		if !clockPattern.MatchString(field.C) {
			return rejected("invalid_clock")
		}
		if wall, err := strconv.ParseInt(field.C[:13], 10, 64); err != nil || wall > latestClock {
			return rejected("clock_ahead")
		}
		if !validValue(field.V, 1) {
			return rejected("invalid_value")
		}
	}
	if recordBytes(change.Fields) > MaxRecordBytes {
		return tooLarge("record_too_large")
	}
	return nil
}

func validValue(value any, depth int) bool {
	if depth > maxValueDepth {
		return false
	}
	switch v := value.(type) {
	case json.Number:
		return validNumber(string(v))
	case []any:
		for _, item := range v {
			if !validValue(item, depth+1) {
				return false
			}
		}
	case map[string]any:
		for key, item := range v {
			if key == "" || !validValue(item, depth+1) {
				return false
			}
		}
	}
	return true
}

func validNumber(n string) bool {
	f, err := strconv.ParseFloat(n, 64)
	if err != nil {
		return false
	}
	if abs := math.Abs(f); abs != 0 && (abs >= 1e126 || abs < 1e-130) {
		return false
	}
	mantissa, _, _ := strings.Cut(strings.ToLower(n), "e")
	digits := 0
	for _, r := range mantissa {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	return digits <= maxNumDigits
}

// recordBytes is a record's size as compact JSON, the way a device sends it.
func recordBytes(fields Fields) int {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(fields); err != nil {
		panic(fmt.Sprintf("sync: fields from JSON must encode: %v", err))
	}
	return buf.Len() - 1
}
