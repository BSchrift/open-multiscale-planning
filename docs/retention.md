# Data retention

Multiscale keeps history for a set time, then removes it from every device and from the server. This page says what
each period covers and what it counts from, and how the app, the API and DynamoDB share the work. **Settings > Data
retention** tells people the same in plain words, from the periods the app was built with.

## What's kept, and for how long

| What | Counted from | Prod | Staging |
| --- | --- | --- | --- |
| Time blocks (`time_block`) and their answers (`block_outcome`) | The block's end | 2 years | 10 minutes |
| Week picks and week plans | The end of that week | 2 years | 10 minutes |
| Finishes of repeating tasks (`task_completion`) | `done_at` | 2 years | 10 minutes |
| Away dates | Their end | 2 years | 10 minutes |
| Stretches pinned in `settings.plan_stretch.one_offs` | The stretch's end | 2 years | 10 minutes |
| Entries in a project's `slip_log` | The entry's `at` | 2 years | 10 minutes |
| Done, cancelled and dropped tasks, one offs included | `done_at` or `cancelled_at`, whichever is later | 5 years | 20 minutes |
| Finished and dropped projects, with their milestones | When the project's state was set | 5 years | 20 minutes |
| Archived goals | When the goal's state was set | 5 years | 20 minutes |
| Anything deleted | `deleted_at` | 30 days | 5 minutes |

A deletion beats everything else: a deleted record goes 30 days after `deleted_at`, whatever else it holds.

Never removed: open tasks and Inbox items, active and paused projects and their milestones, goals that aren't archived,
practices, settings, and the calendar records. A time block, pick or finish that expires never takes its task with it.

Dates count from the end of the day in UTC, so every device works out the same expiry wherever it is. A project's and a
goal's close time is when their `state` was last written, from that field's clock, since neither has a closed date of
its own.

The two lists, pinned stretches and a project's slip log, lose old entries rather than expiring: each write to the record
drops the entries older than the scheduling period.

## The configuration

[config/retention.yaml](../config/retention.yaml) holds a block per environment: `prod`, `staging` and `local`, each
with ISO 8601 periods for `scheduling`, `closed` and `deleted`. Staging's block also has `cleanup`, how often its cleanup
job runs. It has two readers, which check the same rules and fail on any bad value in any block:

- [config/retention.ts](../config/retention.ts), for the app's build, which puts its environment's block into the app
  the way it does the API's address, and for the CDK stack, which sets up staging's cleanup from it.
- [config/retention.go](../config/retention.go), which builds the file into every Lambda with `go:embed`. Each picks
  its block by `ENV_NAME`.

`local` matches prod. Tests move a clock instead of waiting.

Staging's periods are minutes so that `make test-retention` can watch every stage in one sitting, about 25 minutes.
Deleted is 5 minutes, longer than the 5 minutes between an open app's syncs, so an open device sees a delete before it
goes; each later period ends a few cleanup runs after the one before. The cost is that a device closed for more than a
few minutes across a change that then expires is reset when it next syncs, which on staging is often.

## How it fits together

### On the device

- **Every write works out the record's expiry.** The write path in `frontend/src/core/records.ts` calls `expiryFor`
  ([retention.ts](../frontend/src/core/retention.ts)) on the record as it stands after the write, and stores the result
  as its `expires_at` field, so every writer is covered. It clears `expires_at` when what it counts from clears, as when
  a task opens again or a project is restored. A project's write passes its expiry on to its milestones, and a block's
  to its answer. Lists are trimmed in the same write.
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
  and a pull that reaches the end moves the cursor to the counter, past any record already removed.
- **The Streams consumer keeps the expiry mark.** `cmd/retention` reads TTL's removals from the table's stream, which
  carries the old image for this, and stores the highest removed sequence number as that user's mark (`meta#expired`).
  Its event source passes only TTL's removals, `userIdentity` `Service` from `dynamodb.amazonaws.com`.
- **Staging's cleanup** runs every minute in the same Lambda, because staging can't wait days for TTL. It raises the mark
  for what has expired first, and removes it on a run at least 30 seconds later, by which time every sync that could
  miss it has read the mark. Prod relies on TTL alone, and the local stack runs the cleanup when a test asks.

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
to pull the record again. This is also how records deleted before retention, whose expiry has already passed, reach TTL.

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

## Tests

| Layer | What |
| --- | --- |
| Unit | `expiryFor` for every type and state, list trimming, the write path, filling in, device expiry and resets (`frontend/src/core/retention.test.ts`, `expiry.test.ts`, `sync.test.ts`); the store, TTL, the guard, drops, fills, expiries cleared by older writers and cleanup (`backend/internal/sync/expiry_test.go`); the Streams consumer (`backend/cmd/retention`); the config readers |
| Local integration | `backend/integration/retention_test.go` moves the local clock past each period, and `frontend/src/core/retention.stack.test.ts` does the same with the app's own client, in `make test-integration` |
| Staging | `make test-retention`, also part of `make test-deployed` on staging: the same app-client suite in real time, about 25 minutes |
| End to end | `frontend/e2e/settings.spec.ts` opens the Data retention page at desktop and phone sizes |
