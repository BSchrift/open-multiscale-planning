// Test fixtures for code-signature.ts and mac-inbox.ts, made at test time: a certificate chain shaped like Apple's
// Developer ID chain, Mach-O binaries and disk images signed with it in codesign's format, and a Mac app with its
// app.asar beside the build it should match. OpenSSL makes the keys and the CMS signatures. Nothing here is a real key
// or certificate, and none of it is committed.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { appIdentity } from '../electron/identity.ts';
import type { AppIdentity } from '../electron/identity.ts';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

export interface Identity {
  dir: string;
  /** The leaf's certificate and key files, and the CA certificates to carry beside it. */
  cert: string;
  key: string;
  chain: string;
  root: X509Certificate;
  intermediate: X509Certificate;
}

/** A root, a Developer ID-shaped CA under it, and a Developer ID Application certificate for the team under that. */
export function makeIdentity(teamId: string, { application = true, days = 2 } = {}): Identity {
  const dir = mkdtempSync(join(tmpdir(), 'identity-'));
  const at = (name: string) => join(dir, name);
  const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  const key = (name: string) => ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', at(`${name}.key`)];
  // OpenSSL wants a config naming a distinguished name section, even with -subj.
  writeFileSync(at('req.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
  openssl('req', '-x509', ...key('root'), '-out', at('root.pem'), '-days', String(days), '-subj', '/CN=Test Root CA/O=Test', '-config', at('req.cnf'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  const issue = (name: string, subject: string, issuer: string, ext: string) => {
    writeFileSync(at(`${name}.ext`), ext);
    openssl('req', '-new', ...key(name), '-out', at(`${name}.csr`), '-subj', subject, '-config', at('req.cnf'));
    openssl('x509', '-req', '-in', at(`${name}.csr`), '-CA', at(`${issuer}.pem`), '-CAkey', at(`${issuer}.key`), '-set_serial', String(Date.now()), '-days', String(days), '-out', at(`${name}.pem`), '-extfile', at(`${name}.ext`));
  };
  issue('ca', '/CN=Test Developer ID Certification Authority/O=Test', 'root', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n1.2.840.113635.100.6.2.6=DER:0500\n');
  issue('leaf', `/CN=Developer ID Application: Test (${teamId})/OU=${teamId}/O=Test`, 'ca',
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n${application ? '1.2.840.113635.100.6.1.13=critical,DER:0500\n' : ''}`);
  writeFileSync(at('chain.pem'), Buffer.concat([readFileSync(at('ca.pem')), readFileSync(at('root.pem'))]));
  return {
    dir,
    cert: at('leaf.pem'),
    key: at('leaf.key'),
    chain: at('chain.pem'),
    root: new X509Certificate(readFileSync(at('root.pem'))),
    intermediate: new X509Certificate(readFileSync(at('ca.pem'))),
  };
}

/** The trust that makes an identity's CAs stand in for Apple's. */
export const trustOf = (identity: Identity) => ({ roots: [identity.root.fingerprint256], intermediates: [identity.intermediate.fingerprint256] });

/** A detached CMS signature over data, carrying the chain, as codesign makes over a code directory. */
function cmsSign(data: Buffer, identity: Identity): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cms-'));
  writeFileSync(join(dir, 'in'), data);
  execFileSync('openssl', ['cms', '-sign', '-binary', '-in', join(dir, 'in'), '-signer', identity.cert, '-inkey', identity.key, '-certfile', identity.chain, '-md', 'sha256', '-outform', 'DER', '-out', join(dir, 'out'), '-nosmimecap'], { stdio: 'pipe' });
  return readFileSync(join(dir, 'out'));
}

function superblob(blobs: [number, Buffer][]): Buffer {
  let offset = 12 + 8 * blobs.length;
  const index = blobs.map(([slot, blob]) => {
    const entry = Buffer.concat([u32(slot), u32(offset)]);
    offset += blob.length;
    return entry;
  });
  return Buffer.concat([u32(0xfade0cc0), u32(offset), u32(blobs.length), ...index, ...blobs.map(([, b]) => b)]);
}

/** A version 0x20400 SHA-256 code directory over code[0, codeLimit), with special slots 1.. hashing what's given. */
function codeDirectory(code: Buffer, codeLimit: number, pageBits: number, special: (Buffer | undefined)[], identifier: string, teamId: string): Buffer {
  const page = pageBits ? 2 ** pageBits : codeLimit;
  const codeHashes = Array.from({ length: Math.ceil(codeLimit / page) }, (_, i) => sha256(code.subarray(i * page, Math.min((i + 1) * page, codeLimit))));
  const specialHashes = special.map((s) => (s ? sha256(s) : Buffer.alloc(32))).reverse();
  const ident = Buffer.from(`${identifier}\0`);
  const team = Buffer.from(`${teamId}\0`);
  const header = Buffer.alloc(88);
  const hashOffset = 88 + ident.length + team.length + 32 * special.length;
  const length = hashOffset + 32 * codeHashes.length;
  header.writeUInt32BE(0xfade0c02, 0);
  header.writeUInt32BE(length, 4);
  header.writeUInt32BE(0x20400, 8);
  header.writeUInt32BE(0x10000, 12);
  header.writeUInt32BE(hashOffset, 16);
  header.writeUInt32BE(88, 20);
  header.writeUInt32BE(special.length, 24);
  header.writeUInt32BE(codeHashes.length, 28);
  header.writeUInt32BE(codeLimit, 32);
  header[36] = 32;
  header[37] = 2;
  header[39] = pageBits;
  header.writeUInt32BE(88 + ident.length, 48);
  return Buffer.concat([header, ident, team, ...specialHashes, ...codeHashes]);
}

const REQUIREMENTS = Buffer.concat([u32(0xfade0c01), u32(12), u32(0)]);

function signatureBlob(cd: Buffer, identity: Identity | undefined): Buffer {
  const cms = identity ? cmsSign(cd, identity) : Buffer.alloc(0);
  return superblob([[0, cd], [2, REQUIREMENTS], [0x10000, Buffer.concat([u32(0xfade0b01), u32(8 + cms.length), cms])]]);
}

const RESERVED = 16384;

/** A thin arm64 Mach-O executable signed as codesign signs one: Info.plist and CodeResources in slots 1 and 3. */
export function signedMachO(identity: Identity | undefined, teamId: string, external: { info?: Buffer; resources?: Buffer } = {}): Buffer {
  const body = randomBytes(10000);
  const dataOffset = Math.ceil((48 + body.length) / 16) * 16;
  const header = Buffer.alloc(48);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(16, 20);
  header.writeUInt32LE(0x1d, 32);
  header.writeUInt32LE(16, 36);
  header.writeUInt32LE(dataOffset, 40);
  header.writeUInt32LE(RESERVED, 44);
  const code = Buffer.alloc(dataOffset);
  Buffer.concat([header, body]).copy(code);
  const cd = codeDirectory(code, dataOffset, 12, [external.info, REQUIREMENTS, external.resources, undefined, undefined, undefined, undefined], 'com.example.multiscale', teamId);
  const signature = Buffer.alloc(RESERVED);
  signatureBlob(cd, identity).copy(signature);
  return Buffer.concat([code, signature]);
}

/** An unsigned thin arm64 Mach-O laid out as a linker writes one: load commands, the code, then __LINKEDIT's data. */
export function linkedMachO(body: Buffer): Buffer {
  const header = Buffer.alloc(256);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(72, 20);
  header.writeUInt32LE(0x19, 32);
  header.writeUInt32LE(72, 36);
  header.write('__LINKEDIT', 40, 'latin1');
  const code = Buffer.concat([header, body, Buffer.alloc((16 - (body.length % 16)) % 16)]);
  // A multiple of 16 bytes, as linkers leave it, so a signature can follow with no padding.
  const linkedit = sha256(body);
  header.writeBigUInt64LE(0x100000000n + BigInt(code.length), 56);
  header.writeBigUInt64LE(0x4000n, 64);
  header.writeBigUInt64LE(BigInt(code.length), 72);
  header.writeBigUInt64LE(BigInt(linkedit.length), 80);
  header.copy(code);
  return Buffer.concat([code, linkedit]);
}

/**
 * Signs a Mach-O as codesign does, in place of any signature it has: LC_CODE_SIGNATURE after the other load commands,
 * pointing at the signature after __LINKEDIT's data, and __LINKEDIT grown to hold it. Ad hoc without an identity.
 */
export function signMachO(file: Buffer, identity: Identity | undefined, teamId: string, external: { info?: Buffer; resources?: Buffer } = {}, reserve = RESERVED): Buffer {
  let code = Buffer.from(file);
  let commands = code.readUInt32LE(16);
  let at = 32;
  let signature = -1;
  let linkedit = -1;
  for (let i = 0; i < commands; i++) {
    if (code.readUInt32LE(at) === 0x1d) signature = at;
    if (code.readUInt32LE(at) === 0x19 && code.toString('latin1', at + 8, at + 18) === '__LINKEDIT') linkedit = at;
    at += code.readUInt32LE(at + 4);
  }
  if (signature >= 0) code = code.subarray(0, code.readUInt32LE(signature + 8));
  else {
    signature = at;
    code.writeUInt32LE(0x1d, at);
    code.writeUInt32LE(16, at + 4);
    code.writeUInt32LE((commands += 1), 16);
    code.writeUInt32LE(code.readUInt32LE(20) + 16, 20);
  }
  const dataOffset = Math.ceil(code.length / 16) * 16;
  code = Buffer.concat([code, Buffer.alloc(dataOffset - code.length)]);
  code.writeUInt32LE(dataOffset, signature + 8);
  code.writeUInt32LE(reserve, signature + 12);
  const fileSize = BigInt(dataOffset + reserve) - code.readBigUInt64LE(linkedit + 40);
  code.writeBigUInt64LE(fileSize, linkedit + 48);
  code.writeBigUInt64LE(((fileSize + 0x3fffn) / 0x4000n) * 0x4000n, linkedit + 32);
  const cd = codeDirectory(code, dataOffset, 12, [external.info, REQUIREMENTS, external.resources, undefined, undefined, undefined, undefined], 'com.example.multiscale', teamId);
  const blob = Buffer.alloc(reserve);
  signatureBlob(cd, identity).copy(blob);
  return Buffer.concat([code, blob]);
}

/** A disk image's bytes with a UDIF trailer and a signature, as codesign signs one. */
export function signedDmg(identity: Identity | undefined, teamId: string): Buffer {
  const data = randomBytes(20000);
  const trailer = Buffer.alloc(512);
  trailer.write('koly', 0, 'latin1');
  trailer.writeUInt32BE(4, 4);
  trailer.writeUInt32BE(512, 8);
  trailer.writeBigUInt64BE(BigInt(data.length), 296);
  const cd = codeDirectory(data, data.length, 0, [undefined, REQUIREMENTS, undefined, undefined, undefined, Buffer.from(trailer)], 'Multiscale', teamId);
  const signature = signatureBlob(cd, identity);
  trailer.writeBigUInt64BE(BigInt(signature.length), 304);
  return Buffer.concat([data, signature, trailer]);
}

/** An asar archive as electron-builder writes one: paths to contents, or to null for a file kept beside it, unpacked. */
export function asar(files: Record<string, Buffer | null>): Buffer {
  type Node = { files: Record<string, Node | object> };
  const header: Node = { files: {} };
  const contents: Buffer[] = [];
  let offset = 0;
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/');
    let node = header;
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} }) as Node;
    if (data === null) node.files[parts.at(-1)!] = { size: 0, unpacked: true };
    else {
      node.files[parts.at(-1)!] = { size: data.length, offset: String(offset) };
      contents.push(data);
      offset += data.length;
    }
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const pickle = Buffer.concat([u32le(4 + padded.length), u32le(json.length), padded]);
  return Buffer.concat([u32le(4), u32le(pickle.length), pickle, ...contents]);
}

function u32le(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;

/** A file, folder or link to make: contents or a link's target, with its mode. */
export interface Entry {
  type: 'file' | 'dir' | 'link';
  mode: number;
  data: Buffer;
}
export type Tree = Map<string, Entry>;

export const file = (data: Buffer | string, mode = 0o644): Entry => ({ type: 'file', mode, data: Buffer.from(data) });
const dir = (): Entry => ({ type: 'dir', mode: 0o755, data: Buffer.alloc(0) });
export const link = (target: string): Entry => ({ type: 'link', mode: 0o755, data: Buffer.from(target) });

/** Adds each file's folders, as a zip lists them. */
function withFolders(files: Record<string, Entry>): Tree {
  const tree: Tree = new Map();
  for (const [path, entry] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (!tree.has(parts.slice(0, i).join('/'))) tree.set(parts.slice(0, i).join('/'), dir());
    tree.set(path, entry);
  }
  return tree;
}

function writeTree(root: string, files: Record<string, Buffer | string> | Tree) {
  const entries = files instanceof Map ? [...files] : Object.entries(files).map(([path, data]) => [path, file(data)] as const);
  for (const [path, entry] of entries) {
    const at = join(root, path);
    mkdirSync(dirname(at), { recursive: true });
    if (entry.type === 'dir') mkdirSync(at, { recursive: true });
    else if (entry.type === 'link') symlinkSync(entry.data.toString(), at);
    else writeFileSync(at, entry.data, { mode: entry.mode });
    if (entry.type !== 'link') chmodSync(at, entry.mode);
  }
}

/** A zip as electron-builder writes an app's: Unix modes, files deflated, folders and links stored. */
export function zipOf(entries: [string, Entry][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, entry] of entries) {
    const name = Buffer.from(entry.type === 'dir' ? `${path}/` : path);
    const data = entry.type === 'file' ? deflateRawSync(entry.data) : entry.data;
    const method = entry.type === 'file' ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((({ file: 0o100000, dir: 0o040000, link: 0o120000 })[entry.type] | entry.mode) * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Electron's fuse wire as it ships: nine fuses after the sentinel, version 1. */
export const UPSTREAM_FUSES = '101100011';
/** The wire identity.ts's electronFuses make of it: RunAsNode, NODE_OPTIONS and inspect off, asar checks on. */
export const OUR_FUSES = '000011011';
const fuseWire = (fuses: string) => Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, fuses.length]), Buffer.from(fuses, 'latin1')]);
const plist = (entries: Record<string, string>, more = '') => xml(`<dict>\n${Object.entries(entries).map(([k, v]) => `<key>${k}</key>\n<string>${v}</string>`).join('\n')}${more}\n</dict>`);

/** A small stand-in for Electron's darwin-arm64 zip: its app's layout, linker-signed binaries, and the fuse wire. */
export function fakeElectron(): { zip: Buffer; files: Record<string, Entry> } {
  const bin = (seed: string, extra = Buffer.alloc(0)) => signMachO(linkedMachO(Buffer.concat([createHash('sha512').update(seed).digest(), extra])), undefined, '', {}, 0x400);
  const helper = (kind: string) => ({
    [`Electron.app/Contents/Frameworks/Electron Helper${kind}.app/Contents/Info.plist`]: file(plist({ CFBundleIdentifier: 'com.github.Electron.helper', CFBundleName: `Electron Helper${kind}` })),
    [`Electron.app/Contents/Frameworks/Electron Helper${kind}.app/Contents/MacOS/Electron Helper${kind}`]: file(bin(`helper${kind}`), 0o755),
  });
  const framework = 'Electron.app/Contents/Frameworks/Electron Framework.framework';
  const files: Record<string, Entry> = {
    'Electron.app/Contents/Info.plist': file(plist(
      { CFBundleDisplayName: 'Electron', CFBundleExecutable: 'Electron', CFBundleIconFile: 'electron.icns', CFBundleIdentifier: 'com.github.Electron', CFBundleName: 'Electron', CFBundleShortVersionString: '45.2.1', CFBundleVersion: '45.2.1', LSApplicationCategoryType: 'public.app-category.developer-tools', NSPrincipalClass: 'AtomApplication' },
      '\n<key>NSAppTransportSecurity</key>\n<dict><key>NSAllowsArbitraryLoads</key><true/></dict>',
    )),
    'Electron.app/Contents/PkgInfo': file('APPL????'),
    'Electron.app/Contents/MacOS/Electron': file(bin('main'), 0o755),
    'Electron.app/Contents/Resources/default_app.asar': file('default app'),
    'Electron.app/Contents/Resources/electron.icns': file('icns electron'),
    'Electron.app/Contents/Resources/en.lproj/locale.pak': file('en'),
    [`${framework}/Electron Framework`]: link('Versions/Current/Electron Framework'),
    [`${framework}/Resources`]: link('Versions/Current/Resources'),
    [`${framework}/Versions/Current`]: link('A'),
    [`${framework}/Versions/A/Electron Framework`]: file(bin('framework', fuseWire(UPSTREAM_FUSES)), 0o755),
    [`${framework}/Versions/A/Resources/Info.plist`]: file(plist({ CFBundleIdentifier: 'com.github.Electron.framework' })),
    ...helper(''),
    ...helper(' (GPU)'),
    LICENSE: file('Electron license'),
    'LICENSES.chromium.html': file('<html>licenses</html>'),
    version: file('45.2.1'),
  };
  return { zip: zipOf([...withFolders(files)]), files };
}

export interface FakeBuild {
  /** The pipeline's build: web, main process, and the frontend folder with its installed packages. */
  build: { web: string; electron: string; frontend: string };
  /** The extracted disk image: a volume folder holding the app. */
  volume: string;
  app: string;
  /** The app's files, as zipped and as on the disk image, for a test to change and zip again. */
  tree: Tree;
  /** The inbox folder: manifest.json, Multiscale.dmg, Multiscale.zip and its blockmap. */
  inbox: string;
  /** Electron's own zip, which the app's native code must match. */
  electron: Buffer;
  identity: AppIdentity;
}

/** Zips an app's files as the inbox has them, under the app's folder, and records the zip in the manifest. */
export function writeZip(b: FakeBuild, tree: Tree = b.tree, entries: [string, Entry][] = [[`${b.identity.name}.app`, dir()], ...[...tree].map(([p, e]) => [`${b.identity.name}.app/${p}`, e] as [string, Entry])]) {
  const zip = zipOf(entries);
  writeFileSync(join(b.inbox, 'Multiscale.zip'), zip);
  const manifest = JSON.parse(readFileSync(join(b.inbox, 'manifest.json'), 'utf8')) as { files: Record<string, object> };
  manifest.files['Multiscale.zip'] = { sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length };
  writeFileSync(join(b.inbox, 'manifest.json'), JSON.stringify(manifest));
}

/** Writes the app's files again, on the disk image and in the zip, after a test has changed them. */
export function writeApp(b: FakeBuild) {
  rmSync(b.app, { recursive: true, force: true });
  writeTree(b.app, b.tree);
  writeZip(b);
}

/** The app's build number and version, as electron-build.mjs sets them. */
export const BUILD = 1700000000;
export const APP_VERSION = `0.1.${BUILD}`;
/** The downloads host the app updates from, which its app-update.yml names. */
export const DOWNLOADS = 'https://downloads.example.test';

/**
 * A good build of commit for env: the pipeline's own build, and an inbox holding a signed disk image and a zip of the
 * same app, signed by identity, which holds that build on Electron's own native code. change edits app.asar's files
 * before the app is signed, as a tampered build would be.
 */
export function fakeBuild(identity: Identity, teamId: string, commit: string, env: 'staging' | 'prod', change: (files: Record<string, Buffer | null>) => void = () => {}): FakeBuild {
  const root = mkdtempSync(join(tmpdir(), 'fake-mac-'));
  const app_ = appIdentity(env, 'com.example.multiscale');
  const { name } = app_;
  const version = JSON.stringify({ version: '0.1.0-abc1234', build: BUILD, shell: { electron: '0123456789abcdef', ios: 'fedcba9876543210' } });
  const web = { 'index.html': '<!doctype html>', 'assets/index-abc.js': 'console.log("app")', 'assets/index-abc.js.map': '{}', 'version.json': version };
  const electron = { 'main.cjs': 'require("electron")', 'main.cjs.map': '{}', 'preload.cjs': 'void 0' };
  // better-sqlite3's prebuilt binaries as the package ships them: the arm64 one linker-signed, the x64 one unsigned.
  const arm64 = signMachO(linkedMachO(Buffer.from('sqlite for arm64')), undefined, '', {}, 0x200);
  const x64 = linkedMachO(Buffer.from('sqlite for x64'));
  // As electron-builder packs it, with the scripts the installed package has left out.
  const sqlite = { 'lib/index.js': 'module.exports = 1', 'package.json': '{"name":"better-sqlite3","main":"lib/index.js"}' };
  const installed = { ...sqlite, 'package.json': '{"name":"better-sqlite3","main":"lib/index.js","scripts":{"install":"prebuild-install"}}', 'prebuilds/darwin-arm64.node': arm64, 'prebuilds/darwin-x64.node': x64 };
  const pkg = { name: 'multiscale', version: '0.1.0', type: 'module', main: 'dist-electron/main.cjs', dependencies: { 'better-sqlite3': '^13.0.3', '@multiscale/config': 'file:../config' }, devDependencies: { vite: '1' } };
  const build = { web: join(root, 'web'), electron: join(root, 'electron'), frontend: join(root, 'frontend') };
  writeTree(build.web, web);
  writeTree(build.electron, electron);
  writeTree(build.frontend, { 'package.json': JSON.stringify(pkg), ...Object.fromEntries(Object.entries(installed).map(([p, d]) => [`node_modules/better-sqlite3/${p}`, d])) });

  const files: Record<string, Buffer | null> = {
    ...Object.fromEntries(Object.entries(web).filter(([p]) => !p.endsWith('.map')).map(([p, d]) => [`dist/${p}`, Buffer.from(d)])),
    ...Object.fromEntries(Object.entries(electron).filter(([p]) => !p.endsWith('.map')).map(([p, d]) => [`dist-electron/${p}`, Buffer.from(d)])),
    'package.json': Buffer.from(JSON.stringify({ name: pkg.name, version: APP_VERSION, type: pkg.type, main: pkg.main, dependencies: { 'better-sqlite3': '^13.0.3' } })),
    ...Object.fromEntries([...Object.keys(sqlite), 'prebuilds/darwin-arm64.node', 'prebuilds/darwin-x64.node'].map((p) => [`node_modules/better-sqlite3/${p}`, null])),
  };
  change(files);
  const archive = asar(files);
  const header = archive.subarray(16, 16 + archive.readUInt32LE(12));

  // Electron's app, as electron-builder makes it this app: renamed, its own Info.plists and icon, app.asar for the
  // default app, its fuses set, and every binary signed again.
  const upstream = fakeElectron();
  const files_: Record<string, Entry> = {};
  for (const [path, entry] of Object.entries(upstream.files)) {
    if (!path.startsWith('Electron.app/') || /Resources\/(default_app\.asar|electron\.icns)$/.test(path)) continue;
    const mapped = path.slice('Electron.app/'.length)
      .replace(/^Contents\/MacOS\/Electron$/, `Contents/MacOS/${name}`)
      .replace(/^Contents\/Frameworks\/Electron Helper( \(\w+\))?\.app/, `Contents/Frameworks/${name} Helper$1.app`)
      .replace(/Contents\/MacOS\/Electron Helper( \(\w+\))?$/, `Contents/MacOS/${name} Helper$1`);
    files_[mapped] = entry;
  }
  const unpacked = { ...sqlite, 'prebuilds/darwin-arm64.node': signMachO(arm64, identity, teamId), 'prebuilds/darwin-x64.node': signMachO(x64, identity, teamId) };
  for (const [p, d] of Object.entries(unpacked)) files_[`Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/${p}`] = file(d);
  files_['Contents/Resources/app.asar'] = file(archive);
  files_['Contents/Resources/icon.icns'] = file('icns ours');
  // As electron-builder writes it from the publish setting, with the package's name for the updater's folder.
  const updateConfig = Buffer.from(`provider: generic\nurl: ${DOWNLOADS}\nupdaterCacheDirName: multiscale-updater\n`);
  files_['Contents/Resources/app-update.yml'] = file(updateConfig);
  files_['Contents/Resources/LICENSE.electron.txt'] = upstream.files.LICENSE!;
  files_['Contents/Resources/LICENSES.chromium.html'] = upstream.files['LICENSES.chromium.html']!;
  for (const kind of ['', ' (GPU)']) {
    const at = `Contents/Frameworks/${name} Helper${kind}.app/Contents`;
    files_[`${at}/Info.plist`] = file(plist({ CFBundleDisplayName: `${name} Helper${kind}`, CFBundleExecutable: `${name} Helper${kind}`, CFBundleIdentifier: `${app_.appId}.helper${kind ? `.${kind.slice(2, -1)}` : ''}`, CFBundleName: `Electron Helper${kind}`, CFBundleVersion: String(BUILD) }));
    files_[`${at}/MacOS/${name} Helper${kind}`] = file(signMachO(files_[`${at}/MacOS/${name} Helper${kind}`]!.data, identity, teamId), 0o755);
  }
  const framework = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
  const flipped = Buffer.from(files_[framework]!.data);
  flipped.write(OUR_FUSES, flipped.indexOf(fuseWire(UPSTREAM_FUSES)) + fuseWire(UPSTREAM_FUSES).length - UPSTREAM_FUSES.length, 'latin1');
  files_[framework] = file(signMachO(flipped, identity, teamId), 0o755);
  const sealed = { 'Resources/app.asar': archive, 'Resources/app-update.yml': updateConfig, ...Object.fromEntries(Object.entries(sqlite).map(([p, d]) => [`Resources/app.asar.unpacked/node_modules/better-sqlite3/${p}`, Buffer.from(d)])) };
  const resources = Buffer.from(xml(`<dict>\n<key>files2</key>\n<dict>\n${Object.entries(sealed).map(([p, d]) => `<key>${p}</key>\n<dict><key>hash2</key><data>${sha256(d).toString('base64')}</data></dict>`).join('\n')}\n</dict>\n</dict>`));
  const info = Buffer.from(plist(
    {
      CFBundleDisplayName: name, CFBundleExecutable: name, CFBundleIconFile: 'icon.icns', CFBundleIdentifier: app_.appId, CFBundleName: name,
      CFBundleShortVersionString: APP_VERSION, CFBundleVersion: String(BUILD), LSApplicationCategoryType: 'public.app-category.productivity',
      NSHumanReadableCopyright: `Copyright © 2026 ${name}`, NSPrincipalClass: 'AtomApplication', NSUserNotificationAlertStyle: 'alert',
    },
    `\n<key>CFBundleURLTypes</key>\n<array><dict><key>CFBundleTypeRole</key><string>Editor</string><key>CFBundleURLName</key><string>${name}</string><key>CFBundleURLSchemes</key><array><string>${app_.scheme}</string></array></dict></array>` +
      `\n<key>ElectronAsarIntegrity</key>\n<dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${sha256(header).toString('hex')}</string></dict></dict>` +
      `\n<key>NSAppTransportSecurity</key>\n${ATS}`,
  ));
  files_['Contents/Info.plist'] = file(info);
  files_['Contents/_CodeSignature/CodeResources'] = file(resources);
  files_['Contents/CodeResources'] = file('stapled ticket');
  files_[`Contents/MacOS/${name}`] = file(signMachO(files_[`Contents/MacOS/${name}`]!.data, identity, teamId, { info, resources }), 0o755);
  const tree = withFolders(files_);
  const volume = join(root, 'volume');
  const app = join(volume, name, `${name}.app`);
  writeTree(app, tree);

  const inbox = join(root, 'inbox');
  const dmg = signedDmg(identity, teamId);
  const hash = (data: Buffer) => ({ sha256: createHash('sha256').update(data).digest('hex'), size: data.length });
  const manifest = {
    commit,
    env,
    version: '0.1.0-abc1234',
    build: BUILD,
    appVersion: APP_VERSION,
    electron: '45.2.1',
    shell: '0123456789abcdef',
    files: { 'Multiscale.dmg': hash(dmg), 'app.asar': hash(archive) },
    notarizations: [{ id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Multiscale.zip', status: 'Accepted' }],
  };
  writeTree(inbox, { 'Multiscale.dmg': dmg, 'Multiscale.zip.blockmap': 'blockmap', 'manifest.json': JSON.stringify(manifest) });
  const b = { build, volume, app, tree, inbox, electron: upstream.zip, identity: app_ };
  writeZip(b);
  return b;
}

/** NSAppTransportSecurity as electron-builder writes it. */
const ATS = '<dict><key>NSAllowsArbitraryLoads</key><true/><key>NSAllowsLocalNetworking</key><true/><key>NSExceptionDomains</key><dict>' +
  ['127.0.0.1', 'localhost'].map((host) => `<key>${host}</key><dict><key>NSIncludesSubdomains</key><false/><key>NSTemporaryExceptionAllowsInsecureHTTPLoads</key><true/><key>NSTemporaryExceptionAllowsInsecureHTTPSLoads</key><false/><key>NSTemporaryExceptionMinimumTLSVersion</key><string>1.0</string><key>NSTemporaryExceptionRequiresForwardSecrecy</key><false/></dict>`).join('') +
  '</dict></dict>';
