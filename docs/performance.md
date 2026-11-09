# Performance

How fast Multiscale has to stay as an account's history grows, how that's measured, and where it stands. A new device's
first sync downloads every record, and on the web every edit writes the whole database to IndexedDB, so both slow down
as history grows. `make test-history` measures them on a made-up five-year account and fails when a budget is missed.

## Budgets

| Budget | Surface | Limit |
| --- | --- | --- |
| First sync to a usable app | Web, Mac | 10 s |
| First sync to a usable app | iPhone Simulator | 20 s |
| An edit saved | Web | 50 ms |
| Today query | Web, Mac, iPhone Simulator | 100 ms |
| Week query | Web, Mac, iPhone Simulator | 100 ms |

`frontend/scripts/history-report.ts` holds the same budgets and checks every run against them.

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
to the save being set off, which covers the edit's own transaction, plus from the save starting to IndexedDB finishing
the write. The web app waits 200 ms for more edits before it saves, and that wait is left out, since it's not work.

**Today and Week** are `loadToday` and `loadWeek`, everything each screen reads, again on every change. Each is the median
of five runs as of the account's end, in the app's own page through the app's own driver: the web app's sql.js, on the
database it saved; the Mac app's bridge to SQLite in the main process; and on iPhone the Capacitor SQLite plugin, from
the test page the app's test copy carries.
