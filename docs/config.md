# Configuration

Every setting has one home, picked by who reads it and who it belongs to.

| What | Where | Example |
| --- | --- | --- |
| Limits and formats the server and the apps share, the same in every environment | `config/protocol.yaml` | `sync.maxChanges`, `clock.pattern` |
| Settings that differ by environment, but not between one deployment and another | `config/env/local.yaml`, `staging.yaml` and `prod.yaml` | `stack.terminationProtection` |
| Values only TypeScript reads | The TypeScript module that uses them | How often the app syncs |
| What only your deployment has: accounts, domains, emails, test users | Your private config folder, `MULTISCALE_CONFIG_DIR` | `aws.account`, `dns.zone` |
| Secrets | SSM, in the environment's account | Google's client secret, test-user passwords |

The first two are the app's own settings. They're public, in this repo, and the same for anyone who deploys it. The last two are yours, and [setup.md](setup.md) covers them. The two kinds are never merged: `config/env/staging.yaml` is the app's, and `staging.yaml` in your config folder is yours. Error codes, such as `record_too_large`, are contracts between the server and the apps, and stay in the code beside what returns them.

## How each language reads them

Go is the only reader of the YAML, and its only validator.

- The `config` Go module embeds `protocol.yaml` and `env/*.yaml`, decodes them strictly and checks them as the package loads. Any binary that imports it, a Lambda included, stops at start with every problem listed rather than run with a bad value.
- `go generate` in `config/` writes `config/app.gen.ts`: `protocol`, and each environment under `envs`, as `as const` objects, so their types come from their values, with `forEnv(env)` to pick an environment.
- `config/package.json` makes that file the npm package `@multiscale/config`. The web app and the infrastructure depend on it as `file:../config`, and Node runs it as TypeScript, as it does the scripts. TypeScript never parses the YAML.

| Reader | How |
| --- | --- |
| Go Lambdas | `config.Protocol.Sync.MaxChanges`. Each `main` calls `config.ForEnv(os.Getenv("ENV_NAME"))`, which fails on a name with no settings, so a wrong one stops the function at start. |
| `cmd/local` | `config.ForEnv("local")` |
| The web app | `import { protocol } from '@multiscale/config'`. The Vite build adds its environment's settings to the app's built-in config, `__APP_CONFIG__.settings`, from `forEnv(ENV)`. |
| The infrastructure | `forEnv(envName)`, for how each environment's resources are set up |
| The Go integration suite and the TypeScript sync tests against the local stack | The same values, so a changed limit is tested where it's enforced |
| The Mac app's main process and the iPhone app's native code | Nothing |

Native code reads nothing from the package because a web update reaches apps whose native code is older. A value native code needed would have to stay the same until every app was replaced. The Mac build refuses to bundle any file its shell hash doesn't cover, `config/app.gen.ts` included.

The web build resolves `@multiscale/config` to the checkout it builds, not wherever `node_modules` points. `make test-compat` builds the last release beside this checkout with this checkout's `node_modules`, and the older bundle has to keep its own limits for that test to mean anything.

## Changing a value

1. Edit the YAML. For an environment's setting, edit all three files in `config/env/`: nothing is inherited, so each one names every key.
2. In `config/`, run `go generate ./...` to rewrite `app.gen.ts`, then `go test ./...`.
3. Commit the YAML and `app.gen.ts` together. CI's config tests fail when `app.gen.ts` doesn't match the YAML.

A new key also needs a field in the Go struct it belongs to in `config/app.go`, with the same name in its `yaml` and `json` tags, and a rule in `check()` if it's tied to another value. Keys name their unit, as `maxRecordBytes` and `maxClockAheadHours` do. Patterns are read by both Go and JavaScript, so they keep to what both read alike: character classes, `\d`, `\x` escapes, counts, groups and anchors.

## What Go checks

Loading lists every problem across every file at once:

- each file decodes with no unknown key and no missing one;
- all three environment files are present, and no other;
- every number is positive and every string is set;
- `sync.maxChanges` is at most 99, since a request's changes and the user's counter share one DynamoDB transaction of 100 actions;
- a full batch, one more record and its merged room fit the request limit: `clientBatchBytes + maxRecordBytes + mergedRoomBytes <= maxBodyBytes`;
- the request limit stays under the 6 MB Lambda takes, with room for the event around it;
- `records.idPattern` and `clock.pattern` compile, and the clock pattern has the three groups the apps read: wall time, counter and device.

The checks run in three places: in CI, through `go test` in `config/`; in every build, where `forEnv` throws on an unknown environment; and in every Lambda as it starts.

## Keeping released apps working

A released app keeps running for months beside newer servers, and the web app updates before the native apps do. So:

- A server limit never drops below what a released app sends. To raise a limit, raise the server's and release it first, then the apps'.
- Id and clock formats only get wider, so the server takes every id and clock a released app makes.
- Retention never lets the server purge what an older app could still push back. Shorten it over two releases, the server's last.

`protocol.yaml` and each file in `config/env/` repeat the rules that apply to them.
