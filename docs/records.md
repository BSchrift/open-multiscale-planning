# Records and sync

How the app stores what you plan, and how two devices' copies merge. The code is the reference: the types in
`frontend/src/core/types.ts`, the schema in `db.ts`, writes in `records.ts` and the server's merge in
`backend/internal/sync`.

## Records

Everything is a typed JSON record in one SQLite table, `records`, keyed by `id`, with a clock beside each field. Every
local write updates the record, its clocks and the outbox in one transaction, so nothing is saved without being queued
to sync. A delete sets `deleted_at` and keeps the row. Each type has a read-only view with one column per field, rebuilt
when a database is opened if it differs from the running code's.

| Type | What it is |
| --- | --- |
| `objective` | A long-term goal. |
| `project` | Under a goal, with a start and an end. Its `slip_log` array is the replanning log as bundles before `slip_entry` read it. |
| `slip_entry` | One entry of a project's replanning log, with the values its Undo restores. |
| `milestone` | A dated checkpoint in a project. |
| `task` | Inbox, one off or project work. A repeating one off stays one record. |
| `task_completion` | One finish of a one off. |
| `time_block` | Scheduled time for a task or a practice. |
| `block_outcome` | The answer to a block's end prompt. |
| `week_plan`, `week_pick` | A planned week, and a task added to it. |
| `away_period` | Dates that mute reminders and pause pace. |
| `settings` | One record of preferences. |
| `calendar`, `calendar_source` | Google Calendar's events, written by the backend, and each calendar's mode. |
| `practice` | Ongoing time on something, never completed. |

## Merging

Each field merges on its own: the write with the higher clock wins, on the server and on each device. Edits to
different fields of one record from two offline devices both survive. Two edits to the same field keep only the later
one, so a field holding a list loses the other device's additions. Anything that accumulates is therefore a record of its
own, with an id two devices can't both generate for different things:

- `task_completion`: a new id, or `occ-done:<task>:<date>` for a repeating task, so two devices finishing the same
  occurrence merge into one.
- `week_pick`: `pick:<week>:<task>`. `week_plan`: `week:<week>`. `block_outcome`: `outcome:<block>`. A practice's
  session block: `session:<practice>:<date>`.
- `slip_entry`: `slip:<project>:<new id>`.

The server takes any well-formed record type, so an app with a new type can ship before the server knows it. Unknown
types and fields are kept, so an older app never erases what a newer one wrote.

## The replanning log

Every replanning action (moving, adding to or taking out of a plan, dropping or meeting a milestone, moving Done,
pausing, resuming, finishing or dropping a project) logs an entry with the slip days it adds and what Undo restores.
Restore reopens what a finish or drop cancelled from that entry, and resuming moves dates by the days since the last
pause.

The log was first only the project's `slip_log` array. Two devices replanning the same project offline then kept only
the later device's array, losing the other's entries, and the array only grew, toward the 100 KB a record can hold. Each
entry is now a `slip_entry` record with a `project_id`.

**The transition rule.** Installed apps can go back to the bundle built into them, which reads only the array. Until
every installed shell's built-in bundle reads `slip_entry` records:

- A new entry is written as a record and also appended to the array, with its record's `id`.
- Undo deletes the entry's record and writes the array without it. An entry from before records gets a record, with
  an id derived from its contents, to hold the delete.
- The log is read as the array and the records together (`listProjects` and `getProject` in `slipLog.ts`): an entry in
  both shows once, one only a record holds is placed by when it was logged, and a deleted record hides its entry even
  where an older bundle's array still has it. A project with no records reads exactly as its array.

Once no installed app can go back to a bundle that reads only the array, stop writing it (the `shortcut:` in
`slipLog.ts` marks where). The array then holds only entries from before, and reading goes on merging them in.

While the array is written, an older bundle that undoes an entry a newer one logged takes it off the array only, so
newer bundles still show it.

## Changing the model

- A new field needs no migration: unknown JSON fields are kept, and the views are rebuilt from the code's field list.
- A new type is added to `RECORD_TYPES` and `RECORD_FIELDS`, which gives it a view. Bundles that don't know it keep it
  and sync it untouched.
- A retired field keeps its view column while a bundle that selects it can still run (`RETIRED_COLUMNS` in `db.ts`).
- A migration must leave a database the bundle before can still use, or be marked breaking.
