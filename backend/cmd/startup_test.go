package cmd_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Both Lambdas load the config.yaml that make deploy puts beside them before anything else, and stop at once when it's
// missing or wrong. Each runs as a real binary, outside Lambda and without AWS credentials.
func TestLambdasNeedTheirConfig(t *testing.T) {
	example, err := os.ReadFile("../../config/staging.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"api", "calendar"} {
		t.Run(name, func(t *testing.T) {
			dir, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			bin := filepath.Join(dir, "bootstrap")
			if out, err := exec.Command("go", "build", "-o", bin, "./"+name).CombinedOutput(); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			run := func() string {
				t.Helper()
				cmd := exec.Command(bin)
				// No shared AWS files, so the run never sees a real profile.
				cmd.Env = []string{"HOME=" + dir, "AWS_CONFIG_FILE=" + os.DevNull, "AWS_SHARED_CREDENTIALS_FILE=" + os.DevNull}
				out, err := cmd.CombinedOutput()
				if err == nil {
					t.Fatalf("it ran to the end outside Lambda: %s", out)
				}
				return string(out)
			}

			config := filepath.Join(dir, "config.yaml")
			if out := run(); !strings.Contains(out, "missing "+config) {
				t.Fatalf("without config.yaml: %s", out)
			}
			if err := os.WriteFile(config, append(example, "unknownKey: 1\n"...), 0o600); err != nil {
				t.Fatal(err)
			}
			if out := run(); !strings.Contains(out, "unknownKey") {
				t.Fatalf("with an invalid config.yaml: %s", out)
			}
			if err := os.WriteFile(config, example, 0o600); err != nil {
				t.Fatal(err)
			}
			// Past the config, it stops only because there's no Lambda runtime to talk to.
			if out := run(); strings.Contains(out, "config.yaml") || !strings.Contains(out, "AWS Lambda environment variables") {
				t.Fatalf("with a valid config.yaml: %s", out)
			}
		})
	}
}
