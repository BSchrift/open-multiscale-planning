import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileTokens } from './tokens';

// Stands in for safeStorage: reversible, and visibly not the plaintext.
const crypt = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
  decryptString: (b: Buffer) => b.toString().split('').reverse().join(''),
};

describe('tokens file', () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'tokens-')), 'tokens.json');
  });

  it('round trips, and survives reopening', async () => {
    await fileTokens(path, crypt).set('auth.session', 'value-one');
    expect(await fileTokens(path, crypt).get('auth.session')).toBe('value-one');
    expect(await fileTokens(path, crypt).get('other')).toBeNull();
  });

  it('writes no plaintext, and only the owner can read the file', async () => {
    await fileTokens(path, crypt).set('auth.session', 'plain-secret');
    expect(readFileSync(path, 'utf8')).not.toContain('plain-secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('removes one key and keeps the others', async () => {
    const tokens = fileTokens(path, crypt);
    await tokens.set('a', '1');
    await tokens.set('b', '2');
    await tokens.remove('a');
    expect(await tokens.get('a')).toBeNull();
    expect(await tokens.get('b')).toBe('2');
  });

  it('refuses to store anything when the OS offers no encryption', async () => {
    const tokens = fileTokens(path, { ...crypt, isEncryptionAvailable: () => false });
    await expect(tokens.set('a', '1')).rejects.toThrow(/encryption/i);
    expect(() => readFileSync(path)).toThrow();
  });

  it('treats what it cannot decrypt or parse as signed out, so the app asks to sign in again', async () => {
    await fileTokens(path, crypt).set('a', '1');
    const broken = {
      ...crypt,
      decryptString: () => {
        throw new Error('key gone');
      },
    };
    expect(await fileTokens(path, broken).get('a')).toBeNull();
    writeFileSync(path, 'not json');
    expect(await fileTokens(path, crypt).get('a')).toBeNull();
    await fileTokens(path, crypt).set('b', '2');
    expect(await fileTokens(path, crypt).get('b')).toBe('2');
  });
});
