package sync

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// A file in testdata/merge is one record's history, shared with the client's tests. Starting from current, applying
// each entry of incoming in order changes applied[i] fields, and applying them in ANY order ends at expected.
type mergeCase struct {
	Name     string   `json:"name"`
	Current  Fields   `json:"current"`
	Incoming []Fields `json:"incoming"`
	Applied  []int    `json:"applied"`
	Expected Fields   `json:"expected"`
}

func loadMergeCases(t *testing.T) map[string]mergeCase {
	t.Helper()
	paths, err := filepath.Glob("../../testdata/merge/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no merge cases found: %v", err)
	}
	cases := map[string]mergeCase{}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var c mergeCase
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		dec.DisallowUnknownFields()
		if err := dec.Decode(&c); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		cases[filepath.Base(path)] = c
	}
	return cases
}

func permutations(n int) [][]int {
	if n == 0 {
		return [][]int{{}}
	}
	var out [][]int
	for _, p := range permutations(n - 1) {
		for i := 0; i <= len(p); i++ {
			next := append(append(append([]int{}, p[:i]...), n-1), p[i:]...)
			out = append(out, next)
		}
	}
	return out
}

func TestSharedMergeCases(t *testing.T) {
	for file, c := range loadMergeCases(t) {
		t.Run(file, func(t *testing.T) {
			state := c.Current
			for i, incoming := range c.Incoming {
				next, changed := MergeFields(state, incoming)
				if changed != c.Applied[i] {
					t.Errorf("step %d changed %d fields, want %d", i, changed, c.Applied[i])
				}
				state = next
			}
			if !reflect.DeepEqual(state, c.Expected) {
				t.Errorf("in order: got %v, want %v", state, c.Expected)
			}

			for _, order := range permutations(len(c.Incoming)) {
				state := c.Current
				for _, i := range order {
					state, _ = MergeFields(state, c.Incoming[i])
				}
				if !reflect.DeepEqual(state, c.Expected) {
					t.Errorf("order %v: got %v, want %v", order, state, c.Expected)
				}
			}
		})
	}
}

func TestMergeFieldsDoesNotChangeItsInput(t *testing.T) {
	current := Fields{"title": {V: "Paint the fence", C: "1800000000000-000000-a"}}
	MergeFields(current, Fields{"title": {V: "Paint the gate", C: "1800000000001-000000-a"}})
	if current["title"].V != "Paint the fence" {
		t.Fatal("MergeFields changed the map it was given")
	}
}
