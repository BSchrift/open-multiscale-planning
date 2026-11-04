package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// check runs this command, as make deploy does, on a config folder holding this staging.yaml.
func check(t *testing.T, staging string) (string, error) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "staging.yaml"), []byte(staging), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "run", ".", "staging")
	cmd.Env = append(os.Environ(), "MULTISCALE_CONFIG_DIR="+dir)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func example(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("../../staging.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestPassesAFileTheLambdasLoad(t *testing.T) {
	if out, err := check(t, example(t)); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
}

func TestFailsOnAFileTheLambdasWouldStopOn(t *testing.T) {
	for _, c := range []struct{ name, file, wants string }{
		{"misspelt key", example(t) + "app:\n  bundleID: com.example.app\n", "field bundleID not found"},
		{"second user without a name", strings.Replace(example(t), "[googleClient]", "[googleClient, secondUser]", 1), "integration.secondTestUser is required"},
	} {
		out, err := check(t, c.file)
		if err == nil || !strings.Contains(out, c.wants) {
			t.Errorf("%s: %v: %s", c.name, err, out)
		}
	}
}
