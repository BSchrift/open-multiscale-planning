// Export my data and Delete my account and data with the app's own client against cmd/local: every record type the app
// writes comes back in the export, and a deletion is found both by a token still good and by one that has lapsed. Runs
// from scripts/integration.sh, which starts the stack and sets INTEGRATION_API_URL.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deleteAccount, exportData } from './account';
import type { AccountRequest } from './account';
import { createAuth } from './auth';
import { fixedClock } from './clock';
import { apiRequest, createHttpSend } from './sync';
import { RECORD_TYPES } from './types';
import type { RecordChange } from './types';
import { memoryTokens } from '../platform/memory';

const API = process.env.INTEGRATION_API_URL;
const REDIRECT = 'multiscale-local://auth/callback';

async function setServerClock(now: string) {
  const res = await fetch(`${API}/_local/clock`, { method: 'POST', body: JSON.stringify({ now }) });
  expect(res.status).toBe(204);
}

/** Signs in as `username` the way an app does, following the browser's redirect by hand. */
async function signIn(username: string) {
  let opened = '';
  const auth = createAuth({
    authUrl: `${API}/cognito`,
    clientId: 'local-client',
    redirectUri: REDIRECT,
    clock: fixedClock(Date.now()),
    tokens: memoryTokens(),
    openExternal: async (url) => void (opened = url),
    fetch: (url, init) => fetch(url, init),
    accountGone: async (token) => {
      const res = await fetch(`${API}/account/status`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      return res.ok && ((await res.json()) as { deleted?: unknown }).deleted === true;
    },
  });
  await auth.signIn({ again: true });
  const res = await fetch(`${opened}&username=${encodeURIComponent(username)}`, { redirect: 'manual' });
  expect(await auth.handleRedirect(res.headers.get('location') ?? '')).toBe(true);
  const deps = { apiUrl: API!, auth, fetch: (url: string, init: RequestInit) => fetch(url, init) };
  const request: AccountRequest = (method, path, body) => apiRequest(deps, method, path, body);
  return { auth, send: createHttpSend(deps), request };
}

const clockNow = () => `${String(Date.now()).padStart(13, '0')}-000000-ts-account`;

describe.skipIf(!API)('Export my data and Delete my account and data, with the app client against cmd/local', () => {
  afterAll(() => setServerClock(''));

  it('an export holds a record of every type the app writes', async () => {
    const { send, request } = await signIn(`ts-export-${crypto.randomUUID()}`);
    const changes: RecordChange[] = RECORD_TYPES.map((type) => ({ type, id: `ts-${type}-${crypto.randomUUID()}`, fields: { title: { v: `A ${type}`, c: clockNow() } } }));
    await send({ cursor: 0, changes });

    const url = await exportData({ request, wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 200))) });
    const file = join(mkdtempSync(join(tmpdir(), 'export-')), 'export.zip');
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
    for (const change of changes) {
      const records = JSON.parse(execFileSync('unzip', ['-p', file, `records/${change.type}.json`], { encoding: 'utf8' })) as { id: string; title: string }[];
      expect(records.find((r) => r.id === change.id)?.title, change.type).toBe(`A ${change.type}`);
    }
  });

  it('a deleted account is found by a token still good, and by one that has lapsed', async () => {
    const { auth, send, request } = await signIn(`ts-delete-${crypto.randomUUID()}`);
    await send({ cursor: 0, changes: [{ type: 'task', id: `ts-task-${crypto.randomUUID()}`, fields: { title: { v: 'Gone', c: clockNow() } } }] });
    expect(await deleteAccount(request)).toBe('deleting');
    await expect(send({ cursor: 0, changes: [] })).rejects.toMatchObject({ code: 'account_deleted' });
    // Two hours on, the token has lapsed. Once the job has deleted the sign-in, a moment after the request, the refresh
    // is refused, and the lapsed token asks.
    await setServerClock(new Date(Date.now() + 2 * 60 * 60_000).toISOString());
    const refreshed = () => auth.accessToken({ refresh: true }).then(() => 'refreshed', (error: { code?: string }) => error.code);
    await expect.poll(refreshed, { timeout: 10_000 }).toBe('account_deleted');
  });
});
