# Performance

How fast Multiscale has to stay as an account's history grows, how that's measured, and where it stands. A new device's
first sync downloads every record, and Today and Week read more of it, so both slow down as history grows. `make test-history` measures them on a made-up five-year account and fails when a budget is missed, unless it only
reports, as `make test-deployed` does on staging.

## Budgets

| Budget | Surface | Limit |
| --- | --- | --- |
| First sync to a usable app | Web, Mac | 10 s |
| First sync to a usable app | iPhone Simulator | 20 s |
| An edit saved | Web | 50 ms |
| Today query | Web, Mac, iPhone Simulator | 100 ms |
| Week query | Web, Mac, iPhone Simulator | 100 ms |
| Pick estimate drag, slowest step (report only) | Web, Mac | 50 ms |
| Done query (report only) | Web, Mac, iPhone Simulator | 100 ms |

`frontend/scripts/history-report.ts` holds the same budgets and checks every run against them. A report-only budget is
shown in the report but never fails a run, missed or not measured, until it has a baseline of its own.

## Baseline

Measured on 8 November 2026 at `refactor-audit` (e915a7b), before any of the large-history work, with
`HISTORY_REPORT_ONLY=1 make test-history` against the local stack: an Apple M4 Mac with 24 GB, macOS 15.5, and an
iPhone 16 Simulator on iOS 18.6. The baseline is a full run with no other test runs on the Mac. The second column
is an earlier full run while other test runs shared the Mac, which shows how far the numbers move with load: the Mac
app's and the iPhone's first sync took twice as long.

| Budget | Surface | Baseline | Busy Mac | Limit | |
| --- | --- | --- | --- | --- | --- |
| First sync to a usable app | Web | 2.9 s | 3.5 s | 10 s | Met |
| First sync to a usable app | Mac | 17.4 s | 36.5 s | 10 s | Missed |
| First sync to a usable app | iPhone Simulator | 123.9 s | 231.5 s | 20 s | Missed |
| An edit saved | Web | 50 ms | 69 ms | 50 ms | Met, just |
| Today query | Web | 338 ms | 380 ms | 100 ms | Missed |
| Today query | Mac | 183 ms | 298 ms | 100 ms | Missed |
| Today query | iPhone Simulator | 419 ms | 409 ms | 100 ms | Missed |
| Week query | Web | 365 ms | 397 ms | 100 ms | Missed |
| Week query | Mac | 197 ms | 327 ms | 100 ms | Missed |
| Week query | iPhone Simulator | 539 ms | 425 ms | 100 ms | Missed |

What the runs showed beside the numbers:

- **The first sync** brings the 38,836 records down in 78 pages of 500 on every surface. The web app applies them in
  sql.js in the page. The Mac app sends each statement to SQLite in its main process, and the iPhone app sends each
  one through the Capacitor plugin, so they take about six and forty times as long for the same records, and more on a
  busy Mac. The app shows Setup's "Signing in…" until the settings record arrives, which is last, so usable means every
  record is down for now.
- **An edit** commits in 0.5 to 7 ms. The rest is writing the whole database, 24.6 MB, from sql.js to IndexedDB: 43 to
  96 ms, the first after the sync slower than the rest. The edit budget is met only on a quiet Mac, by 0.2 ms.
- **Today and Week** both read whole tables on every change, as the `shortcut:` comments in
  `frontend/src/ui/screens/today/data.ts` and `frontend/src/ui/screens/week/data.ts` say: every task, project, pick and
  week plan, and for Week the analytics data too.

The baseline run took 5 minutes 11 seconds: about a minute to start the stack and build the app, a minute and a half
to seed the account (35 s) and time the browser and the Mac app, and under three for the iPhone, two of them its first
sync. On the busy Mac it took 9 minutes 48 seconds. On staging the first run also paces the seed, which adds about
three minutes; later runs write nothing but still send all 393 batches.

Staging's numbers come once its history user is set up, as [docs/setup.md](setup.md) describes. Add them here then.

## KPI marks

The performance KPIs, approved on 14 November 2026, time the flows people use most, the same way on the web, the Mac
app and the iPhone. Each one is a User Timing measure of its own name, from its start event to its stop event, made by
`frontend/src/core/perf.ts`. The marks are always on, behind no flag: a start is a map write, a stop one
`performance.measure`, and past 500 measures the page clears them, so memory stays flat. A start takes the input
event's own timestamp, a pointer's click from its pointerdown, so time the page spent busy before it could run counts.
"Drawn" means after the next frame is painted: a frame callback, then a message once it has run.

| Measure | Starts at | Stops at | Where |
| --- | --- | --- | --- |
| `capture.open` | The shortcut's keydown, or the Capture button's pointerdown | The capture field focused, drawn | `ui/app/Shell.tsx`, `ui/screens/capture` |
| `capture.global` | Shift-Command-Space, as the Mac app's main process gets it | The panel shown with its field focused, drawn | `electron/main.ts`, `electron/capture-preload.ts` |
| `capture.key` | A key's keydown in the capture field | Its character drawn | `ui/screens/capture` |
| `capture.save` | Enter's keydown, or Save's pointerdown | The task committed and "Saved" drawn | `ui/screens/capture` |
| `nav.today`, `nav.week`, `nav.done`, `nav.analytics` | The tab's or More row's pointerdown | The screen shown with its data, drawn | `ui/app/Shell.tsx`, `ui/app/MorePage.tsx`, `ui/app/drawn.ts` |
| `today:interactive` (a mark) | | Today first drawn with its data | `ui/screens/today` |
| `start.resume` | The app back in front while running | The next frame after | `ui/app/Shell.tsx` |
| `sync.send` | A push's request sent | Its reply | `core/sync.ts` |
| `sync.push` | The first change a push carries, committed | That push's reply, after a failed try too | `core/syncRunner.ts`, `core/sync.ts` |
| `sync.pull` | A sync starting | A screen drawn with what it brought; dropped when it brought nothing | `core/syncRunner.ts`, `ui/app/store.tsx` |
| `notify.action` | A notification's answer reaching the app | The answer committed | `ui/app/reminders.ts` |

The start KPIs, `start.cold` and `start.warm`, run from the launch to `today:interactive`: navigation start on the web,
and the launch time the test records for the Mac app. `sync.first` stays the history-scale test's first sync.

Still to mark: `popup.open` and `popup.save` in the task popup, `process.step` in Process, `drag.frame` and `drag.drop`
on Today's timeline and Week, and `plan.step` in Plan the week, whose screens were being changed when the marks went
in; `capture.control` and `capture.share`, which start in the iPhone's extensions. `e2e/perf-marks.spec.ts` and
`electron/e2e/perf-marks.spec.ts` check that each action makes exactly one measure.

### The KPIs' data

Each KPI runs on one of three accounts, made by `frontend/src/core/history-testing.ts` and loaded straight into the
device's database, as a sync would apply it, so no sync is timed but `sync.first`:

- **Empty:** `emptyAccount(now)`, a new account past first-run setup.
- **One year:** `historyChanges({ weeks: 52, now })`, the history-scale account's weekly mix over 52 weeks, about 7,800
  records, ending when the run starts, so Today and Week have this week's blocks.
- **Five years:** `historyChanges({ weeks: 260, now })`, the same 38,836 records as the history-scale test, ending now.

The browser loads them through `window.multiscaleApply`, which dev builds and the runner's build (`vite build --mode
perf`) have and production bundles drop. `e2e/perf-seeds.spec.ts` checks that a year and a new account arrive whole.

### The runner

`make test-perf` runs [scripts/test-perf.sh](../scripts/test-perf.sh): it builds this checkout as it's timed, runs
`frontend/e2e/perf` on the browser and the Mac app, and prints each KPI's p50, p95 and p99 against its target in
[config/perf.ts](../config/perf.ts), the one list of KPIs and targets that the PR check and the CloudWatch dashboard
read too. It's report-only: it fails when a spec can't run, never on a timing.

- **Platforms:** desktop Chromium at 1360 × 1000; Chromium at 390 × 844 with its CPU slowed 4× and, for cold starts,
  Lighthouse's slow 4G; and the Mac app, under xvfb on Linux. `PERF_PLATFORMS` picks some.
- **Builds:** the browser's is `vite build --mode perf`, served gzipped with the hashed assets cached, as CloudFront
  serves them; the Mac app's is the build it ships, with its data folder filled before it starts. `BASE=<commit>`
  builds that commit too, takes samples from the two in turns of 10, alternating which goes first, and compares them.
- **Samples:** `PERF_SAMPLES` per KPI per build (100), after `PERF_WARMUP` actions thrown away (20), and
  `PERF_LAUNCHES` cold and warm starts (5). A cold web start is a copy of a profile that holds the data, without its
  HTTP cache; a cold Mac start is the first launch of a pair.
- **Results:** the raw samples, a summary per build and, with a base, the comparison as the PR comment shows it, in
  `frontend/test-results/perf`.
- **Slower** means all of: the samples differ (Mann-Whitney, p < 0.01), the p95 is more than 10% over the base's, and
  by more than the KPI's floor (2 ms for frames and typing, 5 ms for quick actions, 25 ms for screens and sync, 100 ms
  for starts). `sync.push` is never compared: the 2-second wait before a push hides a slower one, which `sync.send`
  catches.

It replaces the two capture benchmarks, `BENCH=1` in `e2e/capture-bench.spec.ts` and the Mac app's: their open, typing
and Enter-to-saved timings are `capture.open`, `capture.key` and `capture.save`, and the shortcut panel's is
`capture.global`. A first run on the shared Mac on 14 November 2026, 10 samples each, on a year of data:
`capture.save` 24 ms at p50 on the desktop browser, 64 ms on the phone browser and 12 ms in the Mac app; the screens
13 to 16 ms on desktop and 48 to 205 ms on the phone; cold starts 5.2 s on desktop, 29 s on the phone over slow 4G,
and 1.9 s in the Mac app; 291 KB fetched on a cold first load.

### Bundle bytes

`web.initial`, the gzipped bytes of the scripts and styles the web app's page links, is exact, so it blocks a merge
from the first day: the frontend CI job runs `node scripts/bundle-budget.ts dist` on its build and fails over the
200 KB in `config/perf.ts`. On 14 November 2026 it was 173.3 KB in 15 files. Given the base's build too
(`--base <dist>`), it notes a change that adds more than 5 KB, which the PR check puts in its comment. `web.firstload`,
everything a cold first load fetches until Today is interactive, is counted by the runner's cold starts in a browser:
291 KB on that day, gzipped.

## How it's measured

`make test-history` runs [scripts/test-history.sh](../scripts/test-history.sh). [docs/setup.md](setup.md) covers running
it against staging, and its own user there.

**The account** is made by `frontend/src/core/history-testing.ts`, the same on every run: 260 weeks of one heavy user,
ending on a Wednesday noon in Chicago, 4 November 2026. Each week has about 35 time blocks and their 35 answers, 40
tasks (20 for projects, 10 one offs with now and then a repeating one, and 10 Inbox captures, sorted later or still
waiting), 20 picks, 10 finishes of repeating tasks, and 10 of a week plan, a project, its 6 milestones and 2 goals, time
off, practices or calendars. One settings record ends it. That's 38,836 records, 7,747 of them (20%) deleted, at 400
bytes each on average, measured as the sync API does: a record's fields with their clocks, as JSON. They're seeded in
the order they were last written, oldest first and settings last, so a first sync brings them down in that order too.

**Seeding** goes through the sync API as a device does, in batches of up to 99 records and 4 MB, paced on a deployment
to 500 write units a second, half of what one user's partition takes. Every record has a fixed id and fixed clocks, so a
rerun writes nothing and the account never grows. Locally the stack starts empty and is seeded each run, unpaced. It
sends as an up-to-date app does, and leaves out the deleted records whose deleted period has passed, since the server
drops those ([retention.md](retention.md)). That leaves about 31,000 records with few or none deleted: locally only
those deleted in the last 30 days, and on staging, whose period is minutes, none. The rest carry no expiry, as records
from before retention do, so the account still spans five years.

**First sync to a usable app** is timed on a new device of that user, from the sign-in being sent (the hosted page's
submit on a deployment, or the Sign in tap on the local stack, whose sign-in has no page) until the app shows Today with
the account's Inbox count in its navigation. That count comes from the newest records, so it means this week's data is
in. The web app is the production build, served from this Mac in a new browser; the Mac app is a new data folder; the
iPhone app is erased first.

**An edit saved** is Notify at block start in Settings, turned off and on twice, the median of the four: from the click
until the edit's transaction has committed in the web app's database worker, which keeps the database on the browser's
private file system (OPFS), so a committed change is on disk.

**Today and Week** are `loadToday` and `loadWeek`, everything each screen reads, again on every change. **Done** is
`loadDoneDay` for the account's last day, which reads only that day's records, through indexes. Each is the median
of five runs as of the account's end, in the app's own page through the app's own driver: the web app's worker, with
SQLite on OPFS; the Mac app's bridge to SQLite in the main process; and on iPhone the Capacitor SQLite plugin, from
the test page the app's test copy carries.

**Pick estimate drag** is weekly planning's Pick step: the first project's card, its first task's time button, and the
Estimate slider in the time popover that opens, dragged with the mouse across ten steps, saved, and then put back with
the toast's Undo: the slowest step, from its input event until the frame after it. Before the slider saved only once it was let go, each step saved, and every save read every mounted
screen's data again. On this account that made the Mac app take 430 ms a step (the median), and the web app show the
let-go value 6 seconds after letting go, measured on a production build with this history loaded straight into its
database rather than synced. On 12 November 2026, `HISTORY_REPORT_ONLY=1 SKIP_IOS=1 make test-history` on the shared
Mac measured the slowest step at 397 ms on the web and 820 ms in the Mac app with every step saving, and 16 ms and
8 ms once the slider saved only when let go. On 13 November 2026, with Pick's project cards and its time popover, the
same run measured 14 ms and 8 ms.

## Battery

What drains a phone's or a laptop's battery, measured on real devices and reported with the apps' other telemetry
([setup.md](setup.md), "What the apps report"). Every value is a number or a fixed word, never what a person wrote, and
the API keeps only the events and attributes it lists. Nothing has a budget yet: after two weeks of data, each gets one
at the 90th percentile of a good week plus a margin, reported and never failing a release.

| Event | From | When | Attributes |
| --- | --- | --- | --- |
| `app.sync.count` | Web, Mac, iPhone | Each minute, with the heartbeat | `sync.count`, the sync requests the server answered since the last one, and `sync.bytes`, about the bytes they sent and received |
| `app.energy.sample` | Mac | Each minute, with the heartbeat, one for each kind of process | `energy.process` (main, renderer or gpu), `energy.cpu_percent` and `energy.idle_wakeups_per_s` over the minute, from Electron's `app.getAppMetrics()`, and `energy.window_visible` |
| On `app.heartbeat` | Mac | Each minute | `device.battery.charging` (on AC power) and `device.thermal_state` |

Idle wakeups are macOS's own measure of what drains a laptop in the background, and with CPU they're most of what
Activity Monitor's Energy Impact shows, which an app can't read itself. The Mac app keeps running in the menu bar
after its window closes, so `energy.window_visible` tells that apart: then it should be close to nothing.

Each sync wakes the radio, so a sync loop is the battery bug most likely to slip in, and `app.sync.count` is the web
app's only battery signal: browsers don't say how much power a page uses.
