package config

// The app's own settings: protocol.yaml, the limits and formats the server and every app share. Unlike a
// deployment's YAML, they're public and built in. Go embeds them and checks them as the package loads, so a binary
// with a bad value stops at start, and go generate copies them to app.gen.ts, so TypeScript never parses them.

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"reflect"
	"strings"

	"go.yaml.in/yaml/v3"
)

//go:generate go run ./cmd/gen

//go:embed protocol.yaml
var builtIn embed.FS

// Protocol is protocol.yaml.
var Protocol = mustLoad(builtIn)

type ProtocolConfig struct {
	Sync Sync `yaml:"sync" json:"sync"`
}

// Sync is the sync API's limits.
type Sync struct {
	MaxChanges         int `yaml:"maxChanges" json:"maxChanges"`
	MaxRecordBytes     int `yaml:"maxRecordBytes" json:"maxRecordBytes"`
	MergedRoomBytes    int `yaml:"mergedRoomBytes" json:"mergedRoomBytes"`
	ClientBatchBytes   int `yaml:"clientBatchBytes" json:"clientBatchBytes"`
	MaxBodyBytes       int `yaml:"maxBodyBytes" json:"maxBodyBytes"`
	MaxClockAheadHours int `yaml:"maxClockAheadHours" json:"maxClockAheadHours"`
}

const (
	// A sync request's changes and the user's counter are written in one DynamoDB transaction, of 100 actions at most.
	transactionActions = 100
	// Lambda refuses a request over 6 MB before any code runs, and the event around the body takes some of that.
	lambdaRequestBytes = 6 << 20
	eventRoomBytes     = 256 << 10
)

func (p ProtocolConfig) check() []string {
	s := p.Sync
	var problems []string
	if s.MaxChanges > transactionActions-1 {
		problems = append(problems, fmt.Sprintf("sync.maxChanges is %d, but the changes and the counter share one transaction of %d actions", s.MaxChanges, transactionActions))
	}
	if batch := s.ClientBatchBytes + s.MaxRecordBytes + s.MergedRoomBytes; s.MaxBodyBytes < batch {
		problems = append(problems, fmt.Sprintf("sync.maxBodyBytes is %d, but a device's request reaches clientBatchBytes, maxRecordBytes and mergedRoomBytes together, %d", s.MaxBodyBytes, batch))
	}
	if s.MaxBodyBytes > lambdaRequestBytes-eventRoomBytes {
		problems = append(problems, fmt.Sprintf("sync.maxBodyBytes is %d, leaving the request no room under Lambda's %d", s.MaxBodyBytes, lambdaRequestBytes))
	}
	return problems
}

func mustLoad(fsys fs.FS) ProtocolConfig {
	protocol, err := load(fsys)
	if err != nil {
		panic(fmt.Sprintf("config: %v", err))
	}
	return protocol
}

// load reads and checks every file, and lists every problem it finds.
func load(fsys fs.FS) (ProtocolConfig, error) {
	var protocol ProtocolConfig
	if err := read(fsys, "protocol.yaml", &protocol); err != nil {
		return protocol, err
	}
	var problems []error
	for _, problem := range append(positive(reflect.ValueOf(protocol), ""), protocol.check()...) {
		problems = append(problems, fmt.Errorf("protocol.yaml: %s", problem))
	}
	return protocol, errors.Join(problems...)
}

// read decodes one file strictly: an unknown key fails, and so does a missing one, since nothing has a default.
func read(fsys fs.FS, path string, into any) error {
	raw, err := fs.ReadFile(fsys, path)
	if err != nil {
		return err
	}
	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	decoder.KnownFields(true)
	if err := decoder.Decode(into); errors.Is(err, io.EOF) {
		return fmt.Errorf("%s is empty", path)
	} else if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	have := map[string]bool{}
	keys(&doc, "", have)
	var missing []string
	for _, key := range fields(reflect.TypeOf(into).Elem(), "") {
		if !have[key] {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s is missing %s", path, strings.Join(missing, ", "))
	}
	return nil
}

// keys adds the dotted path of every key in a YAML document.
func keys(node *yaml.Node, prefix string, into map[string]bool) {
	if node.Kind == yaml.DocumentNode {
		for _, child := range node.Content {
			keys(child, prefix, into)
		}
		return
	}
	if node.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := prefix + node.Content[i].Value
		into[key] = true
		keys(node.Content[i+1], key+".", into)
	}
}

// fields is the dotted path of every value a struct holds, by its YAML names.
func fields(t reflect.Type, prefix string) []string {
	var out []string
	for i := range t.NumField() {
		field := t.Field(i)
		name := prefix + strings.Split(field.Tag.Get("yaml"), ",")[0]
		if field.Type.Kind() == reflect.Struct {
			out = append(out, fields(field.Type, name+".")...)
		} else {
			out = append(out, name)
		}
	}
	return out
}

// positive names every number that isn't above zero. Every limit and count here needs to be.
func positive(v reflect.Value, prefix string) []string {
	var problems []string
	for i := range v.NumField() {
		name := prefix + strings.Split(v.Type().Field(i).Tag.Get("yaml"), ",")[0]
		switch field := v.Field(i); field.Kind() {
		case reflect.Struct:
			problems = append(problems, positive(field, name+".")...)
		case reflect.Int:
			if field.Int() <= 0 {
				problems = append(problems, name+" must be positive")
			}
		}
	}
	return problems
}

const header = `// Generated from protocol.yaml by go generate in config/, after Go checked it. Edit that, not this: see
// docs/config.md.
`

// TypeScript is app.gen.ts, the checked files as constants for the web app, the infrastructure and scripts.
func TypeScript() ([]byte, error) {
	var out bytes.Buffer
	out.WriteString(header)
	if err := constant(&out, "protocol", Protocol); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func constant(out *bytes.Buffer, name string, value any) error {
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return err
	}
	fmt.Fprintf(out, "\nexport const %s = %s as const;\n", name, bytes.TrimSuffix(body.Bytes(), []byte("\n")))
	return nil
}
