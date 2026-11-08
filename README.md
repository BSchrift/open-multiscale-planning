# Multiscale

A personal planner that connects long-term goals to the week. Goals hold projects, projects hold milestones and tasks, and one offs and practices sit beside them. Each week you pick what to work on and place it as time blocks; every few months a planning stretch steps back to the goals. Time blocks are mirrored to a Google Calendar.

It is local-first: everything lives in SQLite on the device and syncs through a small serverless backend you host yourself. One React app runs in the browser, on the Mac (Electron) and on iPhone (Capacitor).

**Status:** early development. Nothing has been released yet.

## How it's built

| Path | What |
| --- | --- |
| `frontend/src/core` | Domain logic, the local database and the sync client, in plain TypeScript |
| `frontend/src/platform` | Adapters for the browser, Electron and Capacitor |
| `frontend/src/ui` | React screens and components, one tree with desktop and phone layouts |
| `frontend/electron`, `frontend/ios` | The Mac app and the Xcode project |
| `backend/` | Go: `cmd/api` (sync and Google connect Lambda), `cmd/calendar` (the Google Calendar worker), `cmd/local` (both, plus stand-in sign-in and Google, for local use) |
| `backend/integration` | The black-box API suite, run against local, staging or prod |
| `infrastructure/` | AWS CDK: one stack per environment, `Multiscale-staging` and `Multiscale-prod`, plus `Multiscale-control` for an optional domain |
| `config/` | The Go module that loads each environment's YAML, and an example of each file |
| `site/` | The public page at `www.` your domain, deployed with the control stack |
| `scripts/`, `Makefile` | Deploy, test and local stack entry points |

## Run it locally

Needs Node 25, Go 1.25 and Docker. No AWS.

```sh
cd frontend && npm ci && cd ..
make up                                  # DynamoDB Local and Moto
(cd backend && DYNAMODB_ENDPOINT=http://localhost:8000 SSM_ENDPOINT=http://localhost:5001 go run ./cmd/local)
make dev                                 # the app in a browser, in another terminal
(cd frontend && npm run electron:dev)    # or the desktop app
make down                                # stops the stand-ins and drops their data
```

The local API listens on `localhost:8787` and signs in anyone. For iPhone, run `npm run ios:sync` in `frontend`, open `frontend/ios/App/App.xcodeproj` and run on a Simulator.

## Tests

| Command | What it runs |
| --- | --- |
| `make test-unit` | Vitest, `go test ./...` and the CDK tests with a synth. No Docker. |
| `make test-integration` | The API suite against a local stack it starts in Docker, plus the backend and sync client against the same stand-ins |
| `make test` | Both of the above |
| `make test-e2e` | Playwright: screens in Chrome and WebKit at desktop and phone sizes, two signed-in browsers syncing, then the real Electron app as two devices, then `make test-compat`. Needs Docker. |
| `make test-compat` | The last release's web bundle beside this checkout's: each opens a database the other wrote, as an update and a rollback after a failed trial do, and an old and a new device sync. `BASE` picks the old bundle's commit, by default the one prod serves when your config folder has prod, else `origin/main`. Needs Docker. |
| `make test-ios` | XCUITest on a throwaway iPhone Simulator (`IOS_DEVICE`, default `iPhone 16`), with the share sheet and widget off and on |
| `make scan` | gitleaks over the working tree |

Before the first `make test-e2e`, run `npx playwright install chromium webkit` in `frontend`.

Against a deployment, the same suites sign in as a dedicated test user, use unique ids and clean up after themselves. Tests that need the local stack's clock or injected failures are listed as skipped. Prod also needs `CONFIRM_PROD=yes`.

```sh
make test-deployed                                  # every suite below, plus the deployed web app, against staging
make test-deployed ENV=prod CONFIRM_PROD=yes
make test-integration ENV=staging
make smoke                                          # fast wiring check, plus CloudWatch logs and metrics
make test-e2e ENV=staging
make test-compat ENV=staging
make test-ios ENV=staging
```

`make test-deployed` runs, one after another, the deployed web app as people get it (the production build from its host, its security policy, the hosted sign-in, and a journey from Capture to the calendar), two browsers syncing, the integration suite, the smoke check, the iPhone test and, on staging, prod's web bundle and this checkout's syncing through it. It names any that failed. `SKIP_IOS=1` leaves out the iPhone test, much the slowest. `make release` runs it after every release.

These read your config folder, `$MULTISCALE_CONFIG_DIR` or else `config/`: `<env>.yaml`, and the `<env>.outputs.json` that `make deploy` writes. Test-user passwords come from SSM in that environment's account. [docs/setup.md](docs/setup.md) covers creating them.

## Deploying

Each deployment is your own: AWS accounts (three under AWS Organizations, or one), a Google OAuth client and, for iPhone, an Apple ID. Your config lives in a folder of your own, one YAML file per environment copied from `config/*.example.yaml`. [docs/setup.md](docs/setup.md) goes from a new AWS account to the app on your phone. In short, `make deploy ENV=control` lets staging and prod add their zones under your domain if you have one, `make deploy` deploys staging and `make deploy ENV=prod` deploys prod.

## License

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). If you run a modified version for other people over a network, the license requires you to offer them its source. Contributions need a signed [Contributor License Agreement](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).
