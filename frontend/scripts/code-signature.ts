// Checks Apple code signatures without a Mac, for the release pipeline's check of a Mac app that GitHub Actions built
// (scripts/mac-inbox.ts). It reads the signature of a Mach-O binary or a disk image, checks that its code directory
// hashes what the file holds, has OpenSSL check the CMS signature over that code directory, and checks the signing
// certificate's chain to Apple's Developer ID CA. Apple's notary service is asked whether it notarized the code
// directory's hash, its cdhash.
//
// Why not rcodesign verify: it reads only Mach-O binaries, not disk images or the bundle resources app.asar is sealed
// with, doesn't check the certificate chain, and says itself that it "is known to be buggy and gives misleading
// results". OpenSSL is on the build image already. Only SHA-256 code directories are accepted, which is all codesign
// makes for an app that needs macOS 12 or later, and for disk images.

import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUPERBLOB = 0xfade0cc0;
const CODE_DIRECTORY = 0xfade0c02;
const BLOB_WRAPPER = 0xfade0b01;
const CMS_SLOT = 0x10000;
const SHA256 = 2;
/** Special slots whose contents live outside the signature: Info.plist, CodeResources, and a disk image's trailer. */
export const INFO_PLIST_SLOT = 1;
export const RESOURCES_SLOT = 3;
export const DMG_TRAILER_SLOT = 6;

/** Apple Root CA, which every Developer ID chains to: SHA-256 of the certificate, as apple.com/certificateauthority lists it. */
export const APPLE_ROOT_SHA256 = ['B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24'];
/** Apple's Developer ID Certification Authority and its G2 successor, which issue Developer ID certificates. */
export const DEVELOPER_ID_CA_SHA256 = [
  '7A:FC:9D:01:A6:2F:03:A2:DE:96:37:93:6D:4A:FE:68:09:0D:2D:E1:8D:03:F2:9C:88:CF:B0:B1:BA:63:58:7F',
  'F1:6C:D3:C5:4C:7F:83:CE:A4:BF:1A:3E:6A:08:19:C8:AA:A8:E4:A1:52:8F:D1:44:71:5F:35:06:43:D2:DF:3A',
];
/** The extension Apple puts on a Developer ID Application certificate, 1.2.840.113635.100.6.1.13, as DER. */
const DEVELOPER_ID_APPLICATION = Buffer.from('060a2a864886f7636406010d', 'hex');

export interface Signature {
  /** The code directory, whole, as the CMS signs it and its cdhash hashes it. */
  codeDirectory: Buffer;
  /** The CMS signature over the code directory. Absent when the code is signed ad hoc. */
  cms?: Buffer;
  /** Every other blob in the signature, by slot, for the special slots that hash them. */
  blobs: Map<number, Buffer>;
  /** Where the signed code ends: the code directory hashes everything before it. */
  codeLimit: number;
}

export interface CodeDirectory {
  hashType: number;
  hashSize: number;
  pageSize: number;
  codeLimit: number;
  specialSlots: number;
  codeSlots: number;
  hashOffset: number;
  identifier: string;
  teamId?: string;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();

function cString(data: Buffer, offset: number): string {
  const end = data.indexOf(0, offset);
  return data.subarray(offset, end < 0 ? data.length : end).toString('utf8');
}

/** The blobs of a signature's superblob, by slot. */
function superblob(data: Buffer): Map<number, Buffer> {
  if (data.length < 12 || data.readUInt32BE(0) !== SUPERBLOB) throw new Error('The code signature is not a signature superblob');
  const blobs = new Map<number, Buffer>();
  const count = data.readUInt32BE(8);
  for (let i = 0; i < count; i++) {
    const slot = data.readUInt32BE(12 + 8 * i);
    const offset = data.readUInt32BE(16 + 8 * i);
    const length = data.readUInt32BE(offset + 4);
    if (offset + length > data.length) throw new Error(`The code signature's blob in slot ${slot} runs past its end`);
    blobs.set(slot, data.subarray(offset, offset + length));
  }
  return blobs;
}

function signatureFrom(data: Buffer, codeLimit: number): Signature {
  const blobs = superblob(data);
  // The CMS signs the code directory in slot 0. A signature that leads with a SHA-1 one, for systems older than macOS
  // 10.11.4, binds its SHA-256 alternate only through a signed attribute, which this check doesn't read.
  const codeDirectory = blobs.get(0);
  if (!codeDirectory || codeDirectory.readUInt32BE(0) !== CODE_DIRECTORY) throw new Error('The code signature has no code directory');
  if (codeDirectory[37] !== SHA256) throw new Error("The code signature's code directory is not SHA-256");
  const wrapper = blobs.get(CMS_SLOT);
  // An ad hoc signature's wrapper is empty.
  const cms = wrapper && wrapper.readUInt32BE(0) === BLOB_WRAPPER && wrapper.length > 8 ? wrapper.subarray(8) : undefined;
  return { codeDirectory, cms, blobs, codeLimit };
}

/** The signature of each architecture in a Mach-O binary, thin or universal, with the slice it signs. */
export function machOSignatures(file: Buffer): { slice: Buffer; signature: Signature }[] {
  const magic = file.readUInt32BE(0);
  if (magic === 0xcafebabe) {
    // Universal: big-endian arch entries of five 32-bit fields after the count.
    return Array.from({ length: file.readUInt32BE(4) }, (_, i) => {
      const offset = file.readUInt32BE(8 + 20 * i + 8);
      const size = file.readUInt32BE(8 + 20 * i + 12);
      return machOSignatures(file.subarray(offset, offset + size))[0]!;
    });
  }
  if (file.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Not a 64-bit Mach-O binary');
  const commands = file.readUInt32LE(16);
  let offset = 32;
  for (let i = 0; i < commands; i++) {
    const command = file.readUInt32LE(offset);
    if (command === 0x1d) {
      // LC_CODE_SIGNATURE: the signature is at the end, and everything before it is signed.
      const dataOffset = file.readUInt32LE(offset + 8);
      const dataSize = file.readUInt32LE(offset + 12);
      return [{ slice: file, signature: signatureFrom(file.subarray(dataOffset, dataOffset + dataSize), dataOffset) }];
    }
    offset += file.readUInt32LE(offset + 4);
  }
  throw new Error('The Mach-O binary is not signed');
}

/** A disk image's signature, which its UDIF trailer points to, and the trailer as the code directory hashes it. */
export function dmgSignature(file: Buffer): { signature: Signature; trailer: Buffer } {
  const trailer = Buffer.from(file.subarray(file.length - 512));
  if (trailer.subarray(0, 4).toString('latin1') !== 'koly') throw new Error('Not a UDIF disk image');
  const offset = Number(trailer.readBigUInt64BE(296));
  const size = Number(trailer.readBigUInt64BE(304));
  if (offset === 0 || size === 0) throw new Error('The disk image is not signed');
  if (offset + size > file.length - 512) throw new Error("The disk image's signature runs into its trailer");
  // codesign hashes the trailer with the signature's offset in place but its size still zero, as it was when hashed.
  trailer.writeBigUInt64BE(0n, 304);
  return { signature: signatureFrom(file.subarray(offset, offset + size), offset), trailer };
}

export function parseCodeDirectory(cd: Buffer): CodeDirectory {
  const version = cd.readUInt32BE(8);
  const teamOffset = version >= 0x20200 ? cd.readUInt32BE(48) : 0;
  if (version >= 0x20300 && cd.readBigUInt64BE(56) !== 0n) throw new Error('The code directory uses a 64-bit code limit, which this check does not read');
  return {
    hashOffset: cd.readUInt32BE(16),
    identifier: cString(cd, cd.readUInt32BE(20)),
    specialSlots: cd.readUInt32BE(24),
    codeSlots: cd.readUInt32BE(28),
    codeLimit: cd.readUInt32BE(32),
    hashSize: cd[36]!,
    hashType: cd[37]!,
    // As a power of two; 0 hashes the code as one page.
    pageSize: cd[39]! === 0 ? 0 : 2 ** cd[39]!,
    ...(teamOffset ? { teamId: cString(cd, teamOffset) } : {}),
  };
}

/** The cdhash Apple's tickets are filed under: the code directory's SHA-256, cut to 20 bytes. */
export const cdhash = (signature: Signature) => sha256(signature.codeDirectory).subarray(0, 20);

/**
 * Problems with the code directory's hashes of code, the bytes before the signature, and of its special slots: the
 * external files given by slot, and the signature's own blobs. An empty list means the code directory describes this
 * code exactly. It says nothing about who signed it: see checkCms.
 */
export function codeDirectoryProblems(code: Buffer, signature: Signature, external: Record<number, Buffer> = {}): string[] {
  const cd = parseCodeDirectory(signature.codeDirectory);
  if (cd.hashType !== SHA256 || cd.hashSize !== 32) return ['The code directory is not SHA-256'];
  if (cd.codeLimit !== signature.codeLimit) return [`The code directory hashes ${cd.codeLimit} bytes, but the signature starts at ${signature.codeLimit}`];
  const problems: string[] = [];
  const page = cd.pageSize || cd.codeLimit;
  if (cd.codeSlots !== Math.ceil(cd.codeLimit / page)) problems.push(`The code directory hashes ${cd.codeSlots} pages of code that needs ${Math.ceil(cd.codeLimit / page)}`);
  const slot = (n: number) => signature.codeDirectory.subarray(cd.hashOffset + n * cd.hashSize, cd.hashOffset + (n + 1) * cd.hashSize);
  for (let i = 0; i < cd.codeSlots; i++) {
    if (!slot(i).equals(sha256(code.subarray(i * page, Math.min((i + 1) * page, cd.codeLimit))))) {
      problems.push(`Page ${i} of the code doesn't match its hash`);
      break;
    }
  }
  for (let n = 1; n <= cd.specialSlots; n++) {
    const contents = external[n] ?? signature.blobs.get(n);
    const expected = contents ? sha256(contents) : Buffer.alloc(cd.hashSize);
    if (!slot(-n).equals(expected)) problems.push(`Special slot ${n} of the code directory doesn't match ${contents ? 'what it hashes' : 'an empty slot'}`);
  }
  for (const n of Object.keys(external).map(Number)) {
    if (n > cd.specialSlots) problems.push(`The code directory has no special slot ${n} to seal what it should`);
  }
  return problems;
}

/**
 * Has OpenSSL check the CMS signature over the code directory, and returns the certificate that made it with the others
 * the signature carries. Throws when the signature doesn't verify. The chain is checked by checkDeveloperId.
 */
export function checkCms(signature: Signature, openssl = 'openssl'): { signer: X509Certificate; certificates: X509Certificate[] } {
  if (!signature.cms) throw new Error('The code is signed ad hoc, not with a certificate');
  const dir = mkdtempSync(join(tmpdir(), 'cms-'));
  try {
    writeFileSync(join(dir, 'cms.der'), signature.cms);
    writeFileSync(join(dir, 'cd'), signature.codeDirectory);
    const args = ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'cms.der'), '-content', join(dir, 'cd'), '-noverify'];
    try {
      execFileSync(openssl, [...args, '-signer', join(dir, 'signer.pem'), '-certsout', join(dir, 'certs.pem'), '-out', join(dir, 'out')], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`The CMS signature over the code directory doesn't verify: ${String((error as { stderr?: Buffer }).stderr ?? error).trim().split('\n')[0]}`);
    }
    const pems = (file: string) => readFileSync(join(dir, file), 'utf8').match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? [];
    const [signer] = pems('signer.pem').map((pem) => new X509Certificate(pem));
    if (!signer) throw new Error('The CMS signature names no signer');
    return { signer, certificates: pems('certs.pem').map((pem) => new X509Certificate(pem)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Trust {
  teamId: string;
  roots: string[];
  intermediates: string[];
  now?: Date;
}

/**
 * Problems with the signer's chain: it must be a Developer ID Application certificate for the team, issued by one of
 * Apple's Developer ID CAs, issued by Apple's root, every one in date. The certificates are the ones the signature
 * carries, which codesign includes up to the root; the pinned fingerprints are what make them Apple's.
 */
export function developerIdProblems(signer: X509Certificate, certificates: X509Certificate[], trust: Trust): string[] {
  const now = trust.now ?? new Date();
  const issuerOf = (cert: X509Certificate) => certificates.find((c) => c.fingerprint256 !== cert.fingerprint256 && cert.checkIssued(c) && cert.verify(c.publicKey));
  const problems: string[] = [];
  const intermediate = issuerOf(signer);
  const root = intermediate && issuerOf(intermediate);
  if (!intermediate || !trust.intermediates.includes(intermediate.fingerprint256)) problems.push("The signing certificate isn't issued by Apple's Developer ID CA");
  else if (!root || !trust.roots.includes(root.fingerprint256)) problems.push("The Developer ID CA isn't issued by Apple's root CA");
  for (const cert of [signer, intermediate, root]) {
    if (cert && (now < new Date(cert.validFrom) || now > new Date(cert.validTo))) problems.push(`${cert.subject.split('\n').find((l) => l.startsWith('CN=')) ?? 'A certificate'} is out of date`);
  }
  if (!signer.raw.includes(DEVELOPER_ID_APPLICATION)) problems.push('The signing certificate is not a Developer ID Application certificate');
  const team = /^OU=(.*)$/m.exec(signer.subject)?.[1];
  if (team !== trust.teamId) problems.push(`The signing certificate is for team ${team ?? 'none'}, not the configured team`);
  return problems;
}

/** The address of Apple's public ticket lookup, which stapler and Gatekeeper use. */
export const TICKET_LOOKUP = 'https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup';

/** Whether Apple's notary service has a ticket for this cdhash. Throws when Apple's answer is neither. */
export async function hasTicket(hash: Buffer, request: typeof fetch = fetch): Promise<boolean> {
  const recordName = `2/2/${hash.toString('hex')}`;
  const response = await request(TICKET_LOOKUP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: [{ recordName }] }) });
  if (!response.ok) throw new Error(`Apple's ticket lookup answered ${response.status}`);
  const record = ((await response.json()) as { records?: { recordType?: string; fields?: { signedTicket?: unknown }; serverErrorCode?: string }[] }).records?.[0];
  if (record?.recordType === 'DeveloperIDTicket' && record.fields?.signedTicket) return true;
  if (record?.serverErrorCode === 'NOT_FOUND') return false;
  throw new Error(`Apple's ticket lookup gave an answer this check doesn't know: ${JSON.stringify(record)}`);
}
