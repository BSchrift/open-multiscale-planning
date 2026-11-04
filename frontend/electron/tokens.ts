// Sign-in tokens, encrypted with a key the OS keychain holds. The file only ever contains ciphertext.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SecureTokens } from '../src/platform/types';

export interface TokenCrypt {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export function fileTokens(path: string, crypt: TokenCrypt): SecureTokens {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = (values: Record<string, string>) => {
    // Rename so a crash mid-write can't leave a truncated file and sign the user out.
    writeFileSync(`${path}.tmp`, JSON.stringify(values), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  return {
    get: async (key) => {
      const stored = read()[key];
      if (stored === undefined) return null;
      try {
        return crypt.decryptString(Buffer.from(stored, 'base64'));
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      if (!crypt.isEncryptionAvailable()) throw new Error('OS encryption is not available, so the token was not stored');
      write({ ...read(), [key]: crypt.encryptString(value).toString('base64') });
    },
    remove: async (key) => {
      const values = read();
      delete values[key];
      write(values);
    },
  };
}
