// Export my data and Delete my account and data, through the API (docs/retention.md). The server builds an export of
// everything the account has and hands its link out once it's ready; this asks for one and waits for it.
//
//   const url = await exportData({ request, wait });   // throws ExportError or SyncError
//   const answer = await deleteAccount(request);        // 'deleting' or 'sign_in_again'; throws SyncError

import { SyncError } from './sync';

/** How often to ask whether an export is ready, and for how long: past the server's 20 minutes before it gives up. */
const POLL_MS = 2000;
const MAX_POLLS = 660;

/** Why an export didn't come. */
export class ExportError extends Error {
  constructor(readonly reason: 'unavailable' | 'failed') {
    super(reason);
    this.name = 'ExportError';
  }
}

export type AccountRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Response>;

const answer = async (res: Response) => (await res.json().catch(() => null)) as Record<string, unknown> | null;

/** The link to the account's export, once the server has built it. It works for a few minutes, and only once. */
export async function exportData(deps: { request: AccountRequest; wait(ms: number): Promise<void> }): Promise<string> {
  const start = await deps.request('POST', '/account/export');
  if (start.status === 501) throw new ExportError('unavailable');
  if (!start.ok) throw new SyncError('error');
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await deps.wait(POLL_MS);
    const res = await deps.request('GET', '/account/export');
    if (!res.ok) throw new SyncError('error');
    const body = await answer(res);
    // Only a web page: a link to another app's scheme from a bad response must not be opened.
    if (body?.state === 'ready' && typeof body.url === 'string' && /^https?:\/\//.test(body.url)) return body.url;
    if (body?.state !== 'building') throw new ExportError('failed');
  }
  throw new ExportError('failed');
}

/**
 * Asks the server to delete the account, once the person has typed DELETE. 'sign_in_again' when their sign-in is older
 * than the server takes for this.
 */
export async function deleteAccount(request: AccountRequest): Promise<'deleting' | 'sign_in_again'> {
  const res = await request('POST', '/account/delete', { confirm: 'DELETE' });
  if (res.status === 403 && (await answer(res))?.error === 'sign_in_again') return 'sign_in_again';
  if (res.status !== 202) throw new SyncError('error');
  return 'deleting';
}
