import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cdhash, checkCms, codeDirectoryProblems, developerIdProblems, DMG_TRAILER_SLOT, dmgSignature, hasTicket, INFO_PLIST_SLOT, machOSignatures, parseCodeDirectory,
  fuseWires, RESOURCES_SLOT, TICKET_LOOKUP, unsignedCode,
} from './code-signature';
import { linkedMachO, makeIdentity, signedDmg, signedMachO, signMachO, trustOf } from './fake-mac-build';

const TEAM = 'TEAMID0001';
const identity = makeIdentity(TEAM);
const info = Buffer.from('<plist/>');
const resources = Buffer.from('<plist>resources</plist>');

describe('Mach-O signatures', () => {
  const binary = signedMachO(identity, TEAM, { info, resources });
  const [{ slice, signature }] = machOSignatures(binary) as [ReturnType<typeof machOSignatures>[0]];

  it('reads the code directory, with the team it names', () => {
    expect(parseCodeDirectory(signature.codeDirectory)).toMatchObject({ hashType: 2, pageSize: 4096, specialSlots: 7, teamId: TEAM });
  });

  it('finds the code and the files it seals as they were signed', () => {
    expect(codeDirectoryProblems(slice, signature, { [INFO_PLIST_SLOT]: info, [RESOURCES_SLOT]: resources })).toEqual([]);
  });

  it('notices a changed byte of code, a changed sealed file, and a sealed file left out', () => {
    const changed = Buffer.from(slice);
    changed[5000]! ^= 1;
    expect(codeDirectoryProblems(changed, signature, { [INFO_PLIST_SLOT]: info, [RESOURCES_SLOT]: resources })).toEqual(["Page 1 of the code doesn't match its hash"]);
    expect(codeDirectoryProblems(slice, signature, { [INFO_PLIST_SLOT]: info, [RESOURCES_SLOT]: Buffer.from('other') })).toEqual([
      "Special slot 3 of the code directory doesn't match what it hashes",
    ]);
    expect(codeDirectoryProblems(slice, signature, { [INFO_PLIST_SLOT]: info })).toEqual(["Special slot 3 of the code directory doesn't match an empty slot"]);
  });

  it('has OpenSSL check the CMS signature, and refuses one over another code directory', () => {
    const { signer, certificates } = checkCms(signature);
    expect(signer.subject).toContain(`OU=${TEAM}`);
    expect(certificates).toHaveLength(3);
    const other = machOSignatures(signedMachO(identity, TEAM))[0]!.signature;
    expect(() => checkCms({ ...signature, cms: other.cms })).toThrow("The CMS signature over the code directory doesn't verify");
  });

  it('refuses ad hoc code, and code that is not signed or not a 64-bit Mach-O', () => {
    expect(() => checkCms(machOSignatures(signedMachO(undefined, TEAM))[0]!.signature)).toThrow('signed ad hoc');
    const unsigned = Buffer.from(binary.subarray(0, 48));
    unsigned.writeUInt32LE(0, 16);
    expect(() => machOSignatures(unsigned)).toThrow('not signed');
    expect(() => machOSignatures(Buffer.alloc(64))).toThrow('Not a 64-bit Mach-O');
  });

  it('files the cdhash as the code directory hash, cut to 20 bytes', () => {
    expect(cdhash(signature)).toEqual(createHash('sha256').update(signature.codeDirectory).digest().subarray(0, 20));
  });
});

describe('disk image signatures', () => {
  it('hashes the image and its trailer as codesign does, and notices a change', () => {
    const dmg = signedDmg(identity, TEAM);
    const { signature, trailer } = dmgSignature(dmg);
    expect(codeDirectoryProblems(dmg, signature, { [DMG_TRAILER_SLOT]: trailer })).toEqual([]);
    expect(checkCms(signature).signer.subject).toContain(`OU=${TEAM}`);
    const changed = Buffer.from(dmg);
    changed[10]! ^= 1;
    expect(codeDirectoryProblems(changed, signature, { [DMG_TRAILER_SLOT]: trailer })).toEqual(["Page 0 of the code doesn't match its hash"]);
  });

  it('refuses a file that is not a disk image, or an image that is not signed', () => {
    expect(() => dmgSignature(Buffer.alloc(1024))).toThrow('Not a UDIF disk image');
    const unsigned = signedDmg(identity, TEAM);
    unsigned.fill(0, unsigned.length - 512 + 296, unsigned.length - 512 + 312);
    expect(() => dmgSignature(unsigned)).toThrow('not signed');
  });
});

describe('developerIdProblems', () => {
  const { signer, certificates } = checkCms(machOSignatures(signedMachO(identity, TEAM))[0]!.signature);

  it("accepts a Developer ID Application certificate for the team, from the trusted CAs, in date", () => {
    expect(developerIdProblems(signer, certificates, { teamId: TEAM, ...trustOf(identity) })).toEqual([]);
  });

  it('refuses another team, other CAs, a certificate out of date, and one that is not for applications', () => {
    expect(developerIdProblems(signer, certificates, { teamId: 'OTHERTEAM1', ...trustOf(identity) })).toEqual([
      `The signing certificate is for team ${TEAM}, not the configured team`,
    ]);
    expect(developerIdProblems(signer, certificates, { teamId: TEAM, ...trustOf(makeIdentity(TEAM)) })).toEqual(["The signing certificate isn't issued by Apple's Developer ID CA"]);
    expect(developerIdProblems(signer, certificates, { teamId: TEAM, roots: [], intermediates: trustOf(identity).intermediates })).toEqual([
      "The Developer ID CA isn't issued by Apple's root CA",
    ]);
    const later = new Date(Date.now() + 10 * 24 * 3600 * 1000);
    expect(developerIdProblems(signer, certificates, { teamId: TEAM, ...trustOf(identity), now: later })).toHaveLength(3);
    const installer = makeIdentity(TEAM, { application: false });
    const other = checkCms(machOSignatures(signedMachO(installer, TEAM))[0]!.signature);
    expect(developerIdProblems(other.signer, other.certificates, { teamId: TEAM, ...trustOf(installer) })).toEqual([
      'The signing certificate is not a Developer ID Application certificate',
    ]);
  });
});

describe('hasTicket', () => {
  const answer = (body: object, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const hash = Buffer.alloc(20, 0xab);

  it("asks Apple's public lookup for the cdhash's record", async () => {
    let asked: { url: string; body: string } | undefined;
    const request = (async (url: string, init: RequestInit) => {
      asked = { url, body: String(init.body) };
      return new Response(JSON.stringify({ records: [{ recordType: 'DeveloperIDTicket', fields: { signedTicket: { value: 'x' } } }] }));
    }) as unknown as typeof fetch;
    expect(await hasTicket(hash, request)).toBe(true);
    expect(asked).toEqual({ url: TICKET_LOOKUP, body: JSON.stringify({ records: [{ recordName: `2/2/${'ab'.repeat(20)}` }] }) });
  });

  it("says no when Apple has no record, and throws on any other answer", async () => {
    expect(await hasTicket(hash, answer({ records: [{ reason: 'Record not found', serverErrorCode: 'NOT_FOUND' }] }))).toBe(false);
    await expect(hasTicket(hash, answer({}, 503))).rejects.toThrow('answered 503');
    await expect(hasTicket(hash, answer({ records: [{ serverErrorCode: 'THROTTLED' }] }))).rejects.toThrow("doesn't know");
  });
});

describe('unsignedCode', () => {
  const original = signMachO(linkedMachO(Buffer.from('some code')), undefined, '', {}, 0x200);

  it('gives the same code for a binary signed again, ad hoc or with a certificate, and for one first signed', () => {
    expect(unsignedCode(signMachO(original, identity, TEAM)).equals(unsignedCode(original))).toBe(true);
    const unsigned = linkedMachO(Buffer.from('some code'));
    expect(unsignedCode(signMachO(unsigned, identity, TEAM)).equals(unsignedCode(unsigned))).toBe(true);
    // Nothing of the signature is left in what's compared.
    expect(unsignedCode(original).length).toBeLessThan(original.length - 0x200 + 1);
  });

  it('keeps every byte of code, so one changed byte differs', () => {
    const changed = Buffer.from(original);
    changed[200]! ^= 1;
    expect(unsignedCode(signMachO(changed, identity, TEAM)).equals(unsignedCode(original))).toBe(false);
  });

  it('refuses more after the signature, or __LINKEDIT sizes beyond what the signature needs', () => {
    expect(() => unsignedCode(Buffer.concat([original, Buffer.from('more')]))).toThrow('holds more than its code signature after its code');
    const bigger = Buffer.from(original);
    bigger.writeBigUInt64LE(bigger.readBigUInt64LE(32 + 48) + 16n, 32 + 48);
    expect(() => unsignedCode(bigger)).toThrow('maps more of the file into __LINKEDIT than it holds');
    const mapped = Buffer.from(original);
    mapped.writeBigUInt64LE(0x100000n, 32 + 32);
    expect(() => unsignedCode(mapped)).toThrow('maps more memory for __LINKEDIT than its file size needs');
    expect(() => unsignedCode(Buffer.from('cafebabe00000000', 'hex'))).toThrow('universal binary');
  });

  it('zeroes the fuse bytes, which fuseWires reads on their own', () => {
    const wire = Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 3]), Buffer.from('101')]);
    const withFuses = linkedMachO(Buffer.concat([Buffer.from('code'), wire]));
    expect(fuseWires(withFuses).map((w) => [w.version, w.fuses.toString()])).toEqual([[1, '101']]);
    const flipped = Buffer.from(withFuses);
    flipped[flipped.indexOf(wire) + wire.length - 1] = 0x30;
    expect(unsignedCode(flipped).equals(unsignedCode(withFuses))).toBe(true);
  });
});
