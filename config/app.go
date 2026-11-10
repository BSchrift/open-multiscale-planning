package config

// The app's own settings: protocol.yaml, the limits and formats the server and every app share, and env/<name>.yaml,
// each environment's settings. Unlike a deployment's YAML, they're public and built in. Go embeds them and checks them
// as the package loads, so a binary with a bad value stops at start, and go generate copies them to app.gen.ts, so
// TypeScript never parses them.

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

//go:generate go run ./cmd/gen

//go:embed protocol.yaml env/*.yaml
var builtIn embed.FS

// Protocol is protocol.yaml.
var Protocol, envs = mustLoad(builtIn)

// The environments, each with its own file in env/.
var envNames = []string{"local", "staging", "prod"}

// EnvConfig is one environment's settings.
type EnvConfig struct {
	Stack Stack `yaml:"stack" json:"stack"`
}

// Stack is how the environment's AWS stack is deployed.
type Stack struct {
	TerminationProtection bool `yaml:"terminationProtection" json:"terminationProtection"`
	CanaryPercent         int  `yaml:"canaryPercent" json:"canaryPercent"`
	CanaryMinutes         int  `yaml:"canaryMinutes" json:"canaryMinutes"`
	// ThrottleReleaseAlarm is whether DynamoDB throttling the API's requests stops and rolls back a release.
	ThrottleReleaseAlarm bool `yaml:"throttleReleaseAlarm" json:"throttleReleaseAlarm"`
}

// check is what positive can't see: the limits CodeDeploy puts on a Lambda canary.
func (s Stack) check() []string {
	var problems []string
	if s.CanaryPercent > maxCanaryPercent {
		problems = append(problems, fmt.Sprintf("stack.canaryPercent is %d, but CodeDeploy shifts at most %d%% in one step", s.CanaryPercent, maxCanaryPercent))
	}
	if s.CanaryMinutes > maxCanaryMinutes {
		problems = append(problems, fmt.Sprintf("stack.canaryMinutes is %d, but CodeDeploy waits at most %d minutes between the first and last shift", s.CanaryMinutes, maxCanaryMinutes))
	}
	return problems
}

// ForEnv is an environment's settings, by its name. Any other name is an error, so a Lambda given a wrong ENV_NAME
// stops at start.
func ForEnv(name string) (EnvConfig, error) {
	env, ok := envs[name]
	if !ok {
		return EnvConfig{}, fmt.Errorf("config: no environment %q: use local, staging or prod", name)
	}
	return env, nil
}

type ProtocolConfig struct {
	Sync      Sync      `yaml:"sync" json:"sync"`
	Records   Records   `yaml:"records" json:"records"`
	Clock     Clock     `yaml:"clock" json:"clock"`
	Telemetry Telemetry `yaml:"telemetry" json:"telemetry"`
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

type Records struct {
	IDPattern     string `yaml:"idPattern" json:"idPattern"`
	MaxNotesChars int    `yaml:"maxNotesChars" json:"maxNotesChars"`
}

// Clock is the format of a field's clock.
type Clock struct {
	Pattern    string `yaml:"pattern" json:"pattern"`
	MaxCounter int    `yaml:"maxCounter" json:"maxCounter"`
}

type Telemetry struct {
	MaxBatchEvents int `yaml:"maxBatchEvents" json:"maxBatchEvents"`
}

const (
	// A sync request's changes and the user's counter are written in one DynamoDB transaction, of 100 actions at most.
	transactionActions = 100
	// Lambda refuses a request over 6 MB before any code runs, and the event around the body takes some of that.
	lambdaRequestBytes = 6 << 20
	eventRoomBytes     = 256 << 10
	// CodeDeploy's quotas for a Lambda deployment.
	maxCanaryPercent = 99
	maxCanaryMinutes = 2880
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
	// A character takes up to 4 bytes in UTF-8, and the record's other fields need room beside a full description.
	if notes := p.Records.MaxNotesChars * utf8.UTFMax; notes > s.MaxRecordBytes*4/5 {
		problems = append(problems, fmt.Sprintf("records.maxNotesChars is %d, but at 4 bytes a character that leaves a record under a fifth of sync.maxRecordBytes, %d, for its other fields", p.Records.MaxNotesChars, s.MaxRecordBytes))
	}
	if _, err := regexp.Compile(p.Records.IDPattern); err != nil {
		problems = append(problems, fmt.Sprintf("records.idPattern doesn't compile: %v", err))
	}
	// The apps read a clock's wall time, counter and device from its groups.
	if clock, err := regexp.Compile(p.Clock.Pattern); err != nil {
		problems = append(problems, fmt.Sprintf("clock.pattern doesn't compile: %v", err))
	} else if clock.NumSubexp() != 3 {
		problems = append(problems, fmt.Sprintf("clock.pattern has %d groups, not the 3 for wall time, counter and device", clock.NumSubexp()))
	}
	return problems
}

func mustLoad(fsys fs.FS) (ProtocolConfig, map[string]EnvConfig) {
	protocol, envs, err := load(fsys)
	if err != nil {
		panic(fmt.Sprintf("config: %v", err))
	}
	return protocol, envs
}

// load reads and checks every file, and lists every problem it finds in any of them.
func load(fsys fs.FS) (ProtocolConfig, map[string]EnvConfig, error) {
	var problems []error
	var protocol ProtocolConfig
	if err := read(fsys, "protocol.yaml", &protocol); err != nil {
		problems = append(problems, err)
	} else {
		for _, problem := range append(positive(reflect.ValueOf(protocol), ""), protocol.check()...) {
			problems = append(problems, fmt.Errorf("protocol.yaml: %s", problem))
		}
	}
	found, _ := fs.Glob(fsys, "env/*.yaml")
	for _, file := range found {
		if name := strings.TrimSuffix(path.Base(file), ".yaml"); !slices.Contains(envNames, name) {
			problems = append(problems, fmt.Errorf("%s is not an environment: they're local, staging and prod", file))
		}
	}
	envs := map[string]EnvConfig{}
	for _, name := range envNames {
		file := "env/" + name + ".yaml"
		var env EnvConfig
		err := read(fsys, file, &env)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			problems = append(problems, fmt.Errorf("%s is missing: every environment has a complete file", file))
		case err != nil:
			problems = append(problems, err)
		default:
			for _, problem := range append(positive(reflect.ValueOf(env), ""), env.Stack.check()...) {
				problems = append(problems, fmt.Errorf("%s: %s", file, problem))
			}
			envs[name] = env
		}
	}
	return protocol, envs, errors.Join(problems...)
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

// positive names every number that isn't above zero and every empty string. Every limit and count here needs a value.
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
		case reflect.String:
			if field.String() == "" {
				problems = append(problems, name+" must be set")
			}
		}
	}
	return problems
}

const header = `// Generated from protocol.yaml and env/*.yaml by go generate in config/, after Go checked them. Edit those, not
// this: see docs/config.md.
`

const forEnv = `
export type EnvName = keyof typeof envs;
export type EnvConfig = (typeof envs)[EnvName];

/** An environment's settings, by its name. Throws on any other name, so a build can't go ahead with none. */
export function forEnv(env: string): EnvConfig {
  if (!Object.hasOwn(envs, env)) throw new Error(` + "`No environment ${JSON.stringify(env)} in config/env: use local, staging or prod.`" + `);
  return envs[env as EnvName];
}
`

// TypeScript is app.gen.ts, the checked files as constants for the web app, the infrastructure and scripts.
func TypeScript() ([]byte, error) {
	var out bytes.Buffer
	out.WriteString(header)
	protocol, err := asJSON(Protocol, "")
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(&out, "\nexport const protocol = %s as const;\n", protocol)
	out.WriteString("\nexport const envs = {\n")
	for _, name := range envNames {
		env, err := asJSON(envs[name], "  ")
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&out, "  %q: %s,\n", name, env)
	}
	out.WriteString("} as const;\n")
	out.WriteString(forEnv)
	return out.Bytes(), nil
}

func asJSON(value any, indent string) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent(indent, "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte("\n")), nil
}
