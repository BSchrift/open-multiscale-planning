import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META, setMeta } from '../../../core/db';
import { OpenError } from '../../../core/files';
import type { Files, UploadState, Usage } from '../../../core/files';
import { listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { noFiles } from '../../../core/sync-testing';
import type { AppSync } from '../../../core/syncRunner';
import type { Layout } from '../../app/registry';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';

vi.mock('./photo', () => ({
  shrinkPhoto: async (file: Blob) => new Blob([await file.arrayBuffer()], { type: 'image/jpeg' }),
  sha256Base64: async () => 'c2hhMjU2',
  photoName: (file: File) => file.name.replace(/\.[^.]*$/, '.jpg'),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MB = 1024 * 1024;

/** A server with attachments, through a stub sync whose files say what each test needs. */
function server(options: { usage?: Usage | null; states?: Record<string, UploadState>; open?: Files['open'] } = {}) {
  const listeners = new Set<() => void>();
  const states = new Map(Object.entries(options.states ?? {}));
  const files: Files = {
    ...noFiles(),
    usage: async () => (options.usage === undefined ? { used: 240 * MB, quota: 1024 * MB } : options.usage),
    state: (id) => states.get(id) ?? null,
    subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
    retry: vi.fn(async (id: string) => {
      states.delete(id);
      listeners.forEach((l) => l());
    }),
    ...(options.open ? { open: options.open } : {}),
  };
  const sync = { files } as unknown as AppSync;
  return { sync, files, setState: (id: string, s: UploadState) => (states.set(id, s), listeners.forEach((l) => l())) };
}

async function seed(w: Writer) {
  await w.create('task', { kind: 'inbox', title: 'Fix the gate' }, 't1');
}

/** The task's popup, signed in unless said otherwise. */
async function open(options: HarnessOptions & { signedIn?: boolean; layout?: Layout } = {}) {
  const t = await renderScreen('task', {
    ...options,
    presentation: 'overlay',
    params: { task: 't1' },
    seed: async (w) => {
      await seed(w);
      await options.seed?.(w);
      if (options.signedIn !== false) await setMeta(w.sql, META.lastSyncAt, '2026-11-02T19:00:00Z');
    },
  });
  const popup = await screen.findByRole('dialog', { name: 'Fix the gate' });
  return { t, popup, section: within(popup).getByRole('region', { name: 'Attachments' }) };
}

const photoFile = (name = 'Whiteboard.png', size = 3) => new File([new Uint8Array(size)], name, { type: 'image/png' });

describe('attachments in the popup', () => {
  it('adds a link, opens it outside the app, and removes it with Undo', async () => {
    const { t, section } = await open({ signedIn: false });
    await userEvent.click(within(section).getByRole('button', { name: '+ Add a link' }));
    // Not signed in, so there's nowhere to keep a photo. Focus moves to the choices, and back once one is made.
    expect(within(section).queryByRole('button', { name: 'Choose a photo' })).toBeNull();
    expect(within(section).getByRole('button', { name: 'Paste a link' })).toHaveFocus();
    await userEvent.click(within(section).getByRole('button', { name: 'Paste a link' }));
    const address = within(section).getByRole('textbox', { name: 'Address' });
    expect(address).toHaveFocus();
    await userEvent.type(address, 'javascript:alert(1)');
    await userEvent.click(within(section).getByRole('button', { name: 'Add link' }));
    expect(within(section).getByRole('alert')).toHaveTextContent('Enter a web address, starting https:// or http://.');
    await userEvent.clear(address);
    await userEvent.type(address, 'https://docs.example.com/q3');
    await userEvent.type(within(section).getByRole('textbox', { name: 'Name (optional)' }), 'Q3 numbers{Enter}');
    const link = await within(section).findByRole('link', { name: 'Q3 numbers' });
    expect(link).toHaveAttribute('href', 'https://docs.example.com/q3');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(section).getByText('Link · docs.example.com')).toBeInTheDocument();
    // Enter added the link, and didn't save and close the popup.
    expect(screen.getByRole('dialog', { name: 'Fix the gate' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: '+ Add a link' })).toHaveFocus();
    const [record] = await listRecords(t.db, 'attachment');
    expect(record).toMatchObject({ task_id: 't1', kind: 'link', name: 'Q3 numbers', url: 'https://docs.example.com/q3' });

    await userEvent.click(within(section).getByRole('button', { name: 'Remove Q3 numbers' }));
    expect(await screen.findByText('Removed Q3 numbers.')).toBeVisible();
    await waitFor(() => expect(within(section).queryByRole('link', { name: 'Q3 numbers' })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await within(section).findByRole('link', { name: 'Q3 numbers' })).toBeVisible();
  });

  it("shows a link that doesn't go to the web as text", async () => {
    const { section } = await open({ signedIn: false, seed: (w) => w.create('attachment', { task_id: 't1', kind: 'link', name: 'Run me', url: 'javascript:alert(1)' }) });
    expect(await within(section).findByText('Run me')).toBeVisible();
    expect(within(section).queryByRole('link')).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Open Run me' })).toBeNull();
  });

  it('names a link by its site when given no name', async () => {
    const { section } = await open({ signedIn: false });
    await userEvent.click(within(section).getByRole('button', { name: '+ Add a link' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Paste a link' }));
    await userEvent.type(within(section).getByRole('textbox', { name: 'Address' }), 'https://www.example.com/a');
    await userEvent.click(within(section).getByRole('button', { name: 'Add link' }));
    expect(await within(section).findByRole('link', { name: 'example.com' })).toBeVisible();
  });

  for (const layout of ['desktop', 'phone'] as const) {
    it(`adds a photo, kept here as a JPEG until it uploads, with the storage used (${layout})`, async () => {
      const { sync } = server();
      const { t, section } = await open({ sync, layout });
      await userEvent.click(within(section).getByRole('button', { name: '+ Add a link or photo' }));
      expect(await within(section).findByText(/240 MB of 1 GB used/)).toBeVisible();
      expect(within(section).queryByRole('button', { name: 'Take a photo' }) === null).toBe(layout === 'desktop');
      fireEvent.change(within(section).getByLabelText('Choose a photo', { selector: 'input' }), { target: { files: [photoFile()] } });
      expect(await within(section).findByRole('button', { name: 'Open Whiteboard.jpg' })).toBeVisible();
      expect(within(section).getByText('Waiting to upload')).toBeVisible();
      const [record] = await listRecords(t.db, 'attachment');
      expect(record).toMatchObject({ task_id: 't1', kind: 'photo', name: 'Whiteboard.jpg', size: 3, type: 'image/jpeg', sha256: 'c2hhMjU2' });
      expect(t.platform.files.kept.get(record!.id)?.type).toBe('image/jpeg');
    });
  }

  it('stops a photo that would pass the quota, and turns photos off when storage is full', async () => {
    const nearly = server({ usage: { used: 1024 * MB - 2, quota: 1024 * MB } });
    let view = await open({ sync: nearly.sync });
    await userEvent.click(within(view.section).getByRole('button', { name: '+ Add a link or photo' }));
    await within(view.section).findByText(/of 1 GB used/);
    fireEvent.change(within(view.section).getByLabelText('Choose a photo', { selector: 'input' }), { target: { files: [photoFile()] } });
    expect(await within(view.section).findByRole('alert')).toHaveTextContent('Storage full: 1 GB of 1 GB used. Remove attachments to make room.');
    expect(await listRecords(view.t.db, 'attachment')).toEqual([]);
    cleanup();

    const full = server({ usage: { used: 1024 * MB, quota: 1024 * MB } });
    view = await open({ sync: full.sync });
    await userEvent.click(within(view.section).getByRole('button', { name: '+ Add a link or photo' }));
    expect(await within(view.section).findByText(/Storage full: 1 GB of 1 GB used/)).toBeVisible();
    expect(within(view.section).getByRole('button', { name: 'Choose a photo' })).toBeDisabled();
    // Links take no storage.
    expect(within(view.section).getByRole('button', { name: 'Paste a link' })).toBeEnabled();
  });

  it("offers only links on a server with no attachments, and on a Mac app from before them", async () => {
    let view = await open({ sync: server({ usage: null }).sync });
    await waitFor(() => expect(within(view.section).getByRole('button', { name: '+ Add a link' })).toBeVisible());
    cleanup();
    view = await open({ sync: server().sync, filesBlocked: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(within(view.section).getByRole('button', { name: '+ Add a link' })).toBeVisible();
  });

  it('shows each upload’s state on its row: progress, the hourly limit, and storage full with Retry', async () => {
    const photo = async (w: Writer) => w.create('attachment', { task_id: 't1', kind: 'photo', name: 'Gate.jpg', size: 2048, type: 'image/jpeg', sha256: 'x' }, 'a1');
    const s = server({ states: { a1: { kind: 'uploading', sent: 1024 } } });
    const { section } = await open({ sync: s.sync, seed: photo });
    expect(await within(section).findByText('Uploading, 1 KB of 2 KB')).toBeVisible();
    expect(within(section).getByRole('progressbar', { name: 'Uploading Gate.jpg' })).toHaveAttribute('aria-valuenow', '50');
    act(() => s.setState('a1', { kind: 'limit', from: '2026-11-02T21:00:00Z' }));
    expect(within(section).getByText('Waiting to upload, from 3pm')).toBeVisible();
    act(() => s.setState('a1', { kind: 'full' }));
    expect(within(section).getByText('Not uploaded: storage full')).toHaveClass('attachalert');
    await userEvent.click(within(section).getByRole('button', { name: 'Retry uploading Gate.jpg' }));
    expect(s.files.retry).toHaveBeenCalledWith('a1');
  });

  it('opens an uploaded photo from the device, and says why it cannot', async () => {
    const photo = async (w: Writer) =>
      w.create('attachment', { task_id: 't1', kind: 'photo', name: 'Gate.jpg', size: 3, type: 'image/jpeg', sha256: 'x', uploaded_at: '2026-11-02T19:00:00Z' }, 'a1');
    let calls = 0;
    const s = server({
      open: async () => {
        calls++;
        if (calls === 1) throw new OpenError('limit', '2026-11-02T21:00:00Z');
        if (calls === 2) throw new OpenError('gone');
        return new Blob(['abc'], { type: 'image/jpeg' });
      },
    });
    URL.createObjectURL = vi.fn(() => 'blob:photo');
    URL.revokeObjectURL = vi.fn();
    const { section } = await open({ sync: s.sync, seed: photo });
    expect(await within(section).findByText('Photo · 1 KB')).toBeVisible();
    const name = within(section).getByRole('button', { name: 'Open Gate.jpg' });
    await userEvent.click(name);
    expect(await within(section).findByText('Too many downloads this hour. Try again at 3pm.')).toBeVisible();
    await userEvent.click(name);
    expect(await within(section).findByText('File no longer available')).toBeVisible();
    await userEvent.click(name);
    const viewer = await screen.findByRole('dialog', { name: 'Gate.jpg' });
    expect(within(viewer).getByRole('img', { name: 'Gate.jpg' })).toHaveAttribute('src', 'blob:photo');
  });

  it('takes no more than ten', async () => {
    const ten = async (w: Writer) => {
      for (let i = 0; i < 10; i++) await w.create('attachment', { task_id: 't1', kind: 'link', name: `Link ${i}`, url: `https://example.com/${i}` });
    };
    const { section } = await open({ seed: ten, signedIn: false });
    expect(await within(section).findByText('A task can have up to 10 attachments.')).toBeVisible();
    expect(within(section).queryByRole('button', { name: /^\+ Add/ })).toBeNull();
  });
});

describe('the Now card', () => {
  it('says how many attachments the block’s task has', async () => {
    const zone = 'America/Chicago';
    await renderScreen('today', {
      now: '2026-11-02T20:00:00Z',
      zone,
      seed: async (w) => {
        await w.create('week_plan', { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' }, 'week:2026-11-02');
        await w.create('task', { kind: 'one_off', title: 'Write the report' }, 't1');
        await w.create('time_block', { task_id: 't1', start: '2026-11-02T19:00:00Z', end: '2026-11-02T21:00:00Z', tz: zone }, 'b1');
        await w.create('attachment', { task_id: 't1', kind: 'link', name: 'Brief', url: 'https://example.com/brief' });
        await w.create('attachment', { task_id: 't1', kind: 'photo', name: 'Board.jpg', size: 3, type: 'image/jpeg', sha256: 'x' });
        // A removed one doesn't count.
        await w.create('attachment', { task_id: 't1', kind: 'link', name: 'Old', url: 'https://example.com/old', deleted_at: '2026-11-02T19:00:00Z' });
      },
    });
    const now = await screen.findByRole('region', { name: 'Current block' });
    expect(await within(now).findByText('2 attachments')).toBeVisible();
  });
});

describe("Capture's attachments", () => {
  for (const layout of ['desktop', 'phone'] as const) {
    it(`wait until the task is saved, then go in with it, a photo kept to upload (${layout})`, async () => {
      const { sync } = server();
      const t = await renderScreen('capture', {
        layout,
        sync,
        presentation: 'overlay',
        seed: (w) => setMeta(w.sql, META.lastSyncAt, '2026-11-02T19:00:00Z'),
      });
      const capture = await screen.findByRole('dialog', { name: 'Capture' });
      await userEvent.type(within(capture).getByRole('textbox', { name: /^Capture to/ }), 'Fix the gate');
      await userEvent.click(within(capture).getByRole('button', { name: 'Add details' }));
      const section = within(capture).getByRole('region', { name: 'Attachments' });
      await userEvent.click(await within(section).findByRole('button', { name: '+ Add a link or photo' }));
      fireEvent.change(within(section).getByLabelText('Choose a photo', { selector: 'input' }), { target: { files: [photoFile('Hinge.png')] } });
      expect(await within(section).findByText('Uploads when you save')).toBeVisible();
      await userEvent.click(within(section).getByRole('button', { name: '+ Add a link or photo' }));
      await userEvent.click(within(section).getByRole('button', { name: 'Paste a link' }));
      await userEvent.type(within(section).getByRole('textbox', { name: 'Address' }), 'https://example.com/hinges');
      await userEvent.click(within(section).getByRole('button', { name: 'Add link' }));
      expect(within(section).getByText('Link · example.com')).toBeVisible();
      // Nothing is written before Save.
      expect(await listRecords(t.db, 'attachment')).toEqual([]);
      await userEvent.click(within(capture).getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect(await listRecords(t.db, 'attachment')).toHaveLength(2));
      const [task] = await listRecords(t.db, 'task');
      const [photo, link] = await listRecords(t.db, 'attachment');
      expect(photo).toMatchObject({ task_id: task!.id, kind: 'photo', name: 'Hinge.jpg', type: 'image/jpeg' });
      expect(link).toMatchObject({ task_id: task!.id, kind: 'link', url: 'https://example.com/hinges' });
      expect(t.platform.files.kept.has(photo!.id)).toBe(true);
    });
  }
});
