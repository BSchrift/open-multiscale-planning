import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cdhash, checkCms, codeDirectoryProblems, developerIdProblems, DMG_TRAILER_SLOT, dmgSignature, hasTicket, INFO_PLIST_SLOT, machOSignatures, parseCodeDirectory,
  RESOURCES_SLOT, TICKET_LOOKUP,
} from './code-signature';
import { makeIdentity, signedDmg, signedMachO, trustOf } from './fake-mac-build';

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
