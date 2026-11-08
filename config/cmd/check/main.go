// Command check loads staging.yaml or prod.yaml from the config folder with the strict loader the integration suite
// reads it with, so make deploy stops on a file the suite would refuse instead of deploying from it.
// Usage: go run ./cmd/check <staging|prod>
package main

import (
	"fmt"
	"os"

	"github.com/BSchrift/open-multiscale-planning/config"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: check <staging|prod>")
		os.Exit(2)
	}
	if _, err := config.Load(config.Dir(), os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
