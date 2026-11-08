// Package config reads a deployment's YAML, staging.yaml or prod.yaml. Loading is strict, so a misspelt or unknown key
// fails instead of being ignored. control.yaml, for the account that owns the domain, is read only by the infrastructure.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
)

type AWS struct {
	Account Account `yaml:"account"`
	Region  string  `yaml:"region"`
	Profile string  `yaml:"profile"`
}

// Account must be quoted in the YAML, so no reader takes it for a number and drops a leading zero.
type Account string

const accountRule = "aws.account must be a quoted 12-digit account id"

var accountID = regexp.MustCompile(`^[0-9]{12}$`)

func (a *Account) UnmarshalYAML(n *yaml.Node) error {
	if n.ShortTag() != "!!str" {
		return fmt.Errorf("line %d: %s", n.Line, accountRule)
	}
	*a = Account(n.Value)
	return nil
}

// Environment is staging.yaml or prod.yaml. It holds no secrets: test-user passwords live in SSM.
type Environment struct {
	AWS         AWS         `yaml:"aws"`
	AlarmEmail  string      `yaml:"alarmEmail"`
	Auth        Auth        `yaml:"auth"`
	DNS         *Zone       `yaml:"dns"`
	Integration Integration `yaml:"integration"`
	App         *App        `yaml:"app"`
}

type Auth struct {
	CognitoDomainPrefix string   `yaml:"cognitoDomainPrefix"`
	SignInCallbackURLs  []string `yaml:"signInCallbackUrls"`
}

// Zone is this environment's subzone, a subdomain of control.yaml's domain.
type Zone struct {
	Zone string `yaml:"zone"`
}

type Integration struct {
	TestUser       string `yaml:"testUser"`
	SecondTestUser string `yaml:"secondTestUser"`
	// HistoryUser is the history-scale test's own user, holding a seeded five-year account. Optional: only make
	// test-history ENV=staging reads it.
	HistoryUser  string   `yaml:"historyUser"`
	Capabilities []string `yaml:"capabilities"`
}

type App struct {
	BundleID string `yaml:"bundleId"`
}

func (a AWS) check() error {
	if !accountID.MatchString(string(a.Account)) {
		return errors.New(accountRule)
	}
	return required("aws.region", a.Region, "aws.profile", a.Profile)
}

func (e *Environment) check() error {
	if err := e.AWS.check(); err != nil {
		return err
	}
	if len(e.Auth.SignInCallbackURLs) == 0 {
		return errors.New("auth.signInCallbackUrls needs at least one address")
	}
	fields := []string{"alarmEmail", e.AlarmEmail, "auth.cognitoDomainPrefix", e.Auth.CognitoDomainPrefix, "integration.testUser", e.Integration.TestUser}
	if e.DNS != nil {
		fields = append(fields, "dns.zone", e.DNS.Zone)
	}
	if e.App != nil {
		fields = append(fields, "app.bundleId", e.App.BundleID)
	}
	if slices.Contains(e.Integration.Capabilities, "secondUser") {
		fields = append(fields, "integration.secondTestUser", e.Integration.SecondTestUser)
	}
	return required(fields...)
}

// required takes name, value pairs and names the first blank one.
func required(pairs ...string) error {
	for i := 0; i+1 < len(pairs); i += 2 {
		if strings.TrimSpace(pairs[i+1]) == "" {
			return fmt.Errorf("%s is required", pairs[i])
		}
	}
	return nil
}

// examples is this module's folder: the default config folder, and where the .example.yaml files live.
// shortcut: found from this file's path at build time, so it's only right in builds from the source tree (go test, go
// run), not -trimpath ones like the Lambdas, which never need it; set MULTISCALE_CONFIG_DIR if another build does.
var examples = func() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Dir(file)
}()

// Dir is the config folder: $MULTISCALE_CONFIG_DIR when set, else this module's folder, always as an absolute path.
func Dir() string {
	dir := os.Getenv("MULTISCALE_CONFIG_DIR")
	if dir == "" {
		return examples
	}
	if abs, err := filepath.Abs(dir); err == nil {
		return abs
	}
	return dir
}

// Load reads staging.yaml or prod.yaml from a config folder. Local development has no file, only built-in defaults.
func Load(dir, env string) (*Environment, error) {
	if env != "staging" && env != "prod" {
		return nil, fmt.Errorf("an environment file is staging or prod, not %q", env)
	}
	var out Environment
	if err := fromFolder(dir, env, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

type checked interface{ check() error }

func fromFolder(dir, name string, into checked) error {
	path := filepath.Join(dir, name+".yaml")
	err := decode(path, into)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("missing %s: copy %s there and fill it in", path, filepath.Join(examples, name+".example.yaml"))
	}
	return err
}

func decode(path string, into checked) error {
	raw, err := os.ReadFile(path)
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
	if err := into.check(); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}
