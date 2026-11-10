// Test fixtures for code-signature.ts and mac-inbox.ts, made at test time: a certificate chain shaped like Apple's
// Developer ID chain, Mach-O binaries and disk images signed with it in codesign's format, and a Mac app with its
// app.asar beside the build it should match. OpenSSL makes the keys and the CMS signatures. Nothing here is a real key
// or certificate, and none of it is committed.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

function writeTree(root: string, files: Record<string, Buffer | string>) {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
}

export interface FakeBuild {
  /** The pipeline's build: web, main process, and the frontend folder with its installed packages. */
  build: { web: string; electron: string; frontend: string };
  /** The extracted disk image: a volume folder holding the app. */
  volume: string;
  app: string;
  /** The inbox folder: manifest.json and Multiscale.dmg. */
  inbox: string;
}

/**
 * A good build of commit for env: the pipeline's own build, and an inbox holding a signed disk image whose app, signed
 * by identity, holds that build. change edits the app's files before it is signed, as a tampered build would be.
 */
export function fakeBuild(identity: Identity, teamId: string, commit: string, env: 'staging' | 'prod', change: (files: Record<string, Buffer | null>) => void = () => {}): FakeBuild {
  const root = mkdtempSync(join(tmpdir(), 'fake-mac-'));
  const version = JSON.stringify({ version: '0.1.0-abc1234', build: 1700000000, shell: { electron: '0123456789abcdef', ios: 'fedcba9876543210' } });
  const web = { 'index.html': '<!doctype html>', 'assets/index-abc.js': 'console.log("app")', 'assets/index-abc.js.map': '{}', 'version.json': version };
  const electron = { 'main.cjs': 'require("electron")', 'main.cjs.map': '{}', 'preload.cjs': 'void 0' };
  // As electron-builder packs it, with the scripts the installed package has left out.
  const sqlite = { 'lib/index.js': 'module.exports = 1', 'package.json': '{"name":"better-sqlite3","main":"lib/index.js"}', 'prebuilds/darwin-arm64.node': 'native' };
  const installed = { ...sqlite, 'package.json': '{"name":"better-sqlite3","main":"lib/index.js","scripts":{"install":"prebuild-install"}}' };
  const pkg = { name: 'multiscale', version: '0.1.0', type: 'module', main: 'dist-electron/main.cjs', dependencies: { 'better-sqlite3': '^13.0.3', '@multiscale/config': 'file:../config' }, devDependencies: { vite: '1' } };
  const build = { web: join(root, 'web'), electron: join(root, 'electron'), frontend: join(root, 'frontend') };
  writeTree(build.web, web);
  writeTree(build.electron, electron);
  writeTree(build.frontend, { 'package.json': JSON.stringify(pkg), ...Object.fromEntries(Object.entries(installed).map(([p, d]) => [`node_modules/better-sqlite3/${p}`, d])) });

  const files: Record<string, Buffer | null> = {
    ...Object.fromEntries(Object.entries(web).filter(([p]) => !p.endsWith('.map')).map(([p, d]) => [`dist/${p}`, Buffer.from(d)])),
    ...Object.fromEntries(Object.entries(electron).filter(([p]) => !p.endsWith('.map')).map(([p, d]) => [`dist-electron/${p}`, Buffer.from(d)])),
    'package.json': Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version, type: pkg.type, main: pkg.main, dependencies: { 'better-sqlite3': '^13.0.3' } })),
    ...Object.fromEntries(Object.keys(sqlite).map((p) => [`node_modules/better-sqlite3/${p}`, null])),
  };
  change(files);
  const volume = join(root, 'volume');
  const app = join(volume, `Multiscale ${env}`, 'Multiscale.app');
  const unpacked = Object.fromEntries(Object.entries(sqlite).map(([p, d]) => [`Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/${p}`, d]));
  const archive = asar(files);
  writeTree(app, { 'Contents/Resources/app.asar': archive, ...unpacked });
  const sealed = { 'Resources/app.asar': archive, ...Object.fromEntries(Object.entries(sqlite).map(([p, d]) => [`Resources/app.asar.unpacked/node_modules/better-sqlite3/${p}`, Buffer.from(d)])) };
  const resources = Buffer.from(xml(`<dict>\n<key>files2</key>\n<dict>\n${Object.entries(sealed).map(([p, d]) => `<key>${p}</key>\n<dict><key>hash2</key><data>${sha256(d).toString('base64')}</data></dict>`).join('\n')}\n</dict>\n</dict>`));
  const info = Buffer.from(xml('<dict>\n<key>CFBundleExecutable</key>\n<string>Multiscale</string>\n<key>CFBundleIdentifier</key>\n<string>com.example.multiscale</string>\n</dict>'));
  writeTree(app, { 'Contents/Info.plist': info, 'Contents/_CodeSignature/CodeResources': resources, 'Contents/MacOS/Multiscale': signedMachO(identity, teamId, { info, resources }) });

  const inbox = join(root, 'inbox');
  const dmg = signedDmg(identity, teamId);
  const hash = (data: Buffer) => ({ sha256: createHash('sha256').update(data).digest('hex'), size: data.length });
  const manifest = {
    commit,
    env,
    version: '0.1.0-abc1234',
    build: 1700000000,
    electron: '45.2.1',
    shell: '0123456789abcdef',
    files: { 'Multiscale.dmg': hash(dmg), 'app.asar': hash(archive) },
    notarizations: [{ id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Multiscale.zip', status: 'Accepted' }],
  };
  writeTree(inbox, { 'Multiscale.dmg': dmg, 'manifest.json': JSON.stringify(manifest) });
  return { build, volume, app, inbox };
}
