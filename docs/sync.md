# Sync

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
