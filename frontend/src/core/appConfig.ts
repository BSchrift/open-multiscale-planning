// Which backend a build talks to. A deployed environment's details come from its folder of config, $MULTISCALE_CONFIG_DIR
// or the repo's config/: <env>.outputs.json, written by make deploy, and <env>.yaml. The local stack needs nothing
// secret, so its details are built in.

import type { EnvConfig } from '@multiscale/config';
import { parse } from 'yaml';
import type { Retention } from './retention';

export type AppEnv = 'local' | 'staging' | 'prod';

export interface AppConfig {
  env: AppEnv;
  apiUrl: string;
  /** The identity provider's base URL, with /oauth2/authorize and /oauth2/token below it. */
  authUrl: string;
  authClientId: string;
  /** The build: the package's version and the commit it was built from, such as 0.1.0-85e85c2. Telemetry reports it. */
  version?: string;
  /** Orders builds: the commit's time in seconds. A downloaded bundle only replaces an older one. */
  build?: number;
  /** Each app's native code this bundle was built against, from scripts/shell-hash.mjs. */
  shell?: { electron: string; ios: string };
  /** Where updates come from: each app's feed and the files it lists (core/updates.ts). Only an environment with its own domain has one. */
  releaseUrl?: string;
  /** Where the Mac app's disk image is, for an update that needs the app itself replaced. */
  downloadsUrl?: string;
  /** Where attachments download from, and upload to: the Mac app's content policy lets the page reach them. */
  filesUrl?: string;
  filesUploadUrl?: string;
  /** This environment's settings from config/env, which the build inlines. */
  settings?: EnvConfig;
  /** This environment's block of config/retention.yaml, which the build adds. */
  retention?: Retention;
}

/** Reads a file by its full path, or gives null when there is none. */
export type ReadFile = (path: string) => string | null;

const LOCAL: Omit<AppConfig, 'env'> = { apiUrl: 'http://localhost:8787', authUrl: 'http://localhost:8787/cognito', authClientId: 'local-client' };

function checkedEnv(envName: string | undefined): AppEnv {
  const env = envName || 'local';
  if (env !== 'local' && env !== 'staging' && env !== 'prod') throw new Error(`Unknown ENV: ${env}. Use local, staging or prod.`);
  return env;
}

function checkedUrl(name: string, value: unknown, env: AppEnv, file: string): string {
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new Error(`${file}: ${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && (env !== 'local' || url.protocol !== 'http:')) throw new Error(`${file}: ${name} must use https`);
  return String(value).replace(/\/+$/, '');
}

/** The stack outputs make deploy wrote for a deployed environment. */
export function readOutputs(env: 'staging' | 'prod', readFile: ReadFile, configDir: string): Record<string, unknown> {
  const file = `${configDir}/${env}.outputs.json`;
  const text = readFile(file);
  if (text === null) throw new Error(`${file} is missing. Run make deploy ENV=${env} to write it.`);
  try {
    const outputs: unknown = JSON.parse(text);
    if (outputs && typeof outputs === 'object' && !Array.isArray(outputs)) return outputs as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new Error(`${file} is not a JSON object`);
}

/** A deployed environment's YAML, parsed. Callers check the keys they use. */
export function readEnvYaml(env: 'staging' | 'prod', readFile: ReadFile, configDir: string): Record<string, unknown> {
  const file = `${configDir}/${env}.yaml`;
  const text = readFile(file);
  if (text === null) throw new Error(`${file} is missing. Copy config/${env}.example.yaml from the repo there and fill it in.`);
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must be a mapping of keys`);
  return value as Record<string, unknown>;
}

/**
 * Read at build time. Throws rather than build an app pointing at the wrong backend. localApiUrl, from LOCAL_API_URL,
 * points a local build at a stack on a port of its own, where cmd/local serves sign-in too, with no file to share.
 */
export function loadAppConfig(envName: string | undefined, readFile: ReadFile, configDir: string, localApiUrl?: string): AppConfig {
  const env = checkedEnv(envName);
  if (localApiUrl && env !== 'local') throw new Error(`LOCAL_API_URL is only for ENV=local, not ${env}`);
  if (env === 'local') {
    if (!localApiUrl) return { env, ...LOCAL };
    const apiUrl = checkedUrl('apiUrl', localApiUrl, env, 'LOCAL_API_URL');
    return { env, apiUrl, authUrl: `${apiUrl}/cognito`, authClientId: LOCAL.authClientId };
  }
  const file = `${configDir}/${env}.outputs.json`;
  const outputs = readOutputs(env, readFile, configDir);
  if (typeof outputs.AppClientId !== 'string' || !outputs.AppClientId) throw new Error(`${file}: AppClientId is missing`);
  return {
    env,
    apiUrl: checkedUrl('ApiUrl', outputs.ApiUrl, env, file),
    authUrl: checkedUrl('CognitoDomain', outputs.CognitoDomain, env, file),
    authClientId: outputs.AppClientId,
    ...(outputs.ReleaseUrl ? { releaseUrl: checkedUrl('ReleaseUrl', outputs.ReleaseUrl, env, file) } : {}),
    ...(outputs.DownloadsUrl ? { downloadsUrl: checkedUrl('DownloadsUrl', outputs.DownloadsUrl, env, file) } : {}),
    ...(outputs.FilesUrl ? { filesUrl: checkedUrl('FilesUrl', outputs.FilesUrl, env, file) } : {}),
    ...(outputs.FilesUploadUrl ? { filesUploadUrl: checkedUrl('FilesUploadUrl', outputs.FilesUploadUrl, env, file) } : {}),
  };
}

/** app.bundleId from a deployed environment's YAML, if it sets one. Local builds use the default. */
export function loadBundleId(envName: string | undefined, readFile: ReadFile, configDir: string): string | undefined {
  const env = checkedEnv(envName);
  if (env === 'local') return undefined;
  const app = readEnvYaml(env, readFile, configDir).app as { bundleId?: unknown } | undefined;
  const bundleId = app?.bundleId;
  if (bundleId === undefined) return undefined;
  if (typeof bundleId !== 'string' || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId)) {
    throw new Error(`${configDir}/${env}.yaml: app.bundleId must be a reverse-DNS id such as com.example.multiscale`);
  }
  return bundleId;
}
