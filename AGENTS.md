# How we build Multiscale

For any agent working in this repo. These are the habits the project was built with. Use judgement inside them, and
when one doesn't fit a case, say so rather than quietly working around it. The `ponytail` and `caveman` skills they
name are in [.claude/skills](.claude/skills): Claude Code loads them from there, and any other agent can read their
`SKILL.md`.

## Building

- **Test first.** Write or extend the failing test, see it fail, then make it pass. A change isn't done until the tests
  that cover it pass where it runs: unit, browser, Mac app, iPhone.
- **The smallest complete change.** This is the `/ponytail` way. Reuse what the codebase already has before adding
  anything. Skip options and abstractions nobody asked for. But finish everything the change touches: callers, tests,
  fixtures, docs. A known limit gets a `// shortcut: <the limit>, <when to upgrade>` comment. Never cut validation at a
  trust boundary, error handling that prevents data loss, security or accessibility.
- **Match the code around you:** its naming, structure and comment density. Comments say why, not what.
- **Check your work as a person would.** Run the app, look at screenshots on desktop and phone, and say plainly what you
  didn't verify.

## Settings

A new value someone might change, unless it's specific to one deployment or secret, goes in the app's config, as
[docs/config.md](docs/config.md) explains:

- **The same in every environment, and read by both Go and TypeScript:** `config/protocol.yaml`.
- **Different per environment:** all three files in `config/env/`. Nothing is inherited, so each names every key.
- **Read only by TypeScript:** a TypeScript module. Error codes are contracts and stay where they're returned.
- **Specific to one deployment,** such as an account, domain or email: the private config folder. **Secrets:** SSM.
- **Keys name their unit,** such as `maxRecordBytes` and `maxClockAheadHours`.
- **Released apps keep working:** a server limit never drops below what a released app sends, so raise the server's
  first; id and clock formats only get wider; and retention never lets the server purge what an older app could push
  back, so shorten it over two releases, the server's last.

After editing the YAML, run `go generate ./...` in `config/` and commit `app.gen.ts` with it. Native code imports
nothing from the package.

## Tests

| Layer | Runs | Command |
| --- | --- | --- |
| Local, no deployment | Unit tests; browser e2e at desktop and phone sizes; the Mac app; a Docker stand-in backend for sync; the last release's web bundle beside this one; the iPhone Simulator | `make test`, `make test-e2e`, `make test-compat`, `make test-ios` |
| Against a deployment | The deployed web app, sync, on staging the last release's web bundle beside this one, the integration suite, smoke, the iPhone signed-in test | `make test-deployed` (staging), `ENV=prod CONFIRM_PROD=yes` |
| CI | Everything in the local layer, on every PR and every push to main | `.github/workflows/ci.yml` |
| On demand and before releases | The history-scale test: a seeded five-year account timed on the browser, the Mac app and the iPhone Simulator against the budgets in [docs/performance.md](docs/performance.md). Too slow for every PR | `make test-history` (local stack), `ENV=staging`; `make test-deployed` runs it on staging, report-only |
| Release | The release pipeline: staging's suites on each main commit, prod's after its canary, and every night staging's slow ones. See [docs/releasing.md](docs/releasing.md) | `scripts/pipeline.sh` |

**Anything you check by hand belongs in a layer.** That includes a scratch script, a device check, or a curl. Add it
to the right layer in the same change, or say why it can't be automated.

## Before you open a PR

For contributors and agents alike. None of this needs a deployment or AWS access: everything here runs locally.

**1. Test first, at the lowest layer that can show it.**

- Write the test that fails. See it fail for the reason you expect, then make it pass, then tidy up.
- Use the lowest layer that can show the behaviour: a core unit test before a component test, and a component test
  before an e2e test. Add a higher layer only for what the lower one can't see.
- While working, run just that test:
  - `npx vitest run <file>` and `npx tsc --noEmit -p .` in `frontend`;
  - `go test ./internal/<package>` in `backend`.

**2. Run the suites for what you changed.** Run every row that applies, so it's green before CI sees it.

| You changed | Run |
| --- | --- |
| Anything in `frontend/src` | `make test-frontend`; `scripts/e2e.sh browser` (desktop and phone) |
| Stored data, record types, views or sync | The above, plus `make test-compat`, `scripts/e2e.sh stack` and `make test-integration` |
| Storage or platform adapters, Electron main or preload | The above, plus `scripts/e2e.sh electron` |
| The Go backend | `make test-backend`; `make test-integration` (the Docker stack, with stand-ins for DynamoDB, SSM, sign-in and Google) |
| Infrastructure | `make test-infra` (tests and `cdk synth`) |
| Anything the iPhone draws or does differently: phone CSS, Capacitor, native iOS | `make test-ios` |
| Sync, queries or storage speed | `HISTORY_REPORT_ONLY=1 make test-history`, and note the numbers in the PR |
| A large refactor | `make test`, `make test-e2e` and `make test-ios` |

**3. Smoke test it as a person.**

- Run the app with `make dev`, the Mac app, or the iPhone Simulator.
- Use the change at desktop and phone size.
- Look at screenshots of anything visual.
- If you checked something by hand, add it to a test layer in the same PR, or say why it can't be automated.

**4. Open the PR with:**

- the tests you added, and that they failed first;
- the commands you ran, with their results;
- screenshots of UI changes;
- compatibility notes for older app versions and stored data;
- what you didn't verify.

Then wait for CI. A PR merges only with every check green.

**For agents in particular:**

- The Mac is shared, so keep test workers at 3 or fewer: `--maxWorkers=3` for Vitest, `--workers=3` for Playwright.
- Don't run the iOS Simulator while another agent is using it.
- Rebase on main and run the suites again before opening the PR.
- Never install into a shared `node_modules`.
- Never merge with a red check that main doesn't share.

## The product's rules

- **Nothing happens to someone's plan without them.** Time is placed, and tasks are finished, only by an explicit action.
  Suggestions are shown, never saved. Planning tasks are the one record the app makes without a tap: they place no time,
  and they can be skipped or undone.
- **Every change can be undone,** usually from the toast that reports it.
- **Copy is plain and specific,** in sentence case, and says what happened.
- **Accessibility is part of done:**
  - controls named in full;
  - 44pt tap targets on phone;
  - focus that lands somewhere sensible;
  - `prefers-reduced-motion` respected.

## The repo and releases

- **This repo is public and holds code only.** No secrets, real names, emails, account IDs, domains or team IDs: not in
  code, commits, PRs or docs. Deployment config lives in a private config folder (`MULTISCALE_CONFIG_DIR`), and release
  keys are never committed.
- **Work on a branch and open a PR.** Never push or merge to `main`, deploy or release to prod, or create repositories
  unless the owner has said to.
- **Releases go through the pipeline,** as [docs/releasing.md](docs/releasing.md) explains:

  | Step | What happens | Who |
  | --- | --- | --- |
  | Merge to main | Only with every CI check green | Owner |
  | Staging | Built once, deployed by a 10-minute canary, then tested | The pipeline, on each main commit |
  | Window before prod | An email says the commit passed staging and when it goes to prod, with a link to send it sooner. No approval: it goes then unless stopped, by `make pipeline-stop` | The pipeline; the owner may stop it |
  | Prod | The same build, by a canary of 10% for 90 minutes. An alarm rolls it back by itself. Then tested, and the version uploaded | The pipeline |
  | Web, the Mac, the iPhone | One surface at a time: the web app, a 2-hour bake, the Mac's feed, a 2-hour bake, the iPhone's feed. A release alarm in ALARM after a bake switches that surface back by itself and stops the run | The pipeline |
  | Signed apps | `make release-tag`, then `make release ENV=prod` from the tag | Owner, on the Mac |

  To roll back, revert on main and let it release. `make release-surface` switches the web app or one app's feed back
  to a version kept. `make pipeline-pause` holds main's commits back, and `make promote` starts a run by hand.
- **Stop a run only when the owner asks in chat.** `make pipeline-stop` stops every run that is waiting: in its window
  before prod, so it never reaches prod, or in a bake, so the next surface never gets it. Say which commits it stopped.
- **Skip the canary only with the owner's explicit go-ahead, each time.** `CANARY=skip` sends prod's new backend all its
  traffic at once. Ask for each release, say why, and note it in the PR or release notes.
- **Skip the bakes only with the owner's explicit go-ahead, each time.** `make promote BAKES=skip` starts a run whose
  prod surfaces take the release one after another without waiting out the bakes between them. Ask for each release,
  say why, and note it in the PR or release notes; the release tag notes it too.
- **Turn the release alarms off only with the owner's explicit go-ahead, each time.** `ALARMS=off` lets a release start
  while a release alarm is firing, to ship the fix for it; nothing then rolls it back on an alarm. Ask for each release,
  say which alarm fires and why the release fixes it, and note it in the PR or release notes.
- **Commit messages and PRs are plain prose:** a summary line, then what changed for the person using the app, and why.

## Working with the owner

- **In chat, be terse:** the answer first, every fact kept, no filler. This is the `/caveman` voice. Code, comments,
  commits, PRs and docs are written in plain, full sentences.
- **Decide what's yours to decide,** and say what you decided. Ask only when the choice is genuinely the owner's.
- **When the owner says they've done a step, take it as done.**
- **Report outcomes as they are:** failing tests with their output, and steps skipped.
