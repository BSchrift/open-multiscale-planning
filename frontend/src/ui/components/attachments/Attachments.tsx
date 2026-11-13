// A task's attachments in its popup: links, and photos kept in private storage. Each is a row with its state and
// Remove, with Undo in the toast. Add link and Add photo sit under them, with the storage used under those. Photos are offered only where the server stores them and this app may reach its storage: signed in, on a
// server with attachments, and not on a Mac app from before them.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { protocol } from '@multiscale/config';
import { formatBytes, linkName, storageFull, tooLarge, usageLine } from '../../../core/attachments';
import { formatTime, nowInstant } from '../../../core/dates';
import { OpenError } from '../../../core/files';
import type { UploadState, Usage } from '../../../core/files';
import { linkHref } from '../../../core/notes';
import type { RecordWrite } from '../../../core/plan';
import { taskAttachments } from '../../../core/queries';
import { isSignedIn, syncStatus } from '../../../core/sync';
import type { Attachment } from '../../../core/types';
import { useApp, useMutation, useQuery } from '../../app/store';
import { CloseIcon, LinkIcon, PhotoIcon } from '../icons';
import { Sheet } from '../Sheet';
import { useToast } from '../Toast';
import { photoName, sha256Base64, shrinkPhoto } from './photo';
import './attachments.css';

const MAX_FILE = protocol.attachments.maxFileBytes;
const MAX_PER_TASK = protocol.attachments.maxPerTask;
const MAX_LINK = 2000;

/** Whether this device can add photos, and the storage used when the server has said. */
function usePhotos(): { offered: boolean; usage: Usage | null } {
  const { platform, sync } = useApp();
  const status = useQuery(syncStatus, []).data;
  const signedIn = !!status && isSignedIn(status);
  // undefined until asked; null where the server has no attachments.
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (!signedIn || !sync) return;
    let live = true;
    sync.files.usage().then(
      (u) => live && setUsage(u),
      // Offline, it can't say: photos added now upload once back online.
      () => live && setOffline(true),
    );
    return () => void (live = false);
  }, [signedIn, sync]);
  const known = usage !== undefined || offline;
  return { offered: signedIn && !!sync && !platform.filesBlocked && known && usage !== null, usage: usage ?? null };
}

/** A photo or link ready to add, from the Add choices. */
export type NewAttachment =
  | { kind: 'link'; name: string; url: string }
  | { kind: 'photo'; name: string; file: Blob; size: number; type: string; sha256: string };

/** The record fields for a new attachment, and the bytes to keep for it. */
export const recordOf = (a: NewAttachment): Omit<Attachment, 'id' | 'task_id'> =>
  a.kind === 'link' ? { kind: 'link', name: a.name, url: a.url } : { kind: 'photo', name: a.name, size: a.size, type: a.type, sha256: a.sha256 };

/**
 * Add link, which opens its fields at once, and Add photo, which opens the system's photo picker at once, with the
 * storage used under them. It checks a photo against the file cap and the quota before it's added, and says why when
 * it isn't.
 */
function AddAttachment(props: { count: number; onAdd(a: NewAttachment): Promise<unknown> }) {
  const { layout } = useApp();
  const photos = usePhotos();
  const [linking, setLinking] = useState(false);
  const [problem, setProblem] = useState('');
  const library = useRef<HTMLInputElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  // Focus goes back to Add link once its fields close, so it's never left on the page behind the popup.
  const opened = useRef(false);
  useEffect(() => {
    if (!linking && opened.current) linkButton.current?.focus();
    opened.current = linking;
  }, [linking]);
  const btn = layout === 'phone' ? 'btn attachadd' : 'btn sm attachadd';
  const full = !!photos.usage && photos.usage.used >= photos.usage.quota;
  const addLink = async (a: NewAttachment) => {
    if ((await props.onAdd(a)) !== false) setLinking(false);
  };

  const choosePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setProblem('');
    let jpeg: Blob;
    try {
      jpeg = await shrinkPhoto(file);
    } catch {
      return setProblem("That photo couldn't be read. Try another.");
    }
    if (jpeg.size > MAX_FILE) return setProblem(tooLarge(jpeg.size, MAX_FILE));
    if (photos.usage && photos.usage.used + jpeg.size > photos.usage.quota) return setProblem(storageFull(photos.usage.used, photos.usage.quota));
    await props.onAdd({ kind: 'photo', name: photoName(file), file: jpeg, size: jpeg.size, type: 'image/jpeg', sha256: await sha256Base64(jpeg) });
  };

  return (
    <>
      {problem && (
        <p className="fielderr" role="alert">
          {problem}
        </p>
      )}
      {props.count >= MAX_PER_TASK ? (
        <p className="small quiet">A task can have up to {MAX_PER_TASK} attachments.</p>
      ) : linking ? (
        <LinkForm onAdd={addLink} onCancel={() => setLinking(false)} />
      ) : (
        <>
          <div className="attachadds">
            <button ref={linkButton} className={btn} type="button" onClick={() => setLinking(true)}>
              <LinkIcon />
              Add link
            </button>
            {photos.offered && (
              <>
                <button className={btn} type="button" disabled={full} onClick={() => library.current?.click()}>
                  <PhotoIcon />
                  Add photo
                </button>
                {/* The system's photo picker. On iPhone its own menu offers the camera and the library. */}
                <input ref={library} hidden type="file" accept="image/*" aria-label="Add photo" onChange={choosePhoto} />
              </>
            )}
          </div>
          {photos.offered && photos.usage && (
            <p className="small quiet attachusage">
              {full ? (
                <>
                  {storageFull(photos.usage.used, photos.usage.quota)}
                  <br />
                  Removed files free their space after 30 days.
                </>
              ) : (
                `${usageLine(photos.usage.used, photos.usage.quota)}.`
              )}
            </p>
          )}
        </>
      )}
    </>
  );
}

export function Attachments(props: {
  taskId: string;
  /** Told each change's exact reverse, for a caller that undoes them together, such as Process's card. */
  onWrite?(reverse: RecordWrite): void;
  /** With none yet, only Add link and Add photo, to sit in a row of other buttons. */
  inline?: boolean;
}) {
  const { taskId, onWrite } = props;
  const { platform, clock } = useApp();
  const toast = useToast();
  const rows = useQuery((sql) => taskAttachments(sql, taskId), [taskId]).data ?? [];
  const label = useId();
  const create = useMutation((w, fields: Omit<Attachment, 'id' | 'task_id'>) => w.create('attachment', { task_id: taskId, ...fields }));
  const remove = useMutation(async (w, id: string) => (await w.delete('attachment', id), true));
  const restore = useMutation((w, id: string) => w.set('attachment', id, { deleted_at: null }));

  const add = async (a: NewAttachment) => {
    const id = await create.run(recordOf(a));
    if (!id) return false;
    onWrite?.({ type: 'attachment', id, fields: { deleted_at: nowInstant(clock) } });
    // Kept here until it uploads, which follows the record's sync.
    if (a.kind === 'photo') await platform.files.put(id, a.file);
    return true;
  };

  if (props.inline && rows.length === 0) return <AddAttachment count={0} onAdd={add} />;
  return (
    <section className="attachments stack8" aria-labelledby={label}>
      <h3 id={label} className="attachname">
        Attachments
      </h3>
      {rows.length > 0 && (
        <ul className="attachrows">
          {rows.map((a) => (
            <AttachmentRow
              key={a.id}
              attachment={a}
              onRemove={async () => {
                if (!(await remove.run(a.id))) return;
                onWrite?.({ type: 'attachment', id: a.id, fields: { deleted_at: null } });
                toast.show(`Removed ${a.name}.`, { undo: () => restore.run(a.id), focusUndo: true });
              }}
            />
          ))}
        </ul>
      )}
      <AddAttachment count={rows.length} onAdd={add} />
    </section>
  );
}

/**
 * Attachments for a task that isn't saved yet, as in Capture: each waits here, and goes in with the task, a photo
 * uploading once it's saved.
 */
export function DraftAttachments(props: { drafts: readonly NewAttachment[]; onChange(drafts: NewAttachment[]): void }) {
  const { layout } = useApp();
  const label = useId();
  const { drafts, onChange } = props;
  return (
    <section className="attachments stack8" aria-labelledby={label}>
      <h3 id={label} className="attachname">
        Attachments
      </h3>
      {drafts.length > 0 && (
        <ul className="attachrows">
          {drafts.map((a, i) => (
            <li key={i} className="attachrow">
              <span className="attachicon" aria-hidden="true">
                {a.kind === 'link' ? <LinkIcon /> : <PhotoIcon />}
              </span>
              <span className="attachwhat">
                <span className="attachtitle">{a.name}</span>
                <span className="small quiet">{a.kind === 'link' ? `Link · ${linkName(a.url)}` : 'Uploads when you save'}</span>
              </span>
              <button
                className={layout === 'phone' ? 'attachremove' : 'link small'}
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => onChange(drafts.filter((d) => d !== a))}
              >
                {layout === 'phone' ? <CloseIcon /> : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddAttachment count={drafts.length} onAdd={async (a) => onChange([...drafts, a])} />
    </section>
  );
}

function LinkForm(props: { onAdd(link: NewAttachment): unknown; onCancel(): void }) {
  const { layout } = useApp();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const ids = { url: useId(), name: useId() };
  const btn = layout === 'phone' ? 'btn' : 'btn sm';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const address = url.trim();
    if (!linkHref(address) || address.startsWith('mailto:')) return setError('Enter a web address, starting https:// or http://.');
    props.onAdd({ kind: 'link', url: address, name: name.trim() || linkName(address) });
  };
  return (
    // Not a form of its own, which can't sit inside the popup's: Enter adds the link rather than saving the task.
    <div
      className="attachlink stack8"
      role="group"
      aria-label="Paste a link"
      onKeyDown={(event) => {
        if (event.key === 'Enter') submit(event);
      }}
    >
      <label className="popfield" htmlFor={ids.url}>
        Address
      </label>
      <input id={ids.url} className="field" type="url" inputMode="url" autoFocus maxLength={MAX_LINK} value={url} onChange={(e) => (setUrl(e.target.value), setError(''))} />
      <label className="popfield" htmlFor={ids.name}>
        Name (optional)
      </label>
      <input id={ids.name} className="field" maxLength={300} value={name} onChange={(e) => setName(e.target.value)} />
      {error && (
        <p className="fielderr" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className={`${btn} pri`} type="button" onClick={submit}>
          Add link
        </button>
        <button className={btn} type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What a photo's row says beneath its name, from this device's upload and the record. */
function photoLine(a: Attachment, state: UploadState | null, local: boolean, zone: string): { text: string; alert?: boolean } {
  if (a.uploaded_at) return { text: `Photo · ${formatBytes(a.size ?? 0)}` };
  switch (state?.kind) {
    case 'uploading':
      return { text: `Uploading, ${formatBytes(state.sent)} of ${formatBytes(a.size ?? 0)}` };
    case 'limit':
      return { text: `Waiting to upload, from ${formatTime(state.from, zone)}` };
    case 'full':
      return { text: 'Not uploaded: storage full', alert: true };
    case 'refused':
      return { text: 'Not uploaded', alert: true };
    default:
      return { text: local ? 'Waiting to upload' : 'Not uploaded yet' };
  }
}

function AttachmentRow(props: { attachment: Attachment; onRemove(): void }) {
  const { attachment: a } = props;
  const { layout, platform, sync, clock } = useApp();
  const phone = layout === 'phone';
  const files = sync?.files;
  const state = useSyncExternalStore(
    (listener) => files?.subscribe(listener) ?? (() => undefined),
    () => files?.state(a.id) ?? null,
  );
  const [thumb, setThumb] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const local = !!thumb;
  const opener = useRef<HTMLButtonElement>(null);

  // The copy on this device, as the row's thumbnail.
  useEffect(() => {
    if (a.kind !== 'photo') return;
    let live = true;
    void platform.files.get(a.id).then((blob) => live && blob && setThumb((was) => was ?? URL.createObjectURL(blob)));
    return () => void (live = false);
  }, [a.id, a.kind, platform.files]);
  useEffect(() => () => void (thumb && URL.revokeObjectURL(thumb)), [thumb]);

  const open = async () => {
    if (!files) return;
    setProblem('');
    try {
      const blob = await files.open(a.id);
      setViewing(URL.createObjectURL(blob));
      // Kept here now, it's the row's thumbnail too.
      setThumb((was) => was ?? URL.createObjectURL(blob));
    } catch (err) {
      const why = err instanceof OpenError ? err : new OpenError('offline');
      setProblem(
        why.reason === 'gone'
          ? 'File no longer available'
          : why.reason === 'limit'
            ? `Too many downloads this hour. Try again${why.from ? ` at ${formatTime(why.from, clock.zone())}` : ' later'}.`
            : "Couldn't open it. Check your connection.",
      );
    }
  };

  const line = a.kind === 'link' ? { text: `Link · ${linkName(a.url ?? '')}` } : photoLine(a, state, local, clock.zone());
  const uploading = state?.kind === 'uploading' && a.size ? Math.min(1, state.sent / a.size) : null;
  return (
    <li className="attachrow">
      <span className="attachicon" aria-hidden="true">
        {thumb ? <img src={thumb} alt="" /> : a.kind === 'link' ? <LinkIcon /> : <PhotoIcon />}
      </span>
      <span className="attachwhat">
        {a.kind === 'link' ? (
          // Only to the web: a link from another app that goes anywhere else shows as text.
          a.url && linkHref(a.url) && !a.url.startsWith('mailto:') ? (
            <a className="attachtitle" href={a.url} target="_blank" rel="noreferrer">
              {a.name}
            </a>
          ) : (
            <span className="attachtitle">{a.name}</span>
          )
        ) : (
          <button ref={opener} className="attachtitle" type="button" aria-label={`Open ${a.name}`} onClick={() => void open()}>
            {a.name}
          </button>
        )}
        {uploading !== null && (
          <span className="attachprogress" role="progressbar" aria-label={`Uploading ${a.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(uploading * 100)}>
            <span style={{ width: `${uploading * 100}%` }} />
          </span>
        )}
        <span className={`small ${line.alert ? 'attachalert' : 'quiet'}`}>{problem || line.text}</span>
      </span>
      {state?.kind === 'full' && files && (
        <button className="link small" type="button" aria-label={`Retry uploading ${a.name}`} onClick={() => void files.retry(a.id)}>
          Retry
        </button>
      )}
      <button className={phone ? 'attachremove' : 'link small'} type="button" aria-label={`Remove ${a.name}`} onClick={props.onRemove}>
        {phone ? <CloseIcon /> : 'Remove'}
      </button>
      {viewing && (
        <Sheet label={a.name} className="attachview" onClose={() => (URL.revokeObjectURL(viewing), setViewing(null))}>
          <img src={viewing} alt={a.name} />
          <button className="btn" type="button" onClick={() => (URL.revokeObjectURL(viewing), setViewing(null))}>
            Close
          </button>
        </Sheet>
      )}
    </li>
  );
}
