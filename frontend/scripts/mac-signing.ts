// How the Mac app is signed and notarized. A Developer ID in the keychain signs it, else it's signed ad hoc so anyone
// can build it; an App Store Connect key in the environment notarizes it. scripts/release.sh reads that key from the
// config folder:
//   node scripts/mac-signing.ts env <config folder>   prints the key's exports for release.sh to eval, or nothing
// None of this is in electron/, so none of it is in the Mac app's shell hash (scripts/shell-hash.ts): a signature
// changes nothing a downloaded bundle can call, so apps signed one way keep taking bundles built on a Mac signed another.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** What a Developer ID build is allowed under the hardened runtime. Ad hoc builds keep electron-builder's defaults. */
export const ENTITLEMENTS = join(import.meta.dirname, 'entitlements.mac.plist');

const NOTARIZE_KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] as const;
/** The App Store Connect key as electron-builder reads it: the .p8 file's path, its key id, and its issuer id. */
export type NotarizeEnv = Record<(typeof NOTARIZE_KEYS)[number], string>;

/** The hash of the first Developer ID Application identity in `security find-identity` output, else - for ad hoc. */
export function signingIdentity(identities: string): string {
  const line = identities.split('\n').find((l) => l.includes('"Developer ID Application: '));
  return line?.match(/\b[0-9A-F]{40}\b/)?.[0] ?? '-';
}

/** This Mac's code signing identities. Empty where there's no keychain to ask. */
export function keychainIdentities(): string {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * The key in the config folder: AuthKey_<key id>.p8, as App Store Connect names it on download, and its issuer id in
 * asc-issuer-id beside it. Null when there's neither. Errors name what's wrong, never what the files hold.
 */
export function notarizeEnv(dir: string): NotarizeEnv | null {
  const keys = existsSync(dir) ? readdirSync(dir).filter((name) => /^AuthKey_.*\.p8$/.test(name)) : [];
  const issuerFile = join(dir, 'asc-issuer-id');
  if (keys.length === 0 && !existsSync(issuerFile)) return null;
  const problems: string[] = [];
  const keyId = keys.length === 1 ? /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(keys[0]!)?.[1] : undefined;
  if (keys.length === 0) problems.push('asc-issuer-id needs its key, AuthKey_<key id>.p8, beside it');
  else if (keys.length > 1) problems.push(`holds ${keys.length} AuthKey_*.p8 files, so keep only the one that notarizes`);
  else if (!keyId) problems.push('the key must be named AuthKey_<key id>.p8, as App Store Connect names it');
  const issuer = existsSync(issuerFile) ? readFileSync(issuerFile, 'utf8').trim() : '';
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issuer)) {
    problems.push('asc-issuer-id must hold the issuer id from App Store Connect > Users and Access > Integrations');
  }
  if (problems.length > 0 || !keyId) throw new Error(`${dir}: ${problems.join('; ')}`);
  return { APPLE_API_KEY: join(dir, keys[0]!), APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer };
}

/** Shell lines exporting the key, quoted so that any folder name survives eval. */
export function exportLines(env: NotarizeEnv | null): string {
  if (!env) return '';
  return NOTARIZE_KEYS.map((name) => `export ${name}='${env[name].replaceAll("'", `'\\''`)}'\n`).join('');
}

/**
 * builderConfig's ad hoc Mac settings, signed with identity (from signingIdentity) and notarized when env holds the
 * key. note says which, for the build's output.
 */
export function signedConfig<T extends { mac: object }>(config: T, identity: string, env: Partial<Record<string, string>>) {
  const set = NOTARIZE_KEYS.filter((name) => env[name]);
  if (set.length > 0 && set.length < NOTARIZE_KEYS.length) throw new Error('Set all of APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or none');
  const notarize = set.length > 0;
  if (identity === '-') {
    if (notarize) throw new Error("The keychain has no Developer ID Application identity, so the app can't be notarized");
    const note = 'Signed ad hoc, since the keychain has no Developer ID Application identity. Not notarized.';
    // notarize false only quiets electron-builder's own skip warning, which the note replaces.
    return { config: { ...config, mac: { ...config.mac, notarize: false } }, notarize, note };
  }
  const signed = {
    ...config,
    mac: { ...config.mac, identity, entitlements: ENTITLEMENTS, entitlementsInherit: ENTITLEMENTS, notarize },
    // Signed too, so it can be notarized and macOS opens the download without asking.
    dmg: { sign: true },
  };
  const note = notarize
    ? 'Signing with the Developer ID and notarizing the app and its disk image.'
    : 'Signing with the Developer ID. Not notarizing: APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are not set, as scripts/release.sh sets them from the config folder.';
  return { config: signed, notarize, note };
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  const [command, dir] = process.argv.slice(2);
  if (command !== 'env' || !dir) {
    console.error('Use: mac-signing.ts env <config folder>');
    process.exit(1);
  }
  try {
    process.stdout.write(exportLines(notarizeEnv(dir)));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
