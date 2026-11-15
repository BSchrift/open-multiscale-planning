// Before the web app suite's history project: the five-year account on staging's history user, seeded as the history-scale test seeds
// it. Only records staging keeps go: the live ones, which carry no expiry and so stay, and none of the deleted ones,
// whose deleted period of minutes has long passed. A rerun writes nothing, and takes the time of its requests.

import { readFileSync } from 'node:fs';
import { test as setup } from '@playwright/test';
import { parse } from 'yaml';
import { loadRetention } from '../../../config/retention';
import { historyFacts, keptHistory, seedHistory } from '../../src/core/history-testing';
import { historySend } from '../history/history';
import { deployed } from './target';

setup("the history user's five-year account is seeded", async () => {
  setup.setTimeout(40 * 60_000);
  const t = deployed().history!;
  const { deleted } = loadRetention(t.env, { read: (path) => readFileSync(path, 'utf8'), parse });
  const changes = keptHistory(deleted, Date.now() + 3_600_000);
  const started = Date.now();
  // Paced to what one user's partition takes, as the history-scale test's seed is off local.
  const { batches, written } = await seedHistory(await historySend(t), { changes, unitsPerSecond: 500 });
  const { records } = historyFacts(changes);
  console.log(`history seed: ${records} records in ${batches} batches, ${written} written, in ${Math.round((Date.now() - started) / 1000)} s`);
});
