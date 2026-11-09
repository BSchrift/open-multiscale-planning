// Types for sign-release.mjs, which stays plain JavaScript so the release pipeline's signing step runs it as it comes.
import type { KeyLike } from 'node:crypto';

export function publicKeyOf(key: KeyLike | string | Buffer): string;
export function releaseKeyIn(configDir: string, env: string): string | undefined;
export function packRelease(dist: string, privateKeyPem: string | Buffer): {
  release: string;
  files: { path: string; sha256: string; size: number; from: string }[];
};
export function writeRelease(dist: string, privateKeyPem: string | Buffer, out: string): string;
