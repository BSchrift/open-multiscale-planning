// A project's replanning log. Each entry is a slip_entry record of its own, as each finish of a one off is a
// task_completion, so entries two devices log offline merge, rather than one device's whole log replacing the other's.
// Bundles from before only know the project's slip_log array, so for now each entry is written to both, and the log is
// read as the two together. Planning code reads it as project.slip_log, from projects loaded with listProjects.

import type { Sql } from './db';
import type { RecordWrite } from './plan';
import { getRecord, listRecords, slipEntryId } from './records';
import type { Instant, Project, SlipEntry, SlipEntryRecord } from './types';

/** A 53-bit hash of a string (cyrb53): plenty to tell one project's entries apart, and the same on every device. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * An entry's id. One logged before entries were records has none, so it gets one from what it says. undo is left out,
 * since the server may hand its objects back with their keys in another order.
 */
export function entryId(projectId: string, e: SlipEntry): string {
  if (e.id) return e.id;
  const said = [e.at, e.kind, e.milestone_id, e.from, e.to, e.days, e.end_days, e.text].map((v) => v ?? null);
  return slipEntryId(projectId, hash(JSON.stringify(said)));
}

const asEntry = ({ project_id: _project, deleted_at: _deleted, ...entry }: SlipEntryRecord): SlipEntry => entry;

/**
 * A project's whole log: its array in its own order, with entries only records hold placed by when they were logged.
 * An entry in both shows once, and a deleted record takes its entry off even where an older bundle's array still has it.
 * With no records this is the array exactly, so a project from before reads as it always has.
 */
export function mergeLog(project: Project, records: readonly SlipEntryRecord[]): SlipEntry[] {
  const array = project.slip_log ?? [];
  if (!records.length) return array;
  const byId = new Map(records.map((r) => [r.id, r]));
  const inArray = new Set(array.map((e) => entryId(project.id, e)));
  const log = array.filter((e) => !byId.get(entryId(project.id, e))?.deleted_at);
  const extra = records
    .filter((r) => !r.deleted_at && !inArray.has(r.id))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  for (const record of extra) {
    let i = log.length;
    while (i > 0 && log[i - 1]!.at > record.at) i--;
    log.splice(i, 0, asEntry(record));
  }
  return log;
}

const entriesOf = (sql: Sql) => listRecords(sql, 'slip_entry', { includeDeleted: true });

/** Projects, deleted ones aside, each with its whole log as slip_log. Planning reads projects through this. */
export async function listProjects(sql: Sql): Promise<Project[]> {
  const [projects, entries] = await Promise.all([listRecords(sql, 'project'), entriesOf(sql)]);
  const byProject = new Map<string, SlipEntryRecord[]>();
  for (const e of entries) byProject.set(e.project_id, [...(byProject.get(e.project_id) ?? []), e]);
  return projects.map((p) => (byProject.has(p.id) ? { ...p, slip_log: mergeLog(p, byProject.get(p.id)!) } : p));
}

/** One project with its whole log as slip_log, or undefined. */
export async function getProject(sql: Sql, id: string): Promise<Project | undefined> {
  const project = await getRecord(sql, 'project', id);
  if (!project) return undefined;
  const entries = (await entriesOf(sql)).filter((e) => e.project_id === id);
  return entries.length ? { ...project, slip_log: mergeLog(project, entries) } : project;
}

/**
 * The writes that log a new entry: its record, then the array, whole log and all, so older bundles see it too.
 * shortcut: the array is still written for bundles that read nothing else, so it still grows toward the 100 KB a record
 * can hold, and older bundles still lose entries when two devices' arrays replace each other. Stop writing it, here and
 * in unlogWrites, once every installed shell reads slip_entry records, counting the bundle built into each app. The
 * array then keeps only entries from before, which mergeLog goes on reading.
 */
export function logWrites(project: Project, entry: SlipEntry & { id: string }): RecordWrite[] {
  const { id, ...fields } = entry;
  return [
    { type: 'slip_entry', id, fields: { project_id: project.id, ...fields } },
    { type: 'project', id: project.id, fields: { slip_log: [...(project.slip_log ?? []), entry] } },
  ];
}

/**
 * The writes that take an entry off the log: a delete on its record, and the array without it. An entry from before
 * records gets a record to hold the delete, in full, so undoing this brings it back whole.
 */
export function unlogWrites(project: Project, entry: SlipEntry, at: Instant): RecordWrite[] {
  const { id: _id, ...fields } = entry;
  return [
    { type: 'slip_entry', id: entryId(project.id, entry), fields: { project_id: project.id, ...fields, deleted_at: at } },
    { type: 'project', id: project.id, fields: { slip_log: (project.slip_log ?? []).filter((e) => e !== entry) } },
  ];
}
