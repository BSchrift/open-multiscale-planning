// The Mac app that GitHub Actions builds for the release pipeline, and the pipeline's check of it before publishing
// (.github/workflows/mac-release.yml, docs/releasing.md). GitHub Actions signs and notarizes each environment's app and
// uploads its disk image with a manifest to the pipeline's inbox. The pipeline checks both on Linux, and publishes the
// disk image only if the app inside is signed by the configured team, notarized, and holds the very code the pipeline
// built from the same commit.
//   node scripts/mac-inbox.ts build-config <config folder>    the config the Mac build reads, for MAC_BUILD_CONFIG
//   node scripts/mac-inbox.ts unpack-config <folder>          writes MAC_BUILD_CONFIG's files into a config folder
//   node scripts/mac-inbox.ts manifest <env> <commit> <since> <notarytool history> <out>
//                                                             the inbox's files for release/<env>'s build
//   node scripts/mac-inbox.ts verify <env> <commit> <inbox> <web build> <main process build>
//                                                             checks an inbox build: MAC_TEAM_ID, SEVENZIP for 7zz, and
//                                                             MULTISCALE_CONFIG_DIR for the app's bundle id
//   node scripts/mac-inbox.ts record <env> <inbox> <out>      a checked build's app record: out/app-record/<env>.json,
//                                                             and in out/<env>/manifest.json, which publishing keeps
//   node scripts/mac-inbox.ts live-record <env> <mac/manifest.json> <out>
//                                                             the live app's record, out/app-record/<env>.json, if it has one

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import {
  APPLE_ROOT_SHA256, cdhash, checkCms, codeDirectoryProblems, DEVELOPER_ID_CA_SHA256, developerIdProblems, DMG_TRAILER_SLOT, dmgSignature, hasTicket,
  fuseWires, INFO_PLIST_SLOT, machOSignatures, parseCodeDirectory, RESOURCES_SLOT, unsignedCode,
} from './code-signature.ts';
import type { Signature, Trust } from './code-signature.ts';
import { FuseV1Options } from '@electron/fuses';
import { parse as parseYaml } from 'yaml';
import { appIdentity, builderConfig } from '../electron/identity.ts';
import type { AppIdentity } from '../electron/identity.ts';

type Env = 'staging' | 'prod';
const ENVS: Env[] = ['staging', 'prod'];
/** The disk image's name in the inbox, and on the downloads host. */
export const DMG = 'Multiscale.dmg';
/** The zip of the same app, which the app updates itself from, and its blockmap, for downloading only what changed. */
export const ZIP = 'Multiscale.zip';
export const BLOCKMAP = `${ZIP}.blockmap`;
const ASAR = 'app.asar';

export interface FileHash {
  sha256: string;
  size: number;
}

/** What GitHub Actions says it built. The pipeline trusts none of it until the checks in verifyInbox agree. */
export interface Manifest {
  commit: string;
  env: Env;
  /** The web bundle's version and build number, from its version.json. */
  version: string;
  build: number;
  /** The app's own version, 0.1.<build> (appVersion). */
  appVersion: string;
  /** The Electron the app is built on. */
  electron: string;
  /** The Mac app's shell hash (scripts/shell-hash.ts), which bundles in its feed must match. */
  shell: string;
  files: Record<typeof DMG | typeof ZIP | typeof ASAR, FileHash>;
  /** Apple's notary submissions for this build: the app's and the disk image's. */
  notarizations: { id: string; name: string; status: string }[];
}

/**
 * The Mac app's version: the package's major and minor, then the build, the commit time every bundle compares, such as
 * 0.1.1794000000. So app versions only go up, as builds do.
 */
export const appVersion = (packageVersion: string, build: number) => `${packageVersion.split('.').slice(0, 2).join('.')}.${build}`;

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const fileHash = (data: Buffer): FileHash => ({ sha256: sha256(data), size: data.length });
const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')) : [];

/** Reads a manifest, and throws naming the first thing wrong with it. */
export function readManifest(text: string): Manifest {
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(text) as Partial<Manifest>;
  } catch {
    throw new Error('The inbox manifest is not JSON');
  }
  const fail = (what: string): never => {
    throw new Error(`The inbox manifest's ${what}`);
  };
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) fail('commit is not a full commit hash');
  if (!ENVS.includes(m.env as Env)) fail('env is not staging or prod');
  if (typeof m.version !== 'string' || !m.version) fail('version is missing');
  if (!Number.isInteger(m.build)) fail('build is not a whole number');
  if (typeof m.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.appVersion)) fail('appVersion is not a version');
  if (typeof m.electron !== 'string' || !/^\d+\.\d+\.\d+/.test(m.electron)) fail('electron is not a version');
  if (typeof m.shell !== 'string' || !/^[0-9a-f]{16}$/.test(m.shell)) fail('shell is not a shell hash');
  for (const name of [DMG, ZIP, ASAR] as const) {
    const f = m.files?.[name];
    if (!f || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.size)) fail(`files lack ${name}'s SHA-256 and size`);
  }
  if (!Array.isArray(m.notarizations) || m.notarizations.length === 0 || !m.notarizations.every((n) => typeof n?.id === 'string' && typeof n.name === 'string' && typeof n.status === 'string')) {
    fail('notarizations are missing');
  }
  return m as Manifest;
}

export const writeManifest = (manifest: Manifest) => `${JSON.stringify(readManifest(JSON.stringify(manifest)), null, 2)}\n`;

/** This build's submissions in notarytool history's JSON: those made since it started. Throws if none was accepted. */
export function notarizations(history: string, since: Date): Manifest['notarizations'] {
  const all = (JSON.parse(history) as { history?: { id: string; name: string; status: string; createdDate: string }[] }).history ?? [];
  const mine = all.filter((s) => new Date(s.createdDate) >= since).map(({ id, name, status }) => ({ id, name, status }));
  if (!mine.some((s) => s.status === 'Accepted')) throw new Error(`Apple's notary service accepted nothing since ${since.toISOString()}`);
  return mine;
}

export interface AsarEntry {
  path: string;
  size: number;
  offset: number;
  unpacked: boolean;
  link?: string;
}

/** An asar archive's files, as Electron reads them: a JSON header after two size fields, then the files' contents. */
export function readAsar(data: Buffer): { entries: AsarEntry[]; contents(entry: AsarEntry): Buffer } {
  if (data.readUInt32LE(0) !== 4) throw new Error('app.asar is not an asar archive');
  const base = 8 + data.readUInt32LE(4);
  type Node = { files?: Record<string, Node>; size?: number; offset?: string; unpacked?: boolean; link?: string };
  const header = JSON.parse(data.toString('utf8', 16, 16 + data.readUInt32LE(12))) as Node;
  const entries: AsarEntry[] = [];
  const visit = (node: Node, prefix: string) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) visit(child, path);
      else entries.push({ path, size: child.size ?? 0, offset: Number(child.offset ?? 0), unpacked: child.unpacked === true, ...(child.link ? { link: child.link } : {}) });
    }
  };
  visit(header, '');
  return { entries, contents: (e) => data.subarray(base + e.offset, base + e.offset + e.size) };
}

/** A file, folder or symbolic link in an app, from a zip or a folder on disk. A link's data is its target. */
export interface AppFile {
  type: 'file' | 'dir' | 'link';
  /** Permission bits, where the source has them. */
  mode?: number;
  data(): Buffer;
}

const S_IFMT = 0o170000;
const TYPES: Record<number, AppFile['type']> = { 0o100000: 'file', 0o040000: 'dir', 0o120000: 'link' };

/**
 * A zip's entries by path, as ditto would unpack them: read from its central directory, each checked against its local
 * header, with Unix modes. Throws naming the first thing wrong, such as a duplicate name, an absolute or .. path, a
 * local header that disagrees with its central directory, entries that overlap, or a feature this reader leaves out.
 */
export function readZip(zip: Buffer): Map<string, AppFile> {
  const fail = (what: string): never => {
    throw new Error(`The zip ${what}`);
  };
  let eocd = zip.length - 22;
  while (eocd >= Math.max(0, zip.length - 22 - 0xffff) && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0 || zip.readUInt32LE(eocd) !== 0x06054b50 || eocd + 22 + zip.readUInt16LE(eocd + 20) !== zip.length) fail('has no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  const start = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0 || zip.readUInt16LE(eocd + 8) !== count) fail('spans disks');
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) fail('is a zip64 archive, which this check does not read');
  if (start + size !== eocd) fail("has its central directory somewhere other than its end says");
  const files = new Map<string, AppFile>();
  const spans: [number, number][] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50) fail(`has a broken central directory entry at ${p}`);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const packed = zip.readUInt32LE(p + 20);
    const unpacked = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    if (next > eocd) fail(`has a central directory entry at ${p} that runs past its end`);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength);
    const mode = zip.readUInt32LE(p + 38) >>> 16;
    const local = zip.readUInt32LE(p + 42);
    p = next;
    if (flags & 1) fail(`encrypts ${name}`);
    if (method !== 0 && method !== 8) fail(`compresses ${name} in a way this check does not read`);
    const path = name.replace(/\/$/, '');
    if (!path || name.startsWith('/') || name.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) fail(`holds ${JSON.stringify(name)}, which is not a plain relative path`);
    if (files.has(path)) fail(`holds ${path} twice`);
    const type = TYPES[mode & S_IFMT] ?? fail(`holds ${path} with no Unix file type`);
    if ((type === 'dir') !== name.endsWith('/')) fail(`holds ${path} with the wrong file type for its name`);
    // The local header, which is what unzipping reads, must say what the central directory does.
    if (local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50) fail(`has no local header for ${path}`);
    const localFlags = zip.readUInt16LE(local + 6);
    const localName = zip.toString('utf8', local + 30, local + 30 + zip.readUInt16LE(local + 26));
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    let dataEnd = dataStart + packed;
    const sizes = (at: number) => [zip.readUInt32LE(at), zip.readUInt32LE(at + 4), zip.readUInt32LE(at + 8)].join();
    let agrees = localName === name && zip.readUInt16LE(local + 8) === method && localFlags === flags;
    if (!(flags & 8)) agrees &&= sizes(local + 14) === [crc, packed, unpacked].join();
    else {
      // A data descriptor after the data, with or without its signature.
      if (dataEnd + 4 <= start && zip.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      agrees &&= dataEnd + 12 <= start && sizes(dataEnd) === [crc, packed, unpacked].join();
      dataEnd += 12;
    }
    if (!agrees || dataEnd > start) fail(`has a local header for ${path} that disagrees with its central directory`);
    spans.push([local, dataEnd]);
    files.set(path, {
      type,
      mode: mode & 0o7777,
      data() {
        const raw = zip.subarray(dataStart, dataStart + packed);
        const data = method === 8 ? inflateRawSync(raw) : raw;
        if (data.length !== unpacked || crc32(data) !== crc) fail(`holds ${path} with contents that don't match its size and CRC`);
        return data;
      },
    });
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) fail('has entries that overlap');
  return files;
}

/** A folder's files by path: what lstat sees, so a link stays a link and isn't followed. */
export function readTree(dir: string, files = new Map<string, AppFile>(), prefix = ''): Map<string, AppFile> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const path = prefix + name;
    const stat = lstatSync(full);
    const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null;
    if (!type) throw new Error(`${path} is neither a file, a folder nor a link`);
    files.set(path, { type, mode: stat.mode & 0o7777, data: () => (type === 'link' ? Buffer.from(readlinkSync(full)) : type === 'file' ? readFileSync(full) : Buffer.alloc(0)) });
    if (type === 'dir') readTree(full, files, `${path}/`);
  }
  return files;
}

/** A value from an XML property list, as electron-builder writes Info.plist and codesign writes CodeResources. */
export function parsePlist(xml: string): unknown {
  if (xml.startsWith('bplist')) throw new Error('A binary property list, which this check does not read');
  const tokens = (xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) ?? []).filter((t) => t.trim());
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  let i = 0;
  const text = (close: string) => {
    const t = tokens[i]?.startsWith('<') ? '' : tokens[i++]!;
    if (tokens[i++] !== close) throw new Error(`The property list has no ${close} where expected`);
    return t.replace(/&(\w+);/g, (match, name: string) => entities[name] ?? match);
  };
  const value = (): unknown => {
    const tag = tokens[i++];
    if (tag?.startsWith('<plist')) {
      const v = value();
      i++;
      return v;
    }
    switch (tag) {
      case '<dict>': {
        const dict: Record<string, unknown> = {};
        while (tokens[i] !== '</dict>') {
          if (tokens[i++] !== '<key>') throw new Error('The property list has a dict entry without a key');
          const key = text('</key>');
          dict[key] = value();
        }
        i++;
        return dict;
      }
      case '<array>': {
        const array: unknown[] = [];
        while (tokens[i] !== '</array>') array.push(value());
        i++;
        return array;
      }
      case '<dict/>': return {};
      case '<array/>': return [];
      case '<string/>': return '';
      case '<true/>': return true;
      case '<false/>': return false;
      case '<string>': case '<date>': return text(tag.replace('<', '</'));
      case '<integer>': case '<real>': return Number(text(tag.replace('<', '</')));
      case '<data>': return Buffer.from(text('</data>').replace(/\s/g, ''), 'base64');
      default: throw new Error(`The property list has ${tag ?? 'nothing'} where a value should be`);
    }
  };
  return value();
}

/** Reads a file only if it is a plain file, not a link that an extracted disk image could point anywhere. */
function plainFile(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error(`${path} is not a plain file`);
  return readFileSync(path);
}

/** What the pipeline built from the commit: each environment's web build and main process, and the installed packages. */
export interface Build {
  web: string;
  electron: string;
  frontend: string;
}

/** The app version a build makes: appVersion of the checkout's package and the web build's build. */
function versionOf(build: Build) {
  const { version } = JSON.parse(readFileSync(join(build.frontend, 'package.json'), 'utf8')) as { version: string };
  const { build: number } = JSON.parse(readFileSync(join(build.web, 'version.json'), 'utf8')) as { build: number };
  return { version: appVersion(version, number), build: number };
}

/**
 * Differences between the app's code and the pipeline's own build of it. app.asar must hold exactly the web build
 * (dist) and the main process (dist-electron), without source maps, and package.json as electron-builder trims it, with
 * the app's version. better-sqlite3 is unpacked beside it: its JavaScript must match the installed package, and its
 * prebuilt Mac binaries are native code, which nativeProblems compares.
 */
export function bundleProblems(app: string, build: Build): string[] {
  const resources = join(app, 'Contents/Resources');
  const asar = readAsar(plainFile(join(resources, ASAR)));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of asar.entries) {
    const { path } = entry;
    seen.add(path);
    if (entry.link || path.split('/').some((part) => part === '..' || part === '')) {
      problems.push(`app.asar holds ${path}, which is not a plain file`);
      continue;
    }
    const actual = () => (entry.unpacked ? plainFile(join(resources, 'app.asar.unpacked', path)) : asar.contents(entry));
    let expected: string;
    if (path.startsWith('dist/') && !entry.unpacked) expected = join(build.web, path.slice('dist/'.length));
    else if (path.startsWith('dist-electron/') && !entry.unpacked) expected = join(build.electron, path.slice('dist-electron/'.length));
    else if (path === 'package.json' && !entry.unpacked) {
      problems.push(...packageProblems(actual(), plainFile(join(build.frontend, 'package.json')), path, versionOf(build).version));
      continue;
    } else if (path.startsWith('node_modules/better-sqlite3/') && entry.unpacked) {
      if (/^node_modules\/better-sqlite3\/prebuilds\/darwin-[\w-]+\.node$/.test(path)) continue;
      expected = join(build.frontend, path);
      if (path.endsWith('/package.json') && existsSync(expected)) {
        problems.push(...packageProblems(actual(), readFileSync(expected), path));
        continue;
      }
    } else {
      problems.push(`app.asar holds ${path}${entry.unpacked ? ' unpacked' : ''}, which the pipeline's build doesn't`);
      continue;
    }
    if (!existsSync(expected)) problems.push(`app.asar holds ${path}, which the pipeline's build doesn't`);
    else if (!actual().equals(readFileSync(expected))) problems.push(`${path} differs from the pipeline's build`);
  }
  for (const [dir, prefix] of [[build.web, 'dist'], [build.electron, 'dist-electron']] as const) {
    for (const file of walk(dir).filter((f) => !f.endsWith('.map'))) if (!seen.has(`${prefix}/${file}`)) problems.push(`app.asar lacks ${prefix}/${file}`);
  }
  const unpacked = new Set(asar.entries.filter((e) => e.unpacked).map((e) => e.path));
  for (const file of walk(join(resources, 'app.asar.unpacked'))) if (!unpacked.has(file)) problems.push(`app.asar.unpacked holds ${file}, which app.asar doesn't list`);
  return problems;
}

/** The fields that change how Node loads a package, which must match whether or not electron-builder keeps them. */
const LOADING = ['main', 'exports', 'imports', 'type'];

/**
 * electron-builder writes each package.json with fields left out, such as scripts, and the app's dependencies trimmed
 * to what it packs. Nothing else may differ from the checkout's or the installed package's, but the app's version,
 * which electron-build.mjs sets.
 */
function packageProblems(packed: Buffer, ours: Buffer, path: string, version?: string): string[] {
  const app = JSON.parse(packed.toString('utf8')) as Record<string, unknown>;
  const original = JSON.parse(ours.toString('utf8')) as Record<string, unknown>;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const versionProblem = version && app.version !== version ? [`${path} in app.asar says version ${String(app.version)}, not ${version}`] : [];
  return versionProblem.concat([...new Set([...Object.keys(app), ...LOADING])]
    .filter((key) => !(version && key === 'version'))
    .filter((key) => key === 'dependencies'
      ? !Object.entries(app.dependencies as Record<string, unknown>).every(([name, range]) => same(range, (original.dependencies as Record<string, unknown> | undefined)?.[name]))
      : !same(app[key], original[key]))
    .map((key) => `${path} in app.asar differs from the pipeline's in ${key}`));
}

/** Problems with the code resources seal over the files bundleProblems compares: their hashes must be the sealed ones. */
function sealProblems(app: string, codeResources: unknown): string[] {
  const files = (codeResources as { files2?: Record<string, { hash2?: Buffer }> }).files2 ?? {};
  const resources = join(app, 'Contents/Resources');
  const updateConfig = existsSync(join(app, UPDATE_CONFIG)) ? ['app-update.yml'] : [];
  const sealed = [ASAR, ...updateConfig, ...walk(join(resources, 'app.asar.unpacked')).filter((f) => !f.endsWith('.node')).map((f) => `app.asar.unpacked/${f}`)];
  return sealed
    .filter((file) => !files[`Resources/${file}`]?.hash2?.equals(createHash('sha256').update(plainFile(join(resources, file))).digest()))
    .map((file) => `The app's code signature doesn't seal Resources/${file} as it is`);
}

const isMachO = (data: Buffer) => data.length >= 4 && (data.readUInt32LE(0) === 0xfeedfacf || data.readUInt32BE(0) === 0xcafebabe);
const posixParts = (path: string) => path.split('/');
/** Where a link points, from the app's root, or null when it leaves the app. */
function linkTarget(path: string, target: string): string | null {
  if (target.startsWith('/')) return null;
  const parts = posixParts(path).slice(0, -1);
  for (const part of posixParts(target)) {
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/**
 * Differences between the zip and the disk image's app, which every other check reads: the same paths, each a file,
 * folder or link alike, links to the same places inside the app, and files with the same contents. Modes are checked
 * against Electron's own (modeProblems), since a disk image's volume read on Linux may not keep them.
 */
export function zipProblems(zip: Map<string, AppFile>, name: string, app: Map<string, AppFile>): string[] {
  const problems: string[] = [];
  const root = `${name}.app`;
  const seen = new Set<string>();
  for (const [full, entry] of zip) {
    if (full === root && entry.type === 'dir') continue;
    if (!full.startsWith(`${root}/`)) {
      problems.push(`The zip holds ${full}, outside the app`);
      continue;
    }
    const path = full.slice(root.length + 1);
    seen.add(path);
    const other = app.get(path);
    if (!other) problems.push(`The zip holds ${path}, which the disk image's app doesn't`);
    else if (other.type !== entry.type) problems.push(`The zip's ${path} is a ${entry.type}, but the disk image's is a ${other.type}`);
    else if (entry.type === 'link' && linkTarget(path, entry.data().toString()) === null) problems.push(`The zip's ${path} links outside the app, to ${entry.data().toString()}`);
    else if (entry.type !== 'dir' && !entry.data().equals(other.data())) problems.push(`The zip's ${path} ${entry.type === 'link' ? 'links elsewhere than' : 'differs from'} the disk image's`);
  }
  for (const path of app.keys()) if (!seen.has(path)) problems.push(`The zip lacks ${path}, which the disk image's app holds`);
  return problems;
}

/** Electron's app inside its zip, and the two files electron-builder copies from beside it. */
const ELECTRON_APP = 'Electron.app/';
const COPIED: Record<string, string> = { 'Contents/Resources/LICENSE.electron.txt': 'LICENSE', 'Contents/Resources/LICENSES.chromium.html': 'LICENSES.chromium.html' };
/** What electron-builder leaves out of Electron's app: the default app, and Electron's icon for ours. */
const LEFT_OUT = new Set(['Contents/Resources/default_app.asar', 'Contents/Resources/electron.icns']);

/** NSAppTransportSecurity as electron-builder 26 writes it, local addresses allowed for a dev server. */
const LOCAL_EXCEPTION = { NSIncludesSubdomains: false, NSTemporaryExceptionAllowsInsecureHTTPLoads: true, NSTemporaryExceptionAllowsInsecureHTTPSLoads: false, NSTemporaryExceptionMinimumTLSVersion: '1.0', NSTemporaryExceptionRequiresForwardSecrecy: false };
const ATS = { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true, NSExceptionDomains: { '127.0.0.1': LOCAL_EXCEPTION, localhost: LOCAL_EXCEPTION } };

/** What the app's native code and Info.plists must be: who it is, its version, and how electron-builder configures it. */
export interface AppExpectations {
  identity: AppIdentity;
  env: Env;
  version: string;
  build: number;
  /** The downloads host the app updates from, which its app-update.yml names, when the environment has one. */
  downloadsUrl?: string;
}

/**
 * electron-updater reads this before it downloads an update, for the folder it downloads into, and electron-builder
 * writes it from identity.ts's publish setting. An app without it can never update itself.
 */
const UPDATE_CONFIG = 'Contents/Resources/app-update.yml';

/** What's wrong with the app's app-update.yml: a generic feed at the downloads host, and a folder for downloads. */
function updateConfigProblems(data: Buffer, downloadsUrl: string | undefined): string[] {
  if (!downloadsUrl) return [`The app holds ${UPDATE_CONFIG}, though its environment has no downloads host`];
  let config: unknown;
  try {
    config = parseYaml(data.toString('utf8'));
  } catch {
    config = data.toString('utf8');
  }
  const c = config as Record<string, unknown> | null;
  const ok =
    !!c && typeof c === 'object' && Object.keys(c).sort().join() === 'provider,updaterCacheDirName,url' &&
    c.provider === 'generic' && c.url === downloadsUrl && typeof c.updaterCacheDirName === 'string' && /^[\w.-]+$/.test(c.updaterCacheDirName);
  return ok ? [] : [`${UPDATE_CONFIG} says ${canonical(config)}, not a generic feed at ${downloadsUrl} with a folder for its downloads`];
}

/** Where each of the app's files comes from in Electron's zip, or null for one of the app's own. */
function upstreamPath(path: string, name: string): string | null {
  if (COPIED[path]) return COPIED[path]!;
  if (/^Contents\/(Resources\/(app\.asar|icon\.icns|app-update\.yml)|CodeResources)$/.test(path) || /^Contents\/Resources\/app\.asar\.unpacked(\/|$)/.test(path) || /(^|\/)_CodeSignature(\/|$)/.test(path)) return null;
  const helper = new RegExp(`^Contents/Frameworks/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Helper( \\(\\w+\\))?\\.app(/.*)?$`).exec(path);
  if (helper) {
    const kind = helper[1] ?? '';
    const rest = (helper[2] ?? '').replace(new RegExp(`^/Contents/MacOS/.*$`), (m) => (m === `/Contents/MacOS/${name} Helper${kind}` ? `/Contents/MacOS/Electron Helper${kind}` : m));
    return `${ELECTRON_APP}Contents/Frameworks/Electron Helper${kind}.app${rest}`;
  }
  return path === `Contents/MacOS/${name}` ? `${ELECTRON_APP}Contents/MacOS/Electron` : `${ELECTRON_APP}${path}`;
}

/** Keys in a JSON value sorted, so two property lists compare by contents alone. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** Each Info.plist key electron-builder sets, to what, for the app's own Info.plist or a helper's. */
function plistExpectations(path: string, want: AppExpectations, asarHeader: Buffer | null): Record<string, unknown | RegExp> | null {
  const { name, appId } = want.identity;
  if (path === 'Contents/Info.plist') {
    const config = builderConfig(want.env, want.identity);
    return {
      CFBundleDisplayName: name,
      CFBundleExecutable: name,
      CFBundleIconFile: 'icon.icns',
      CFBundleIdentifier: appId,
      CFBundleName: name,
      CFBundleShortVersionString: want.version,
      CFBundleVersion: String(want.build),
      CFBundleURLTypes: config.protocols.map((p) => ({ CFBundleTypeRole: 'Editor', CFBundleURLName: p.name, CFBundleURLSchemes: p.schemes })),
      LSApplicationCategoryType: config.mac.category,
      NSAppTransportSecurity: ATS,
      NSHumanReadableCopyright: new RegExp(`^Copyright © \\d{4} ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      // Electron checks app.asar's header against this before it loads anything from it, with the fuse below.
      ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'SHA256', hash: asarHeader ? createHash('sha256').update(asarHeader).digest('hex') : null } },
      ...config.mac.extendInfo,
    };
  }
  const helper = new RegExp(`^Contents/Frameworks/(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Helper(?: \\((\\w+)\\))?)\\.app/Contents/Info\\.plist$`).exec(path);
  if (!helper) return null;
  return { CFBundleDisplayName: helper[1], CFBundleExecutable: helper[1], CFBundleIdentifier: `${appId}.helper${helper[2] ? `.${helper[2]}` : ''}`, CFBundleVersion: String(want.build) };
}

function plistProblems(path: string, data: Buffer, upstream: Buffer, expected: Record<string, unknown>): string[] {
  const ours = parsePlist(data.toString('utf8')) as Record<string, unknown>;
  const theirs = parsePlist(upstream.toString('utf8')) as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of [...new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(expected)])].sort()) {
    const want = key in expected ? expected[key] : theirs[key];
    const ok = want instanceof RegExp ? typeof ours[key] === 'string' && want.test(ours[key]) : canonical(ours[key]) === canonical(want);
    if (ok) continue;
    if (!(key in ours)) problems.push(`${path} lacks ${key}`);
    else problems.push(`${path} has ${key} ${canonical(ours[key])}, not ${key in expected && !(want instanceof RegExp) ? canonical(want) : 'as Electron has it'}`);
  }
  return problems;
}

/** The fuse wire the build makes of Electron's: identity.ts's electronFuses set, the rest as Electron ships them. */
function expectedFuses(upstream: Buffer, env: Env, identity: AppIdentity): string {
  const wire = Buffer.from(upstream);
  for (const [key, on] of Object.entries(builderConfig(env, identity).electronFuses)) {
    // electron-builder's names are @electron/fuses' FuseV1Options with a lower-case first letter.
    const index = (FuseV1Options as unknown as Record<string, number | undefined>)[key[0]!.toUpperCase() + key.slice(1)];
    if (index === undefined) throw new Error(`identity.ts sets a fuse @electron/fuses doesn't know: ${key}`);
    if (index < wire.length) wire[index] = on ? 0x31 : 0x30;
  }
  return wire.toString('latin1');
}

/**
 * Differences between the app and what electron-builder makes of Electron's own app: every file Electron's, byte for
 * byte, or its binaries' code byte for byte once signed again (unsignedCode), with the fuses the build sets; better-
 * sqlite3's binaries the installed package's; Info.plists as electron-builder writes them; and only the app's own files
 * besides. Anything the check can't account for is refused.
 */
export function nativeProblems(app: Map<string, AppFile>, electron: Map<string, AppFile>, sqlite: string, want: AppExpectations): string[] {
  const { name } = want.identity;
  const problems: string[] = [];
  const mapped = new Set<string>();
  const asar = app.get(`Contents/Resources/${ASAR}`);
  const asarHeader = asar?.type === 'file' ? (({ data }) => data.subarray(16, 16 + data.readUInt32LE(12)))({ data: asar.data() }) : null;
  for (const [path, entry] of app) {
    const from = upstreamPath(path, name);
    if (from === null) {
      if (entry.type !== 'file') continue;
      const data = entry.data();
      const prebuild = /^Contents\/Resources\/app\.asar\.unpacked\/node_modules\/better-sqlite3\/(prebuilds\/darwin-[\w-]+\.node)$/.exec(path);
      if (prebuild) {
        const theirs = join(sqlite, prebuild[1]!);
        try {
          if (!existsSync(theirs) || !unsignedCode(data).equals(unsignedCode(readFileSync(theirs)))) problems.push(`${path} isn't better-sqlite3's own`);
        } catch (error) {
          problems.push(`${path} ${(error as Error).message}`);
        }
      } else if (isMachO(data)) problems.push(`The app holds ${path}, which Electron's app doesn't`);
      else if (path === 'Contents/Resources/icon.icns' && data.toString('latin1', 0, 4) !== 'icns') problems.push(`${path} is not an icon`);
      else if (path === UPDATE_CONFIG) problems.push(...updateConfigProblems(data, want.downloadsUrl));
      continue;
    }
    const theirs = electron.get(from);
    if (!theirs) {
      problems.push(`The app holds ${path}, which Electron's app doesn't`);
      continue;
    }
    mapped.add(from);
    if (theirs.type !== entry.type) {
      problems.push(`${path} is a ${entry.type}, but Electron's is a ${theirs.type}`);
      continue;
    }
    if (entry.type === 'dir') continue;
    const data = entry.data();
    const expected = plistExpectations(path, want, asarHeader);
    if (expected) {
      problems.push(...plistProblems(path, data, theirs.data(), expected));
      continue;
    }
    if (entry.type === 'link') {
      if (!data.equals(theirs.data())) problems.push(`${path} links to ${data.toString()}, but Electron's links to ${theirs.data().toString()}`);
      continue;
    }
    if (!isMachO(data) && !isMachO(theirs.data())) {
      if (!data.equals(theirs.data())) problems.push(`${path} isn't Electron's own`);
      continue;
    }
    try {
      if (!unsignedCode(data).equals(unsignedCode(theirs.data()))) {
        problems.push(`${path} isn't Electron's own`);
        continue;
      }
    } catch (error) {
      problems.push(`${path} ${(error as Error).message}`);
      continue;
    }
    // The fuse bytes, which the comparison leaves out, are security settings: exactly the ones the build sets.
    const ours = fuseWires(data);
    const upstream = fuseWires(theirs.data());
    if (ours.length !== upstream.length) problems.push(`${path} has ${ours.length} fuse wires, not ${upstream.length} as Electron's has`);
    ours.forEach((wire, i) => {
      const fuses = wire.fuses.toString('latin1');
      const want_ = expectedFuses(upstream[i]!.fuses, want.env, want.identity);
      if (wire.version !== upstream[i]!.version || fuses !== want_) problems.push(`${path} has the fuses ${fuses}, not ${want_} as the build sets them`);
    });
  }
  for (const [from, entry] of electron) {
    const path = from.startsWith(ELECTRON_APP) ? from.slice(ELECTRON_APP.length) : null;
    if (path === null || mapped.has(from) || LEFT_OUT.has(path) || (entry.type === 'dir' && !path)) continue;
    problems.push(`The app lacks Electron's ${path}`);
  }
  if (want.downloadsUrl && app.get(UPDATE_CONFIG)?.type !== 'file') {
    problems.push(`The app lacks ${UPDATE_CONFIG}, which electron-updater reads before it downloads an update, so it couldn't update itself`);
  }
  return problems;
}

/** Modes in the zip, which Squirrel installs as they are: Electron's for its files, and no execute bits on the app's own. */
export function modeProblems(zip: Map<string, AppFile>, electron: Map<string, AppFile>, name: string): string[] {
  const problems: string[] = [];
  for (const [full, entry] of zip) {
    if (!full.startsWith(`${name}.app/`)) continue;
    const path = full.slice(name.length + 5);
    const from = upstreamPath(path, name);
    const theirs = from === null ? null : electron.get(from);
    const want = theirs ? (theirs.type === entry.type ? theirs.mode : undefined) : from === null ? (entry.type === 'dir' ? 0o755 : entry.type === 'file' ? 0o644 : undefined) : undefined;
    if (want !== undefined && entry.mode !== want) problems.push(`The zip's ${path} has mode ${entry.mode?.toString(8)}, not ${want.toString(8)} as ${theirs ? "Electron's has" : "the app's own files have"}`);
  }
  return problems;
}

export interface Checks {
  /** Extracts the disk image's volume into a folder: 7-Zip in the pipeline. */
  extract(dmg: string, into: string): void;
  hasTicket(cdhash: Buffer): Promise<boolean>;
  openssl?: string;
  /** Apple's CA fingerprints unless a test gives its own. */
  trust?: Omit<Trust, 'teamId'>;
  /** Electron's own darwin-arm64 zip, as its package's checksums.json names it (electronZip). */
  electron: Buffer;
}

async function signatureProblems(what: string, signature: Signature, codeProblems: string[], trust: Trust, checks: Checks): Promise<string[]> {
  const problems = codeProblems.map((p) => `${what}: ${p}`);
  const team = parseCodeDirectory(signature.codeDirectory).teamId;
  if (team !== trust.teamId) problems.push(`${what} is signed for team ${team ?? 'none'}, not the configured team`);
  try {
    const { signer, certificates } = checkCms(signature, checks.openssl);
    problems.push(...developerIdProblems(signer, certificates, trust).map((p) => `${what}: ${p}`));
  } catch (error) {
    problems.push(`${what}: ${(error as Error).message}`);
  }
  // A cdhash means something only once the code directory and its signature hold.
  if (problems.length === 0 && !(await checks.hasTicket(cdhash(signature)))) {
    problems.push(`${what} has no notarization ticket from Apple for its cdhash, ${cdhash(signature).toString('hex')}`);
  }
  return problems;
}

/**
 * Everything wrong with an inbox build of this commit for this environment, or nothing when the pipeline may publish
 * its disk image. Stops at the first of a wrong manifest, commit or file hash, since nothing after them is worth
 * reading. Otherwise reports every problem with the disk image's signature, the app's, and its code.
 */
export async function verifyInbox(inbox: string, want: { env: Env; commit: string; teamId: string; identity: AppIdentity; downloadsUrl?: string } & Build, checks: Checks): Promise<string[]> {
  let manifest: Manifest;
  try {
    manifest = readManifest(readFileSync(join(inbox, 'manifest.json'), 'utf8'));
  } catch (error) {
    return [(error as Error).message];
  }
  if (manifest.commit !== want.commit) return [`The inbox build is of commit ${manifest.commit}, but this run releases ${want.commit}`];
  if (manifest.env !== want.env) return [`The inbox build is for ${manifest.env}, not ${want.env}`];
  const dmgPath = join(inbox, DMG);
  const dmg = plainFile(dmgPath);
  if (sha256(dmg) !== manifest.files[DMG].sha256) return [`${DMG}'s SHA-256 doesn't match its manifest`];
  const zipData = existsSync(join(inbox, ZIP)) ? plainFile(join(inbox, ZIP)) : null;
  if (!zipData || sha256(zipData) !== manifest.files[ZIP].sha256) return [`${ZIP}'s SHA-256 doesn't match its manifest`];

  const trust: Trust = { teamId: want.teamId, roots: APPLE_ROOT_SHA256, intermediates: DEVELOPER_ID_CA_SHA256, ...checks.trust };
  const problems: string[] = [];
  const { version, build } = versionOf(want);
  if (manifest.appVersion !== version) problems.push(`The inbox manifest says the app is version ${manifest.appVersion}, not ${version}`);
  try {
    // The disk image, which is what's published: its signature covers every byte of it, the app included.
    const { signature, trailer } = dmgSignature(dmg);
    problems.push(...(await signatureProblems('The disk image', signature, codeDirectoryProblems(dmg, signature, { [DMG_TRAILER_SLOT]: trailer }), trust, checks)));
  } catch (error) {
    problems.push(`The disk image: ${(error as Error).message}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'mac-inbox-'));
  try {
    checks.extract(dmgPath, dir);
    const apps = readdirSync(dir).flatMap((volume) => (lstatSync(join(dir, volume)).isDirectory() ? readdirSync(join(dir, volume)).filter((n) => n.endsWith('.app')).map((n) => join(dir, volume, n)) : []));
    if (apps.length !== 1) return [...problems, `The disk image holds ${apps.length} apps, not one`];
    const app = apps[0]!;
    if (basename(app) !== `${want.identity.name}.app`) return [...problems, `The disk image holds ${basename(app)}, not ${want.identity.name}.app`];
    // The app's own signature, which seals Info.plist, the resources (app.asar among them) and the code.
    const info = plainFile(join(app, 'Contents/Info.plist'));
    const executable = (parsePlist(info.toString('utf8')) as { CFBundleExecutable?: unknown }).CFBundleExecutable;
    if (typeof executable !== 'string' || !executable || executable.includes('/')) return [...problems, "The app's Info.plist names no executable"];
    const codeResources = plainFile(join(app, 'Contents/_CodeSignature/CodeResources'));
    for (const { slice, signature } of machOSignatures(plainFile(join(app, 'Contents/MacOS', executable)))) {
      const external = { [INFO_PLIST_SLOT]: info, [RESOURCES_SLOT]: codeResources };
      problems.push(...(await signatureProblems('The app', signature, codeDirectoryProblems(slice, signature, external), trust, checks)));
    }
    problems.push(...sealProblems(app, parsePlist(codeResources.toString('utf8'))));
    const code = bundleProblems(app, want);
    if (code.some((p) => /^dist(-electron)?\/(version\.json|main\.cjs) differs/.test(p))) {
      code.push("The build's settings differ: MAC_BUILD_CONFIG may be out of date. See docs/releasing.md.");
    }
    problems.push(...code);
    if (sha256(plainFile(join(app, 'Contents/Resources', ASAR))) !== manifest.files[ASAR].sha256) problems.push(`${ASAR}'s SHA-256 doesn't match the manifest`);
    // The zip, which the app updates itself from, must hold exactly this app, and the app Electron's own native code.
    const tree = readTree(app);
    const electron = readZip(checks.electron);
    try {
      const zip = readZip(zipData);
      problems.push(...zipProblems(zip, want.identity.name, tree), ...modeProblems(zip, electron, want.identity.name));
    } catch (error) {
      problems.push((error as Error).message);
    }
    problems.push(...nativeProblems(tree, electron, join(want.frontend, 'node_modules/better-sqlite3'), { identity: want.identity, env: want.env, version, build, downloadsUrl: want.downloadsUrl }));
  } catch (error) {
    problems.push(`The app: ${(error as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

/**
 * What a release's manifest names as the app that runs it (sign-release.mjs): its version, build and native code, the
 * folder on the downloads host the app updates from, and the zip there with its SHA-512, as electron-updater checks it.
 */
export interface AppRecord {
  version: string;
  build: number;
  shell: string;
  folder: string;
  file: string;
  sha512: string;
  size: number;
}

/** The record of a checked inbox build: its version and native code from the manifest, its zip's hash from the zip. */
export function appRecord(inbox: string): AppRecord {
  const manifest = readManifest(readFileSync(join(inbox, 'manifest.json'), 'utf8'));
  const zip = plainFile(join(inbox, ZIP));
  return {
    version: manifest.appVersion,
    build: manifest.build,
    shell: manifest.shell,
    // Named by the whole version, since electron-updater finds the last version's blockmap by putting its version in
    // place of this one's in the zip's address.
    folder: `mac/${manifest.appVersion}/`,
    file: ZIP,
    sha512: createHash('sha512').update(zip).digest('base64'),
    size: zip.length,
  };
}

/** The record in the live app's mac/manifest.json, or null for one published before apps had records. */
export function liveRecord(text: string): AppRecord | null {
  try {
    const record = (JSON.parse(text) as { record?: AppRecord }).record;
    return record && typeof record.version === 'string' && typeof record.sha512 === 'string' ? record : null;
  } catch {
    return null;
  }
}

/**
 * Electron's own darwin-arm64 zip for the installed Electron, downloaded from its release, and refused unless it has
 * the SHA-256 the installed package's checksums.json gives it, which npm checked against the lockfile.
 */
export async function electronZip(frontend: string, request: typeof fetch = fetch): Promise<Buffer> {
  const { version } = JSON.parse(readFileSync(join(frontend, 'node_modules/electron/package.json'), 'utf8')) as { version: string };
  const name = `electron-v${version}-darwin-arm64.zip`;
  const want = (JSON.parse(readFileSync(join(frontend, 'node_modules/electron/checksums.json'), 'utf8')) as Record<string, string>)[name];
  if (!want) throw new Error(`Electron's checksums.json has no SHA-256 for ${name}`);
  const response = await request(`https://github.com/electron/electron/releases/download/v${version}/${name}`);
  if (!response.ok) throw new Error(`Couldn't download ${name}: ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  if (sha256(zip) !== want) throw new Error(`${name} doesn't have the SHA-256 Electron's checksums.json gives it`);
  return zip;
}

// Every output loadAppConfig reads, since the build embeds them and the Mac app's content policy names some.
const BUILD_OUTPUTS = ['ApiUrl', 'CognitoDomain', 'AppClientId', 'ReleaseUrl', 'DownloadsUrl', 'FilesUrl', 'FilesUploadUrl'];

/** The config folder's files that the Mac build reads, cut to what it reads from them, as MAC_BUILD_CONFIG holds them. */
export async function buildConfig(dir: string): Promise<Record<string, string>> {
  const { loadBundleId, readOutputs } = await import('../src/core/appConfig.ts');
  const { releaseKeyIn } = await import('./sign-release.mjs');
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
  const files: Record<string, string> = {};
  for (const env of ENVS) {
    const outputs = readOutputs(env, read, dir);
    files[`${env}.outputs.json`] = JSON.stringify(Object.fromEntries(BUILD_OUTPUTS.filter((key) => outputs[key] !== undefined).map((key) => [key, outputs[key]])));
    const bundleId = loadBundleId(env, read, dir);
    // JSON is YAML too.
    files[`${env}.yaml`] = JSON.stringify(bundleId ? { app: { bundleId } } : {});
    const key = releaseKeyIn(dir, env);
    if (!key) throw new Error(`${dir} has no ${env}.release-key.pem. Release ${env} from the Mac once first.`);
    files[`${env}.release-key.pub`] = key;
  }
  return files;
}

/** Writes MAC_BUILD_CONFIG's files, only those, and the values to hide from a public run's log. */
export function unpackConfig(encoded: string, dir: string): string[] {
  const files = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, string>;
  const allowed = ENVS.flatMap((env) => [`${env}.outputs.json`, `${env}.yaml`, `${env}.release-key.pub`]);
  const missing = allowed.filter((name) => typeof files[name] !== 'string');
  if (missing.length > 0) throw new Error(`MAC_BUILD_CONFIG lacks ${missing.join(', ')}. Make it again: docs/releasing.md.`);
  mkdirSync(dir, { recursive: true });
  const hidden = new Set<string>();
  for (const name of allowed) {
    writeFileSync(join(dir, name), files[name]!);
    if (name.endsWith('.release-key.pub')) continue;
    const strings = (value: unknown): string[] => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);
    for (const value of strings(JSON.parse(files[name]!))) {
      hidden.add(value);
      if (/^https:\/\//.test(value)) hidden.add(new URL(value).host);
    }
  }
  return [...hidden];
}

async function main([command, ...args]: string[]) {
  const frontend = join(import.meta.dirname, '..');
  if (command === 'build-config') {
    process.stdout.write(Buffer.from(JSON.stringify(await buildConfig(args[0]!))).toString('base64'));
  } else if (command === 'unpack-config') {
    const hidden = unpackConfig(process.env.MAC_BUILD_CONFIG ?? '', args[0]!);
    // Workflow commands, which GitHub Actions reads from the output and doesn't print.
    if (process.env.GITHUB_ACTIONS === 'true') for (const value of hidden) console.log(`::add-mask::${value}`);
  } else if (command === 'manifest') {
    const [env, commit, since, history, out] = args as [Env, string, string, string, string];
    const release = join(frontend, 'release', env);
    const dmgs = readdirSync(release).filter((n) => n.endsWith('.dmg'));
    const zips = readdirSync(release).filter((n) => n.endsWith('.zip'));
    const apps = readdirSync(release).filter((n) => n.startsWith('mac')).flatMap((d) => readdirSync(join(release, d)).filter((n) => n.endsWith('.app')).map((n) => join(release, d, n)));
    if (dmgs.length !== 1 || zips.length !== 1 || apps.length !== 1) throw new Error(`${release} holds ${dmgs.length} disk images, ${zips.length} zips and ${apps.length} apps, not one of each`);
    const asarData = readFileSync(join(apps[0]!, 'Contents/Resources', ASAR));
    const asar = readAsar(asarData);
    const versionEntry = asar.entries.find((e) => e.path === 'dist/version.json');
    if (!versionEntry) throw new Error('app.asar has no dist/version.json');
    const version = JSON.parse(asar.contents(versionEntry).toString('utf8')) as { version: string; build: number; shell: { electron: string } };
    const packageEntry = asar.entries.find((e) => e.path === 'package.json');
    if (!packageEntry) throw new Error('app.asar has no package.json');
    const dmg = readFileSync(join(release, dmgs[0]!));
    const zip = readFileSync(join(release, zips[0]!));
    const manifest: Manifest = {
      commit,
      env,
      version: version.version,
      build: version.build,
      appVersion: (JSON.parse(asar.contents(packageEntry).toString('utf8')) as { version: string }).version,
      electron: (JSON.parse(readFileSync(join(frontend, 'node_modules/electron/package.json'), 'utf8')) as { version: string }).version,
      shell: version.shell.electron,
      files: { [DMG]: fileHash(dmg), [ZIP]: fileHash(zip), [ASAR]: fileHash(asarData) },
      notarizations: notarizations(readFileSync(history, 'utf8'), new Date(since)),
    };
    mkdirSync(out, { recursive: true });
    copyFileSync(join(release, dmgs[0]!), join(out, DMG));
    copyFileSync(join(release, zips[0]!), join(out, ZIP));
    copyFileSync(join(release, `${zips[0]!}.blockmap`), join(out, BLOCKMAP));
    writeFileSync(join(out, 'manifest.json'), writeManifest(manifest));
    console.log(`${env}: ${manifest.version}, app ${manifest.appVersion}, shell ${manifest.shell}, ${DMG} ${manifest.files[DMG].sha256}`);
  } else if (command === 'verify') {
    const [env, commit, inbox, web, electron] = args as [Env, string, string, string, string];
    const teamId = process.env.MAC_TEAM_ID ?? '';
    const sevenZip = process.env.SEVENZIP || '7zz';
    const { loadAppConfig, loadBundleId } = await import('../src/core/appConfig.ts');
    const configDir = process.env.MULTISCALE_CONFIG_DIR ?? '';
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
    const identity = appIdentity(env, loadBundleId(env, read, configDir));
    // As electron-build.mjs passes it to electron-builder, which writes it into the app's app-update.yml.
    const { downloadsUrl } = loadAppConfig(env, read, configDir);
    const problems = await verifyInbox(inbox, { env, commit, teamId, identity, downloadsUrl, web, electron, frontend }, {
      electron: await electronZip(frontend),
      extract: (dmg, into) => execFileSync(sevenZip, ['x', '-snl', '-sns-', '-y', `-o${into}`, dmg], { stdio: ['ignore', 'ignore', 'inherit'] }),
      // Apple's lookup now and then fails to answer, so it's asked three times before the check gives up.
      hasTicket: async (hash) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await hasTicket(hash);
          } catch (error) {
            if (attempt === 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
          }
        }
      },
    });
    if (problems.length > 0) {
      console.error(`The Mac app GitHub Actions built for ${env} at ${commit} failed its checks, so it won't be published:\n- ${problems.slice(0, 30).join('\n- ')}`);
      process.exit(1);
    }
    console.log(`Checked ${env}'s Mac app at ${commit}: signed by the configured team, notarized, the pipeline's own build inside, on Electron's own native code, and its zip the same app.`);
  } else if (command === 'record') {
    const [env, inbox, out] = args as [Env, string, string];
    const record = appRecord(inbox);
    mkdirSync(join(out, env), { recursive: true });
    mkdirSync(join(out, 'app-record'), { recursive: true });
    // The record of a checked app that publishing leaves in the bucket, with the record itself in it for later runs.
    writeFileSync(join(out, env, 'manifest.json'), `${JSON.stringify({ ...readManifest(readFileSync(join(inbox, 'manifest.json'), 'utf8')), record }, null, 2)}\n`);
    writeFileSync(join(out, 'app-record', `${env}.json`), `${JSON.stringify(record)}\n`);
    console.log(`${env}: app ${record.version}, ${ZIP} ${record.sha512}`);
  } else if (command === 'live-record') {
    const [env, live, out] = args as [Env, string, string];
    const record = liveRecord(existsSync(live) ? readFileSync(live, 'utf8') : '');
    if (!record) {
      console.log(`${env}'s live Mac app has no record, as one published before apps had them, so its releases name no app.`);
      return;
    }
    mkdirSync(join(out, 'app-record'), { recursive: true });
    writeFileSync(join(out, 'app-record', `${env}.json`), `${JSON.stringify(record)}\n`);
    console.log(`${env}: the live app ${record.version} runs this release.`);
  } else {
    throw new Error('Use: mac-inbox.ts build-config | unpack-config | manifest | verify | record | live-record. See the comment at its top.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
