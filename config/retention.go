package config

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"go.yaml.in/yaml/v3"
)

// The retention policy, built into every binary that imports this module, so a Lambda reads the same file the app was
// built from. config/retention.ts is the other reader, for the app's build and the deploy.
//
//go:embed retention.yaml
var retentionFile []byte

// Period is an ISO 8601 duration. Years, months and days are calendar steps, taken in UTC, as the app takes them.
type Period struct {
	Years, Months, Days int
	Clock               time.Duration
	text                string
}

func (p Period) String() string { return p.text }

// After is t plus the period.
func (p Period) After(t time.Time) time.Time {
	return t.UTC().AddDate(p.Years, p.Months, p.Days).Add(p.Clock)
}

// Before is t minus the period.
func (p Period) Before(t time.Time) time.Time {
	return t.UTC().Add(-p.Clock).AddDate(-p.Years, -p.Months, -p.Days)
}

// Retention is one environment's block of retention.yaml.
type Retention struct {
	Scheduling, Closed, Deleted Period
	// Cleanup is how often staging's cleanup job runs, or nil where TTL alone removes what has expired.
	Cleanup *Period
}

var periodPattern = regexp.MustCompile(`^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$`)

// ParsePeriod reads an ISO 8601 duration of whole numbers, such as P2Y or PT10M. It must be longer than zero.
func ParsePeriod(text string) (Period, error) {
	m := periodPattern.FindStringSubmatch(text)
	if m == nil || text == "P" || text[len(text)-1] == 'T' {
		return Period{}, fmt.Errorf("%q is not an ISO 8601 duration such as P30D or PT10M", text)
	}
	n := make([]int, len(m))
	for i, part := range m[1:] {
		if part == "" {
			continue
		}
		value, err := strconv.Atoi(part)
		if err != nil || value > 100000 {
			return Period{}, fmt.Errorf("%q has a number out of range", text)
		}
		n[i+1] = value
	}
	p := Period{
		Years: n[1], Months: n[2], Days: n[3]*7 + n[4],
		Clock: time.Duration(n[5])*time.Hour + time.Duration(n[6])*time.Minute + time.Duration(n[7])*time.Second,
		text:  text,
	}
	if p.Years == 0 && p.Months == 0 && p.Days == 0 && p.Clock == 0 {
		return Period{}, fmt.Errorf("%q is zero", text)
	}
	return p, nil
}

type retentionBlock struct {
	Scheduling string  `yaml:"scheduling"`
	Closed     string  `yaml:"closed"`
	Deleted    string  `yaml:"deleted"`
	Cleanup    *string `yaml:"cleanup"`
}

func (b retentionBlock) parse() (Retention, error) {
	var r Retention
	for _, f := range []struct {
		name, text string
		into       *Period
	}{
		{"scheduling", b.Scheduling, &r.Scheduling},
		{"closed", b.Closed, &r.Closed},
		{"deleted", b.Deleted, &r.Deleted},
	} {
		if f.text == "" {
			return r, fmt.Errorf("%s is required", f.name)
		}
		p, err := ParsePeriod(f.text)
		if err != nil {
			return r, fmt.Errorf("%s: %w", f.name, err)
		}
		*f.into = p
	}
	if b.Cleanup == nil {
		return r, nil
	}
	cleanup, err := ParsePeriod(*b.Cleanup)
	// EventBridge Scheduler runs a rate in whole minutes, hours or days.
	if err != nil || cleanup.Years != 0 || cleanup.Months != 0 || cleanup.Clock%time.Minute != 0 {
		return r, errors.New("cleanup must be whole minutes, hours or days, such as PT1M or P1D")
	}
	r.Cleanup = &cleanup
	return r, nil
}

// LoadRetention returns one environment's retention block: prod, staging or local. Every block is checked each time, so a
// bad value anywhere fails the first reader, at build, deploy or start.
func LoadRetention(env string) (Retention, error) {
	return parseRetention(retentionFile, env)
}

func parseRetention(raw []byte, env string) (Retention, error) {
	var file struct {
		Prod    retentionBlock `yaml:"prod"`
		Staging retentionBlock `yaml:"staging"`
		Local   retentionBlock `yaml:"local"`
	}
	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	decoder.KnownFields(true)
	if err := decoder.Decode(&file); err != nil {
		return Retention{}, fmt.Errorf("retention.yaml: %w", err)
	}
	blocks := map[string]retentionBlock{"prod": file.Prod, "staging": file.Staging, "local": file.Local}
	var picked *Retention
	for _, name := range []string{"prod", "staging", "local"} {
		r, err := blocks[name].parse()
		if err != nil {
			return Retention{}, fmt.Errorf("retention.yaml: %s: %w", name, err)
		}
		if name == env {
			picked = &r
		}
	}
	if picked == nil {
		return Retention{}, fmt.Errorf("retention.yaml has prod, staging and local, not %q", env)
	}
	return *picked, nil
}
