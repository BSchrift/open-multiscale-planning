package config

import (
	"strings"
	"testing"
	"time"
)

func TestTheCommittedRetentionLoads(t *testing.T) {
	prod, err := LoadRetention("prod")
	if err != nil {
		t.Fatal(err)
	}
	// Prod relies on TTL alone.
	if prod.Scheduling.Years != 2 || prod.Closed.Years != 5 || prod.Deleted.Days != 30 || prod.Cleanup != nil {
		t.Fatalf("%+v", prod)
	}
	staging, err := LoadRetention("staging")
	if err != nil {
		t.Fatal(err)
	}
	// Each period ends more than two cleanup runs after the one before, so the deployed suite sees every stage apart.
	if staging.Deleted.Clock != 5*time.Minute || staging.Scheduling.Clock != 20*time.Minute || staging.Closed.Clock != 35*time.Minute ||
		staging.Cleanup == nil || staging.Cleanup.Clock != 5*time.Minute || staging.CleanupReadUnitsPerSecond != 500 {
		t.Fatalf("%+v", staging)
	}
	if local, err := LoadRetention("local"); err != nil || local.Scheduling.String() != "P2Y" || local.Cleanup != nil {
		t.Fatalf("%+v %v", local, err)
	}
	if _, err := LoadRetention("test"); err == nil {
		t.Fatal("an unknown environment loaded")
	}
}

func TestPeriods(t *testing.T) {
	at := time.Date(2024, 2, 29, 10, 0, 0, 0, time.UTC)
	for text, want := range map[string]time.Time{
		"P2Y":      time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC),
		"P1M":      time.Date(2024, 3, 29, 10, 0, 0, 0, time.UTC),
		"P1W":      time.Date(2024, 3, 7, 10, 0, 0, 0, time.UTC),
		"P30D":     time.Date(2024, 3, 30, 10, 0, 0, 0, time.UTC),
		"PT10M":    time.Date(2024, 2, 29, 10, 10, 0, 0, time.UTC),
		"P1DT1H5S": time.Date(2024, 3, 1, 11, 0, 5, 0, time.UTC),
	} {
		p, err := ParsePeriod(text)
		if err != nil {
			t.Fatal(err)
		}
		if got := p.After(at); !got.Equal(want) {
			t.Errorf("%s: %s", text, got)
		}
	}
	p, _ := ParsePeriod("P30D")
	if got := p.Before(at); !got.Equal(time.Date(2024, 1, 30, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("before: %s", got)
	}
	for _, bad := range []string{"", "P", "PT", "P1DT", "30D", "P-1D", "P1.5D", "PT0S", "P0D", "p1d", "P1H", "P999999Y"} {
		if _, err := ParsePeriod(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestABadRetentionFileFailsWhereverItIs(t *testing.T) {
	good := "  scheduling: P2Y\n  closed: P5Y\n  deleted: P30D\n  cleanup: P1D\n  cleanupReadUnitsPerSecond: 500\n"
	for name, body := range map[string]string{
		"a bad period in another block": "prod:\n" + good + "staging:\n" + strings.Replace(good, "PT", "", 1) + "  extra: P1D\nlocal:\n" + good,
		"a period missing":              "prod:\n" + good + "staging:\n  scheduling: P2Y\n  closed: P5Y\nlocal:\n" + good,
		"not a duration":                "prod:\n" + good + "staging:\n" + strings.Replace(good, "P30D", "30 days", 1) + "local:\n" + good,
		"a cleanup in months":           "prod:\n" + good + "staging:\n" + strings.Replace(good, "cleanup: P1D", "cleanup: P1M", 1) + "local:\n" + good,
		"a cleanup in seconds":          "prod:\n" + good + "staging:\n" + strings.Replace(good, "cleanup: P1D", "cleanup: PT90S", 1) + "local:\n" + good,
		"a block missing":               "prod:\n" + good + "staging:\n" + good,
		// The cleanup reads the whole table, so it needs a budget, which a partition's 3,000 a second bounds.
		"a cleanup with no read budget":  "prod:\n" + good + "staging:\n" + strings.Replace(good, "  cleanupReadUnitsPerSecond: 500\n", "", 1) + "local:\n" + good,
		"a read budget with no cleanup":  "prod:\n" + good + "staging:\n" + strings.Replace(good, "  cleanup: P1D\n", "", 1) + "local:\n" + good,
		"a read budget of none":          "prod:\n" + good + "staging:\n" + strings.Replace(good, ": 500", ": 0", 1) + "local:\n" + good,
		"a read budget past a partition": "prod:\n" + good + "staging:\n" + strings.Replace(good, ": 500", ": 3001", 1) + "local:\n" + good,
	} {
		if _, err := parseRetention([]byte(body), "prod"); err == nil {
			t.Errorf("%s: loaded", name)
		}
	}
	if _, err := parseRetention([]byte("prod:\n"+good+"staging:\n"+good+"local:\n"+good), "prod"); err != nil {
		t.Fatal(err)
	}
}
