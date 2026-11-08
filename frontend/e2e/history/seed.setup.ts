// Seeds the five-year history into the history user's account through the sync API, before the specs that time it.
// Idempotent: a rerun on staging writes nothing, and only waits for the requests.

import { test as setup } from '@playwright/test';
import { historyFacts, seedHistory } from '../../src/core/history-testing';
import { historySend, historyTarget, record } from './history';

setup('seed the five-year history', async () => {
  setup.setTimeout(40 * 60_000);
  const t = historyTarget();
  // DynamoDB Local has no partition limit to pace for. HISTORY_WRITE_UNITS sets the pace anywhere.
  const unitsPerSecond = Number(process.env.HISTORY_WRITE_UNITS) || (t.env === 'local' ? Infinity : 500);
  const started = Date.now();
  const { batches, written } = await seedHistory(await historySend(t), {
    unitsPerSecond,
    progress: (done, total, wrote) => {
      if (done % 50 === 0 || done === total) console.log(`seed: ${done} of ${total} batches sent, ${wrote} records written`);
    },
  });
  const facts = historyFacts();
  console.log(`seed: ${facts.records} records (${facts.deleted} deleted, ${facts.meanBytes} bytes on average) in ${batches} batches; ${written} written in ${Math.round((Date.now() - started) / 1000)} s`);
  record('facts', { records: facts.records, deleted: facts.deleted, open_inbox: facts.openInbox, mean_bytes: facts.meanBytes });
});
