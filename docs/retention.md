# Data retention

Multiscale keeps history for a set time, then removes it from every device and from the server. This page says what
each period covers and what it counts from, and how the app, the API and DynamoDB share the work. **Settings > Data
retention** tells people the same in plain words, from the periods the app was built with.

## What's kept, and for how long

| What | Counted from | Prod | Staging |
| --- | --- | --- | --- |
| Time blocks (`time_block`) and their answers (`block_outcome`) | The block's end | 2 years | 20 minutes |
| Week picks and week plans | The end of that week | 2 years | 20 minutes |
| Finishes of repeating tasks (`task_completion`) | `done_at` | 2 years | 20 minutes |
| Away dates | Their end | 2 years | 20 minutes |
| Stretches pinned in `settings.plan_stretch.one_offs` | The stretch's end | 2 years | 20 minutes |
| Entries in a project's `slip_log` | The entry's `at` | 2 years | 20 minutes |
| Done, cancelled and dropped tasks, one offs included | `done_at` or `cancelled_at`, whichever is later | 5 years | 35 minutes |
| Attachments (`attachment`) of done, cancelled and dropped tasks, with their files | Their task's expiry, which the task's write passes on | 5 years | 35 minutes |
| Finished and dropped projects, with their milestones | When the project's state was set | 5 years | 35 minutes |
| Archived goals | When the goal's state was set | 5 years | 35 minutes |
| Anything deleted | `deleted_at` | 30 days | 5 minutes |
| Everything of an account its owner deletes, in Settings | The deletion | Minutes, then 35 days in backups | The same |

A deletion beats everything else: a deleted record goes 30 days after `deleted_at`, whatever else it holds. That
includes a removed attachment, and a deleted task's, which takes the task's deletion: its file stays for those 30 days,
so Undo brings back both, and counts against its owner's quota until it goes.

Never removed: open tasks and Inbox items, active and paused projects and their milestones, goals that aren't archived,
practices, settings, and the calendar records. A time block, pick or finish that expires never takes its task with it.
A week's planning task that was neither done nor deleted is an open task too: hidden once its week has passed, and kept.
A deleted one goes after the deleted period, on prod long after the three days the app makes it in, so no device makes it
again; on staging, whose period is minutes, a device can make it again within those three days.

Dates count from the end of the day in UTC, so every device works out the same expiry wherever it is. A project's and a
goal's close time is when their `state` was last written, from that field's clock, since neither has a closed date of
its own.

The two lists, pinned stretches and a project's slip log, lose old entries rather than expiring: each write to the record
drops the entries older than the scheduling period.

Done, a day's list of what was finished and the time worked, stores nothing. It reads the records above as they stand,
so a day's list shrinks as they go: its time worked and repeat finishes after 2 years, its finished tasks after 5, and a
task deleted since, shown as "deleted", 30 days after the delete, with its blocks' entries.

## The configuration

[config/retention.yaml](../config/retention.yaml) holds a block per environment: `prod`, `staging` and `local`, each
with ISO 8601 periods for `scheduling`, `closed` and `deleted`. Staging's block also has `cleanup`, how often its cleanup
job runs. It has two readers, which check the same rules and fail on any bad value in any block:

- [config/retention.ts](../config/retention.ts), for the app's build, which puts its environment's block into the app
  the way it does the API's address, and for the CDK stack, which sets up staging's cleanup from it.
- [config/retention.go](../config/retention.go), which builds the file into every Lambda with `go:embed`. Each picks
  its block by `ENV_NAME`.

`local` matches prod. Tests move a clock instead of waiting.

Staging's periods are minutes so that `make test-retention` can watch every stage in one sitting, about 50 minutes.
Deleted is 5 minutes, longer than the 5 minutes between an open app's syncs, so an open device sees a delete before it
goes; each later period ends more than two cleanup runs after the one before, so the suite sees each stage apart. The cost is that a device closed for more than a
few minutes across a change that then expires is reset when it next syncs, which on staging is often.

## How it fits together

### On the device

- **Every write works out the record's expiry.** The write path in `frontend/src/core/records.ts` calls `expiryFor`
  ([retention.ts](../frontend/src/core/retention.ts)) on the record as it stands after the write, and stores the result
  as its `expires_at` field, so every writer is covered. It clears `expires_at` when what it counts from clears, as when
  a task opens again or a project is restored. A project's write passes its expiry on to its milestones, a block's
  to its answer, and a task's to its attachments, so done, cancelled and dropped tasks keep their attachments for their 5
  years. Lists are trimmed in the same write.
- **Filling in at launch.** Before its first sync, the app gives `expires_at` to records that lack it, and to any whose
  source an app from before changed since. It writes through the automatic writer, so a field filled for the first time
  gets the lowest clock and any real edit from any device wins.
- **Removing what has expired.** At launch and after each sync, the app deletes records whose `expires_at` has passed,
  with their outbox rows. One whose filled-in expiry hasn't reached the server yet waits for the next sync, so the
  server's copy gets it and goes too.
- Every change a device sends carries the record's `expires_at` as it stands, so the server can tell a change to an
  expired record even when it no longer holds the record.

### On the server

- **TTL removes expired records.** Every write copies the merged record's `expires_at` into the item's top-level
  `expires_at`, in epoch seconds, which is the table's TTL attribute, and leaves it off when the field is null. A record
  deleted by an app from before, or by the calendar worker, gets `deleted_at` plus the deleted period instead. DynamoDB
  removes an item usually within a few days of that time.
- **Writers that don't work expiries out can't leave a wrong one.** When an app from before, or the calendar worker,
  changes a field an expiry counts from after the expiry was set, as when one reopens a task or restores a deleted
  record, the API clears `expires_at` in the same write, so the old expiry can't remove the record early. A deleted
  record then goes by `deleted_at`, and the next up-to-date app to launch works the expiry out again.
- **Pulls leave out what has expired** as soon as it has, so nothing waits on DynamoDB. The cursor still moves past it,
  and a pull that reaches the end moves the cursor to the counter, past any record already removed. They go by the
  record, as the checks on changes do, not by the TTL attribute, so a record deleted before retention, which has none,
  is left out once its deleted period has passed. A new device never takes one on, so never fills it in.
- **A file follows its record.** An attachment's file sits in the environment's bucket, and the API keeps its key and
  size in a `file#<attachment id>` item beside the record, with the bytes the person stores in `meta#storage`. When TTL
  removes an attachment's record, the Streams consumer deletes its file from the bucket, the `file#` item and its bytes
  from `meta#storage`; staging's cleanup does the same just before it removes the record. The file goes first, so a
  failure leaves the `file#` item for the retry to find. The bucket has no expiry of its own: the record decides.
- **The Streams consumer keeps the expiry mark.** `cmd/retention` reads TTL's removals from the table's stream, which
  carries the old image for this, and stores the highest removed sequence number as that user's mark (`meta#expired`).
  Its event source passes only TTL's removals, `userIdentity` `Service` from `dynamodb.amazonaws.com`.
- **Staging's cleanup** runs every 5 minutes in the same Lambda, because staging can't wait days for TTL. It reads the
  whole table, so its scan goes a page at a time, paced to `cleanupReadUnitsPerSecond` in `config/retention.yaml`. A
  table staging's size is one partition, which serves 3,000 read units a second, and each user's records stay in one
  however large the table grows. An unpaced scan throttled the table and set off the release alarm that stops deploys.
  It raises the mark for what has expired first, and removes it on a run at least 30 seconds later, by which time every
  sync that could miss it has read the mark. Prod relies on TTL alone, and the local stack runs the cleanup when a test asks.

Why TTL and Streams rather than a job: TTL deletes cost no write units, and Lambda reads Streams at no charge, where a job
would read the whole table each run, or need an index that every write pays for, and pay for each delete. Late removal
is safe because everything goes by `expires_at`, not by whether the item is gone.

### Devices that missed something

A device that holds an older copy of a record that has since expired must not keep it, or bring it back. An app sends
`expiry_reset: true` with each sync, and the API answers `reset: "expired"` instead of merging when:

- its cursor is below the user's mark, so something it never saw the last of was removed; or
- its pull left out an expired record above its cursor, so it may hold an older copy of that.

The device then keeps its outbox, pulls everything from 0 without sending, and drops what didn't come back, outbox rows
and all, unless every field of it is still to send, which means it made it since it last synced. Then it sends the rest
of its outbox. It doesn't empty itself first, so its screens never show an empty app, and it stores its cursor only at
the end, so a failure part way starts the reset over. A device at cursor 0 holds nothing from the server, so a reset
during its first pull carries on from where it is.

The API also drops a change that would bring an expired record back:

- any change whose record, once merged, has an expiry that has passed;
- from an app from before, which can't take a reset, a change to a record the server doesn't hold whose every clock is
  older than the deleted period;
- an expiry alone for a record the server doesn't hold.

An app filling in expiries for records it held from before sends each as an expiry alone with the lowest clock. The API
writes those in place, keeping the record's sequence number, since every device fills in the same value and none needs
to pull the record again. Each is a write of its own, so it makes four at a time: one at a time, a device filling in
thousands at its first launch would sync for minutes. This is also how records deleted before retention, whose expiry
has already passed, reach TTL.

## Exporting and deleting an account

Settings > Account has **Export my data** and **Delete my account and data**. Both run in the account function
(`backend/cmd/account`, [internal/account](../backend/internal/account)), since a five-year history with its photos
outlasts an API request.

### Export

The server builds the export, rather than the app, because it holds the whole account: every record of every type,
including any this device hasn't pulled yet, and every file, which a device would have to download first under its
hourly download limit. A device would also have to hold a zip of up to the storage quota in memory, and the iPhone hand
it to the share sheet through the web view's bridge, which can't carry that much. A link works the same on every
platform: the browser downloads it, the Mac app hands it to the default browser, and the iPhone app to Safari, which
saves it to Files.

- `POST /account/export` writes `meta#export` in the person's partition, on condition that none is building, and starts
  the job with the export's id. One already building is the one they get, so there's only ever one at a time, and a job
  whose export another has replaced builds nothing.
- The job reads the partition and streams a zip into the files bucket at `exports/<hashed sub>/<random>.zip`, holding no
  more in memory than the attachments' names: records and notes go into the zip as they're read. Every key it reads from
  the person's items, a file's or the export's, must be under the person's own prefix, or it's refused. It holds:
  - `README.md`, saying what's where;
  - `records/<type>.json`, every record of every type the server holds, read generically, so a new type such as notes
    comes along without a change here. Each record is its id and its fields' values, without sync's clocks. Deleted
    records within their 30 days are included with `deleted_at`, and expired ones that TTL hasn't reached yet aren't;
  - `notes/<title>.md`, each note again as Markdown, its title as the heading, then its body, with relative links to its
    photos and files in `notes/<title>/` beside it;
  - `files/<attachment id>/<name>`, every other attachment's file. One granted but never uploaded is left out.

  Every path is relative, so a later layout can nest the whole under a folder per space. Names are made safe on any
  computer: at most 100 bytes before a " (2)" or ".md", without Windows' device names such as CON, trailing dots, or
  characters that reverse the text's direction, and a note's file and folder never share a name with another's.
- `GET /account/export` says `building`, `failed` (also for one still building after 20 minutes) or `ready` with a
  download link through the files distribution that works for 5 minutes. The link is handed out once; asked for again,
  the answer is `none`, and the person exports again.
- The bucket's lifecycle deletes `exports/` a day after each was made, which S3 does within a day of that, so an export
  lasts up to two days.
- Settings come with the records, in `records/settings.json`. Choices kept on one device only, such as its appearance,
  never reach the server, so aren't in it.

### Deletion

Deleting is immediate once the person has been through Settings' safeguards: there's no grace period to cancel in. The
app offers an export first, says what goes and that it can't be undone, has them sign in again, and has them type
DELETE. The API takes it only with that confirmation, the sub of the account the app holds, which must be the token's,
so a sign-in again as another account deletes nothing, and an access token whose `auth_time` is within
`account.maxSignInAgeMinutes` of [config/protocol.yaml](../config/protocol.yaml), 10 minutes. A refresh keeps
`auth_time`, so only a sign-in counts. It never deletes a deployment's integration test users, named to it in
`PROTECTED_EMAILS`, whatever their suite's requests say. Asked again while a deletion is under way, it starts nothing
more.

1. `POST /account/delete` writes `account#deleting/<sub>`, which is how the schedule finds a deletion under way, then
   `meta#deleted` in the person's partition, and starts the job. From then on the person's devices are refused: `/sync`
   reads the mark with the counter it reads anyway, and the calendar, files, export and telemetry routes check it,
   answering `401 {"error": "account_deleted"}`.
2. The job ends their Google connection, revoking access at Google and removing Time blocks from their calendar as
   disconnecting does, deletes their sign-in from the user pool, which ends every refresh token, deletes everything under
   their two prefixes in the files bucket, `u/<hashed sub>/` and `exports/<hashed sub>/`, and deletes every item in their
   partition but the mark. Each step is safe to run again, so a run that fails part way is simply run again.
3. The account function's schedule runs every deletion under way again every 5 minutes, which also removes anything that
   landed meanwhile: a calendar run in flight, or a file whose upload link was granted just before. The first run that
   finds the sign-in gone records when, as `signin_deleted_at` on the entry: until then a device could still refresh a
   token. Once 70 minutes have passed since then, longer than the app's access and ID tokens last (an infrastructure
   test keeps them to an hour), and the pool still has no such sign-in, no device can reach the API as the person, and
   the run removes the mark and the entry. A run after that doesn't mark the account again. Nothing of the person stays
   in DynamoDB, the bucket or the user pool.

A job does nothing for a sub without the entry the person's own request wrote, and every step works in the partition,
prefixes and sign-in named by that sub, which the gateway verified. Telemetry gets counts, never who:
`AccountDeletionsStarted`, `AccountsDeleted` and `AccountDeletionFailures`, and `AccountExports` and
`AccountExportFailures`. The account routes' request lines and the job's lines carry no user hash. The request lines of
the person's earlier requests keep the hash of their sub, never anything they wrote, for the log groups' 30 days, and
the table's stream holds its changes, deletions included, for 24 hours.

A deletion that fails three runs in a row raises the `AccountDeletionFailing` alarm, and keeps trying. The account
function crashing or timing out raises `AccountFunctionErrors`. Neither is a release alarm. It runs with 1 GB, at most
10 at once, and without Lambda's retries: the app asks for an export again, and the schedule carries a deletion on.

### Devices

- A device that still holds a good token gets `401 {"error": "account_deleted"}` from its next sync.
- A device whose token has lapsed gets its refresh refused, since the sign-in is gone. It can then ask
  `POST /account/status` with the lapsed token, which the gateway can't check, so the API checks its signature itself
  against the user pool's keys, and its issuer, client and use, but not its expiry. The account is gone if its mark is
  there or the pool has no sign-in with that sub. Asked about the token's own sub only, it tells a stranger nothing.
- An app from before this gets the same `401` from sync, and its refresh is refused, so it shows the signed-out state.

### Backups

Point-in-time recovery keeps the table's backups for 35 days, so a deleted account stays in them until then, and the
privacy policy and the deletion screen say so. Nothing restores one person's data from them: a restore goes into a new
table (docs/setup.md), and bringing a deleted account back from one would need its sign-in, which is gone. The bucket
isn't versioned, so a deleted file is gone at once, and the user pool keeps no copies.

## Compatibility

- Apps from before ignore `expires_at`, since unknown fields are kept, and get the API's checks for stale changes
  instead of resets. An older app offline for longer than a period can keep an older copy of something that expired
  meanwhile, since it can't be reset. What they reopen or restore loses its expiry rather than keeping one that no longer
  fits, until an up-to-date app works it out again.
- The device database needs no migration: `expires_at` lives in each record's JSON, and nothing in the views changes, so
  a bundle rolled back to an older one opens the database as before.
- The request's `expiry_reset` and the response's `reset` are new fields that older servers and apps ignore.

## Known limits

- TTL removes an item and the Streams consumer raises the mark a moment later. A device whose first sync since the
  record's last write falls in that moment, after the record has expired, could keep an older copy of it.
- A device restoring a deleted record offline after it has been removed from the server sends the restore back as a
  record with only the fields it changed.
- A milestone, or a block's answer, keeps the expiry it took from its project or block when an app from before reopens
  that project or moves that block.
- A record deleted before retention that no device still holds never gets a TTL, so it stays in the table, left out of
  every pull.
- Restoring the table from point-in-time recovery can bring back attachment records whose files are already gone. The
  app shows those as no longer available.
- Staging's cleanup removes an attachment's file just before its record, conditional on the record not having changed
  since its scan. A record written again in that moment stays, without its file.
- A project's or a goal's close counts from its state's clock, which a device that has pulled a clock from the future
  sets that far ahead, up to the day ahead the server takes. Its expiry is then that much later.

## Tests

| Layer | What |
| --- | --- |
| Unit | `expiryFor` for every type and state, list trimming, the write path, filling in, device expiry and resets (`frontend/src/core/retention.test.ts`, `expiry.test.ts`, `sync.test.ts`); the store, TTL, the guard, drops, fills, expiries cleared by older writers and cleanup (`backend/internal/sync/expiry_test.go`); the Streams consumer (`backend/cmd/retention`); a removed attachment's file, its `file#` item and its bytes (`backend/internal/files`); the config readers |
| Local integration | `backend/cmd/local` removes an attachment's file with its record through the cleanup; `backend/integration/retention_test.go` moves the local clock past each period, and `frontend/src/core/retention.stack.test.ts` does the same with the app's own client, in `make test-integration` |
| Staging | `make test-retention`, also part of `make test-deployed` on staging: the same app-client suite in real time, about 50 minutes |
| End to end | `frontend/e2e/settings.spec.ts` opens the Data retention page at desktop and phone sizes |
| Export and deletion | `backend/internal/account`: every record type and note in the export, one export at a time, its link once, keys outside the person's prefix refused, a failed or stalled export, names safe on any computer; a deletion's completeness, other people untouched, an interrupted deletion carried on, late writes removed, the mark kept until tokens from the sign-in's last moment lapse, a job for someone who didn't ask doing nothing, protected accounts, counts without who, and lapsed tokens' signatures. `backend/internal/api`: the sign-in age, the typed confirmation and account, the refusals of a deleted account and of anyone without a token. `backend/integration/account_test.go`, in `make test-integration`: the same through the local stack, with a second user and a second device |
