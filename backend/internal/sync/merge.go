// Package sync stores opaque records as per-field last-writer-wins maps, with a per-user sequence number that tells
// each device what it hasn't seen.
package sync

import "maps"

// Field is one field's value and the hybrid logical clock of its last write. A clock is
// <epoch ms, 13 digits>-<counter, 6 digits>-<device id>, so comparing clocks as strings orders them by time, then
// counter, with the device id breaking ties. The client compares them the same way.
type Field struct {
	V any    `json:"v"`
	C string `json:"c"`
}

// Fields is a record, or a change to one, by field name.
type Fields map[string]Field

// MergeFields returns current with every incoming field whose clock is higher, and how many fields that changed.
// Equal clocks are the same write, so resending changes nothing.
func MergeFields(current, incoming Fields) (Fields, int) {
	merged := maps.Clone(current)
	if merged == nil {
		merged = Fields{}
	}
	changed := 0
	for name, field := range incoming {
		if have, ok := merged[name]; !ok || field.C > have.C {
			merged[name] = field
			changed++
		}
	}
	return merged, changed
}
