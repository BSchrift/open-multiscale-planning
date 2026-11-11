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
//                                                             checks an inbox build: MAC_TEAM_ID, and SEVENZIP for 7zz

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APPLE_ROOT_SHA256, cdhash, checkCms, codeDirectoryProblems, DEVELOPER_ID_CA_SHA256, developerIdProblems, DMG_TRAILER_SLOT, dmgSignature, hasTicket,
  INFO_PLIST_SLOT, machOSignatures, parseCodeDirectory, RESOURCES_SLOT,
} from './code-signature.ts';
import type { Signature, Trust } from './code-signature.ts';

type Env = 'staging' | 'prod';
const ENVS: Env[] = ['staging', 'prod'];
/** The disk image's name in the inbox, and on the downloads host. */
export const DMG = 'Multiscale.dmg';
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
  /** The Electron the app is built on. */
  electron: string;
  /** The Mac app's shell hash (scripts/shell-hash.ts), which bundles in its feed must match. */
  shell: string;
  files: Record<typeof DMG | typeof ASAR, FileHash>;
  /** Apple's notary submissions for this build: the app's and the disk image's. */
  notarizations: { id: string; name: string; status: string }[];
}

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
  if (typeof m.electron !== 'string' || !/^\d+\.\d+\.\d+/.test(m.electron)) fail('electron is not a version');
  if (typeof m.shell !== 'string' || !/^[0-9a-f]{16}$/.test(m.shell)) fail('shell is not a shell hash');
  for (const name of [DMG, ASAR] as const) {
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

/**
 * Differences between the app's code and the pipeline's own build of it. app.asar must hold exactly the web build
 * (dist) and the main process (dist-electron), without source maps, and package.json as electron-builder trims it.
 * better-sqlite3 is unpacked beside it: its JavaScript must match the installed package, and its prebuilt Mac binaries,
 * native code, are left to the signature and notarization.
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
      problems.push(...packageProblems(actual(), plainFile(join(build.frontend, 'package.json')), path));
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
 * to what it packs. Nothing else may differ from the checkout's or the installed package's.
 */
function packageProblems(packed: Buffer, ours: Buffer, path: string): string[] {
  const app = JSON.parse(packed.toString('utf8')) as Record<string, unknown>;
  const original = JSON.parse(ours.toString('utf8')) as Record<string, unknown>;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return [...new Set([...Object.keys(app), ...LOADING])]
    .filter((key) => key === 'dependencies'
      ? !Object.entries(app.dependencies as Record<string, unknown>).every(([name, range]) => same(range, (original.dependencies as Record<string, unknown> | undefined)?.[name]))
      : !same(app[key], original[key]))
    .map((key) => `${path} in app.asar differs from the pipeline's in ${key}`);
}

/** Problems with the code resources seal over the files bundleProblems compares: their hashes must be the sealed ones. */
function sealProblems(app: string, codeResources: unknown): string[] {
  const files = (codeResources as { files2?: Record<string, { hash2?: Buffer }> }).files2 ?? {};
  const resources = join(app, 'Contents/Resources');
  const sealed = [ASAR, ...walk(join(resources, 'app.asar.unpacked')).filter((f) => !f.endsWith('.node')).map((f) => `app.asar.unpacked/${f}`)];
  return sealed
    .filter((file) => !files[`Resources/${file}`]?.hash2?.equals(createHash('sha256').update(plainFile(join(resources, file))).digest()))
    .map((file) => `The app's code signature doesn't seal Resources/${file} as it is`);
}

export interface Checks {
  /** Extracts the disk image's volume into a folder: 7-Zip in the pipeline. */
  extract(dmg: string, into: string): void;
  hasTicket(cdhash: Buffer): Promise<boolean>;
  openssl?: string;
  /** Apple's CA fingerprints unless a test gives its own. */
  trust?: Omit<Trust, 'teamId'>;
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
export async function verifyInbox(inbox: string, want: { env: Env; commit: string; teamId: string } & Build, checks: Checks): Promise<string[]> {
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

  const trust: Trust = { teamId: want.teamId, roots: APPLE_ROOT_SHA256, intermediates: DEVELOPER_ID_CA_SHA256, ...checks.trust };
  const problems: string[] = [];
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
  } catch (error) {
    problems.push(`The app: ${(error as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

const BUILD_OUTPUTS = ['ApiUrl', 'CognitoDomain', 'AppClientId', 'ReleaseUrl', 'DownloadsUrl'];

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
    const apps = readdirSync(release).filter((n) => n.startsWith('mac')).flatMap((d) => readdirSync(join(release, d)).filter((n) => n.endsWith('.app')).map((n) => join(release, d, n)));
    if (dmgs.length !== 1 || apps.length !== 1) throw new Error(`${release} holds ${dmgs.length} disk images and ${apps.length} apps, not one of each`);
    const asarData = readFileSync(join(apps[0]!, 'Contents/Resources', ASAR));
    const asar = readAsar(asarData);
    const versionEntry = asar.entries.find((e) => e.path === 'dist/version.json');
    if (!versionEntry) throw new Error('app.asar has no dist/version.json');
    const version = JSON.parse(asar.contents(versionEntry).toString('utf8')) as { version: string; build: number; shell: { electron: string } };
    const dmg = readFileSync(join(release, dmgs[0]!));
    const manifest: Manifest = {
      commit,
      env,
      version: version.version,
      build: version.build,
      electron: (JSON.parse(readFileSync(join(frontend, 'node_modules/electron/package.json'), 'utf8')) as { version: string }).version,
      shell: version.shell.electron,
      files: { [DMG]: fileHash(dmg), [ASAR]: fileHash(asarData) },
      notarizations: notarizations(readFileSync(history, 'utf8'), new Date(since)),
    };
    mkdirSync(out, { recursive: true });
    copyFileSync(join(release, dmgs[0]!), join(out, DMG));
    writeFileSync(join(out, 'manifest.json'), writeManifest(manifest));
    console.log(`${env}: ${manifest.version}, shell ${manifest.shell}, ${DMG} ${manifest.files[DMG].sha256}`);
  } else if (command === 'verify') {
    const [env, commit, inbox, web, electron] = args as [Env, string, string, string, string];
    const teamId = process.env.MAC_TEAM_ID ?? '';
    const sevenZip = process.env.SEVENZIP || '7zz';
    const problems = await verifyInbox(inbox, { env, commit, teamId, web, electron, frontend }, {
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
    console.log(`Checked ${env}'s Mac app at ${commit}: signed by the configured team, notarized, and the pipeline's own build inside.`);
  } else {
    throw new Error('Use: mac-inbox.ts build-config | unpack-config | manifest | verify. See the comment at its top.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
