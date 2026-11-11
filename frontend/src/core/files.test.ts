import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from './clock';
import type { Db } from './db';
import { createFiles, OpenError } from './files';
import type { FilesApi } from './files';
import { getRecord, transact } from './records';
import { openTestDb } from '../platform/node-sqlite';

const NOW = '2026-11-02T15:00:00Z';
const clock = fixedClock(NOW);
let db: Db;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (id: string) => json(200, { url: `https://bucket.example/u/abc/${id}`, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '3' }, expires_at: NOW });

function setup(api: Partial<FilesApi> = {}) {
  const kept = new Map<string, Blob>();
  const calls: string[] = [];
  const full: FilesApi = {
    usage: async () => json(200, { used_bytes: 240, quota_bytes: 1000 }),
    grantUpload: async (id) => (calls.push(`grant ${id}`), grant(id)),
    grantDownloads: async (ids) => json(200, { files: ids.map((id) => ({ id, url: `https://files.example/${id}`, expires_at: NOW })), missing: [] }),
    put: async (url, _headers, body, progress) => (calls.push(`put ${url}`), progress(body.size), 200),
    get: async () => new Blob(['abc']),
    ...api,
  };
  const files = createFiles({ db, clock, store: { get: async (id) => kept.get(id) ?? null, put: async (id, f) => void kept.set(id, f) }, api: full });
  return { files, kept, calls };
}

/** A photo added on this device, its bytes kept here, and its record synced unless said otherwise. */
async function photo(kept: Map<string, Blob>, options: { synced?: boolean; bytes?: boolean } = {}) {
  const id = await transact(db, clock, async (w) => {
    const task = await w.create('task', { kind: 'inbox', title: 'Fix the gate' });
    return w.create('attachment', { task_id: task, kind: 'photo', name: 'Gate.jpg', size: 3, type: 'image/jpeg', sha256: 'x' });
  });
  if (options.bytes !== false) kept.set(id, new Blob(['abc']));
  if (options.synced !== false) await db.run('DELETE FROM outbox');
  return id;
}

beforeEach(async () => {
  db = await openTestDb();
  clock.set(NOW);
});

describe('uploads', () => {
  it('puts a synced photo to the link the API grants, then marks it uploaded', async () => {
    const { files, kept, calls } = setup();
    const id = await photo(kept);
    const seen: unknown[] = [];
    files.subscribe(() => seen.push(files.state(id)));
    await files.run();
    expect(calls).toEqual([`grant ${id}`, `put https://bucket.example/u/abc/${id}`]);
    expect(seen).toContainEqual({ kind: 'uploading', sent: 3 });
    expect((await getRecord(db, 'attachment', id))?.uploaded_at).toBe(NOW);
    expect(files.state(id)).toBeNull();
    // Done once: the next run asks for nothing.
    await files.run();
    expect(calls).toHaveLength(2);
  });

  it("waits for its record's sync, and leaves another device's photo to that device", async () => {
    const { files, kept, calls } = setup();
    await photo(kept, { synced: false });
    await files.run();
    await db.run('DELETE FROM outbox');
    await photo(kept, { bytes: false });
    expect(calls).toEqual([]);
  });

  it('holds a photo the server found no room for until Retry', async () => {
    let room = false;
    const { files, kept, calls } = setup({
      grantUpload: async (id) => (calls.push(`grant ${id}`), room ? grant(id) : json(403, { error: 'quota_exceeded', used_bytes: 1000, quota_bytes: 1000 })),
    });
    const id = await photo(kept);
    await files.run();
    expect(files.state(id)).toEqual({ kind: 'full' });
    await files.run();
    expect(calls).toHaveLength(1);
    room = true;
    await files.retry(id);
    expect((await getRecord(db, 'attachment', id))?.uploaded_at).toBe(NOW);
  });

  it('waits out the hourly limit, then goes by itself', async () => {
    let limited = true;
    const { files, kept, calls } = setup({
      grantUpload: async (id) => (calls.push(`grant ${id}`), limited ? json(429, { error: 'upload_rate', retry_at: '2026-11-02T16:00:00Z' }) : grant(id)),
    });
    const first = await photo(kept);
    const second = await photo(kept);
    await files.run();
    // The rest wait for the same hour, without asking.
    expect(calls).toEqual([`grant ${first}`]);
    expect(files.state(first)).toEqual({ kind: 'limit', from: '2026-11-02T16:00:00Z' });
    await files.run();
    expect(calls).toHaveLength(1);
    limited = false;
    clock.set('2026-11-02T16:00:01Z');
    await files.run();
    for (const id of [first, second]) expect((await getRecord(db, 'attachment', id))?.uploaded_at).toBe('2026-11-02T16:00:01Z');
  });

  it('keeps waiting, offline or when a link has expired, and asks again next time', async () => {
    let offline = true;
    const put = vi.fn(async () => 403);
    const { files, kept } = setup({
      grantUpload: async (id) => {
        if (offline) throw new TypeError('Failed to fetch');
        return grant(id);
      },
      put,
    });
    const id = await photo(kept);
    await files.run();
    expect(files.state(id)).toEqual({ kind: 'waiting' });
    offline = false;
    await files.run();
    expect(put).toHaveBeenCalledTimes(1);
    expect(files.state(id)).toEqual({ kind: 'waiting' });
    put.mockResolvedValue(200);
    await files.run();
    expect((await getRecord(db, 'attachment', id))?.uploaded_at).toBe(NOW);
  });

  it('gives up on a file the API refuses for good', async () => {
    const { files, kept, calls } = setup({ grantUpload: async (id) => (calls.push(id), json(413, { error: 'file_too_large' })) });
    const id = await photo(kept);
    await files.run();
    await files.run();
    expect(files.state(id)).toEqual({ kind: 'refused' });
    expect(calls).toHaveLength(1);
  });
});

describe('opening a file', () => {
  it('uses the copy on this device, or downloads one and keeps it', async () => {
    const get = vi.fn(async () => new Blob(['downloaded']));
    const { files, kept } = setup({ get });
    kept.set('here', new Blob(['kept']));
    expect(await (await files.open('here')).text()).toBe('kept');
    expect(await (await files.open('there')).text()).toBe('downloaded');
    expect(await (await files.open('there')).text()).toBe('downloaded');
    expect(get).toHaveBeenCalledTimes(1);
    expect(kept.has('there')).toBe(true);
  });

  it('says why it cannot: the hourly limit, a file that has gone, or no connection', async () => {
    const limited = setup({ grantDownloads: async () => json(429, { error: 'download_rate', retry_at: '2026-11-02T16:00:00Z' }) });
    await expect(limited.files.open('a')).rejects.toEqual(new OpenError('limit', '2026-11-02T16:00:00Z'));
    const gone = setup({ grantDownloads: async (ids) => json(200, { files: [], missing: ids }) });
    await expect(gone.files.open('a')).rejects.toMatchObject({ reason: 'gone' });
    const offline = setup({ grantDownloads: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(offline.files.open('a')).rejects.toMatchObject({ reason: 'offline' });
  });
});

describe('usage', () => {
  it("reads the server's numbers, or null where the server has no attachments", async () => {
    expect(await setup().files.usage()).toEqual({ used: 240, quota: 1000 });
    expect(await setup({ usage: async () => json(404, { error: 'not_found' }) }).files.usage()).toBeNull();
  });
});
