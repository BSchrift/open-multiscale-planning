import { describe, expect, it, vi } from 'vitest';
import { deleteAccount, ExportError, exportData } from './account';
import type { AccountRequest } from './account';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** A server that answers the export's start, then each look at it in turn. */
function server(start: Response, looks: Response[]) {
  const asked: string[] = [];
  const request = vi.fn<AccountRequest>(async (method, path) => {
    asked.push(`${method} ${path}`);
    return method === 'POST' ? start : (looks.shift() ?? json(200, { state: 'building' }));
  });
  return { request, asked, wait: vi.fn(async () => undefined), isFilesLink: (url: string) => url.startsWith('https://files.example.test/') };
}

describe('exportData', () => {
  it('starts an export and waits until its link is ready', async () => {
    const s = server(json(202, { state: 'building' }), [json(200, { state: 'building' }), json(200, { state: 'ready', url: 'https://files.example.test/x.zip' })]);
    expect(await exportData(s)).toBe('https://files.example.test/x.zip');
    expect(s.asked).toEqual(['POST /account/export', 'GET /account/export', 'GET /account/export']);
    expect(s.wait).toHaveBeenCalledTimes(2);
  });

  it('says so when the server has no exports, or one fails or goes', async () => {
    await expect(exportData(server(json(501, { error: 'export_not_configured' }), []))).rejects.toEqual(new ExportError('unavailable'));
    for (const look of [json(200, { state: 'failed' }), json(200, { state: 'none' }), json(200, { state: 'ready' })]) {
      await expect(exportData(server(json(202, {}), [look]))).rejects.toMatchObject({ reason: 'failed' });
    }
  });

  it('never opens a link to anything but the files host', async () => {
    for (const url of ['multiscale://somewhere', 'https://elsewhere.example.test/x.zip', 'http://files.example.test/x.zip']) {
      const s = server(json(202, {}), [json(200, { state: 'ready', url })]);
      await expect(exportData(s), url).rejects.toMatchObject({ reason: 'failed' });
    }
  });

  it('fails as a sync error on any other answer', async () => {
    await expect(exportData(server(json(500, {}), []))).rejects.toMatchObject({ name: 'SyncError', code: 'error' });
    await expect(exportData(server(json(202, {}), [json(500, {})]))).rejects.toMatchObject({ code: 'error' });
  });

  it('gives up after the server would have', async () => {
    const s = server(json(202, {}), []);
    await expect(exportData(s)).rejects.toMatchObject({ reason: 'failed' });
    // Two seconds apart, past the server's 20 minutes.
    expect(s.wait.mock.calls.length * 2).toBeGreaterThan(20 * 60);
  });
});

describe('deleteAccount', () => {
  it('sends the typed confirmation and the account it means', async () => {
    const request = vi.fn<AccountRequest>(async () => json(202, { state: 'deleting' }));
    expect(await deleteAccount(request, 'user-a')).toBe('deleting');
    expect(request).toHaveBeenCalledWith('POST', '/account/delete', { confirm: 'DELETE', sub: 'user-a' });
  });

  it("deletes nothing when the server finds the sign-in is another account's", async () => {
    expect(await deleteAccount(async () => json(409, { error: 'wrong_account' }), 'user-a')).toBe('wrong_account');
  });

  it('asks for a sign-in again when the last one is too old, and fails on anything else', async () => {
    expect(await deleteAccount(async () => json(403, { error: 'sign_in_again' }), 'user-a')).toBe('sign_in_again');
    await expect(deleteAccount(async () => json(400, { error: 'invalid_request' }), 'user-a')).rejects.toMatchObject({ code: 'error' });
    await expect(deleteAccount(async () => json(403, {}), 'user-a')).rejects.toMatchObject({ code: 'error' });
  });
});
