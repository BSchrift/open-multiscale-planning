// Command gen writes app.gen.ts, the TypeScript copy of the app's own settings, once the config package has checked
// them. go generate runs it in config/.
package main

import (
	"fmt"
	"os"

	"github.com/BSchrift/open-multiscale-planning/config"
)

func main() {
	ts, err := config.TypeScript()
	if err == nil {
		err = os.WriteFile("app.gen.ts", ts, 0o644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
