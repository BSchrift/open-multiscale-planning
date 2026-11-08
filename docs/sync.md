# Sync

Sync merges each field of a record on its own, and the last write wins. That suits a field one edit replaces, such as a
date or a state. It doesn't suit a list two devices each add to, since the later device's list replaces the other's.

## The replanning log

A project's replanning log, `slip_log`, is one such list: one field holding every entry. When two devices replan a
project while one is offline, the later device's log wins and the other's entries are lost. So the log is history
only. It gives the lines a project shows, its slip figures, and the Undo for the latest change, and a rare lost entry
costs one of those.

What a feature has to read back is kept on the records the change touched, where last writer wins is right:

- **`cancelled_by`** on a task names the project whose finish or drop cancelled it. Restore reopens the tasks marked
  with its project that are still cancelled, and clears the mark with `cancelled_at`. A milestone still counts them,
  since they were never done. A task the person cancelled is never marked.
- **`paused_on`** on a project is the day it was paused. Resume moves open dates by the days since, and clears it.

Closing and pausing still log their entries, for history and for older apps, which read only the log. The app reads
the log too, for what was closed or paused before these fields existed: Restore also undoes a close entry that is
still the newest, and the milestone count includes the tasks a close entry lists. Resume goes by the last pause entry
when it's later than `paused_on`, as it is after an older app resumed and paused again. A close entry's Undo clears
the marks as well, so an older app's Restore leaves none behind.

## The 10 GB cap per user

Each user's records share one partition of the table, and pull reads them in order through `by_seq`, a local secondary index. On a table with a local index, DynamoDB caps each partition's item collection at 10 GB: the items themselves plus their copies in the index. `by_seq` copies every attribute, so a record counts about twice. Sync never removes a row, deletes included, so a user's collection only grows.

At the cap, DynamoDB refuses every write that would grow that user's collection. Their syncs fail with a 500, and the API's log line shows `ItemCollectionSizeLimitExceeded` among its `cancellation_reasons`. The calendar worker's writes for them fail too. Nothing stored is lost, and devices keep unsent changes in their outbox to send again, but a device with changes to send gets nothing back either until there is room.

### What's measured

Every sync transaction asks DynamoDB for the size of the collection it wrote to (`ReturnItemCollectionMetrics: SIZE`). DynamoDB answers with an estimated range in GB, and the API takes its upper end, the largest across the request's transactions. A sync that wrote logs it as `ItemCollectionSizeGB` on its request line, an Embedded Metric Format metric in `Multiscale/<env>`, in gigabytes and with no dimensions. A sync that wrote nothing logs no size, and the calendar worker's writes are measured at the user's next sync that writes.

The metric's Maximum over a period is the largest writing user's size. The dashboard's **Largest user (GB of the 10 GB cap)** panel shows it.

DynamoDB Local never reports these sizes, so locally the metric never appears. The store's and the API's unit tests cover it with a fake, and `make smoke` checks that a deployment publishes it.

### The alarm

`ItemCollectionSize` emails the alarm topic when the Maximum reaches 5 GB, half the cap. Missing data leaves it as it was, so it stays in alarm, and doesn't email again, until a write reports less than 5 GB.

When it fires:

1. Find the user. In Logs Insights, on the API's log group:

   ```
   filter ItemCollectionSizeGB >= 5 | stats max(ItemCollectionSizeGB) as gb by user | sort gb desc
   ```

   `user` is the first 16 hex characters of the SHA-256 of the user's Cognito sub. To check a sub: `printf %s "$sub" | shasum -a 256 | cut -c1-16`.

2. See how fast it grows, with that user's hash:

   ```
   filter user = "<hash>" and ispresent(ItemCollectionSizeGB) | stats max(ItemCollectionSizeGB) as gb by bin(1d)
   ```

3. Make room before it reaches 10 GB. Nothing removes rows yet, so this takes a change: removing that user's rows that no device still needs, or moving the table off a local index, which DynamoDB can only set when it creates a table.
