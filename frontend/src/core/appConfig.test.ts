import { describe, expect, it } from 'vitest';
import { loadAppConfig, loadBundleId, readEnvYaml } from './appConfig';

const dir = '/config-dir';
const outputs = { ApiUrl: 'https://api.example.test/', CognitoDomain: 'https://auth.example.test', AppClientId: 'client-1', TestClientId: 'test-client' };
const files = (entries: Record<string, unknown>) => (path: string) => {
  const value = entries[path];
  return value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
};

describe('loadAppConfig', () => {
  it("reads the environment's stack outputs from the config folder, and tidies trailing slashes", () => {
    expect(loadAppConfig('staging', files({ '/config-dir/staging.outputs.json': outputs }), dir)).toEqual({
      env: 'staging',
      apiUrl: 'https://api.example.test',
      authUrl: 'https://auth.example.test',
      authClientId: 'client-1',
    });
  });

  it('reads where updates and the Mac app download come from, when the environment has its own domain', () => {
    const read = files({ '/config-dir/staging.outputs.json': { ...outputs, ReleaseUrl: 'https://release.example.test/', DownloadsUrl: 'https://downloads.example.test' } });
    expect(loadAppConfig('staging', read, dir)).toMatchObject({ releaseUrl: 'https://release.example.test', downloadsUrl: 'https://downloads.example.test' });
    expect(() => loadAppConfig('staging', files({ '/config-dir/staging.outputs.json': { ...outputs, ReleaseUrl: 'http://release.example.test' } }), dir)).toThrow(
      'ReleaseUrl must use https',
    );
  });

  it('keeps staging and prod apart', () => {
    const read = files({ '/config-dir/staging.outputs.json': outputs, '/config-dir/prod.outputs.json': { ...outputs, AppClientId: 'client-2' } });
    expect(loadAppConfig('prod', read, dir).authClientId).toBe('client-2');
    expect(loadAppConfig('staging', read, dir).authClientId).toBe('client-1');
  });

  it('defaults to local, with built-in defaults and no files at all', () => {
    const none = () => {
      throw new Error('local reads no files');
    };
    expect(loadAppConfig(undefined, none, dir)).toEqual({
      env: 'local',
      apiUrl: 'http://localhost:8787',
      authUrl: 'http://localhost:8787/cognito',
      authClientId: 'local-client',
    });
    expect(loadAppConfig('local', none, dir).env).toBe('local');
  });

  it('names the missing outputs file in full, and how to make it', () => {
    expect(() => loadAppConfig('prod', files({ '/config-dir/staging.outputs.json': outputs }), dir)).toThrow(
      /\/config-dir\/prod\.outputs\.json is missing.*make deploy ENV=prod/,
    );
  });

  it('refuses an unknown environment, control included', () => {
    expect(() => loadAppConfig('production', files({}), dir)).toThrow(/production/);
    expect(() => loadAppConfig('control', files({}), dir)).toThrow(/control/);
  });

  describe('with a local stack URL', () => {
    const read = files({ '/config-dir/staging.outputs.json': outputs });

    it('points a local build at that stack, its sign-in included', () => {
      expect(loadAppConfig('local', read, dir, 'http://127.0.0.1:55001/')).toEqual({
        env: 'local',
        apiUrl: 'http://127.0.0.1:55001',
        authUrl: 'http://127.0.0.1:55001/cognito',
        authClientId: 'local-client',
      });
      expect(loadAppConfig(undefined, read, dir, '').apiUrl).toBe('http://localhost:8787');
    });

    it('refuses it for a deployed environment, and refuses a bad URL', () => {
      expect(() => loadAppConfig('staging', read, dir, 'http://127.0.0.1:55001')).toThrow(/LOCAL_API_URL/);
      expect(() => loadAppConfig('local', read, dir, '127.0.0.1:55001')).toThrow(/LOCAL_API_URL/);
    });
  });

  it.each([
    ['a missing api URL', { ...outputs, ApiUrl: undefined }],
    ['a bad URL', { ...outputs, CognitoDomain: 'not a url' }],
    ['no client id', { ...outputs, AppClientId: '' }],
    ['plain http on a deployment', { ...outputs, ApiUrl: 'http://api.example.test' }],
    ['outputs that are not JSON', '{ApiUrl'],
  ])('refuses %s', (_name, value) => {
    expect(() => loadAppConfig('staging', files({ '/config-dir/staging.outputs.json': value }), dir)).toThrow(/staging\.outputs\.json/);
  });
});

describe('readEnvYaml', () => {
  it("parses the environment's YAML", () => {
    expect(readEnvYaml('staging', files({ '/config-dir/staging.yaml': 'aws:\n  region: us-west-2\n' }), dir)).toEqual({ aws: { region: 'us-west-2' } });
  });

  it('names the missing file in full, and the example to copy', () => {
    expect(() => readEnvYaml('prod', files({}), dir)).toThrow(/\/config-dir\/prod\.yaml is missing.*config\/prod\.example\.yaml/);
  });

  it('refuses YAML that does not parse, or is not a mapping', () => {
    expect(() => readEnvYaml('staging', files({ '/config-dir/staging.yaml': 'aws: [unclosed' }), dir)).toThrow(/staging\.yaml/);
    expect(() => readEnvYaml('staging', files({ '/config-dir/staging.yaml': '- a list' }), dir)).toThrow(/staging\.yaml/);
  });
});

describe('loadBundleId', () => {
  const yaml = (text: string) => files({ '/config-dir/staging.yaml': text });

  it("reads app.bundleId from the environment's YAML", () => {
    expect(loadBundleId('staging', yaml('app:\n  bundleId: com.example.planner\n'), dir)).toBe('com.example.planner');
  });

  it('is unset without an app section, and for local, which has no YAML', () => {
    expect(loadBundleId('staging', yaml('aws: {}\n'), dir)).toBeUndefined();
    expect(loadBundleId('local', files({}), dir)).toBeUndefined();
  });

  it('needs the YAML for a deployed environment', () => {
    expect(() => loadBundleId('staging', files({}), dir)).toThrow(/\/config-dir\/staging\.yaml is missing/);
  });

  it.each(['', 'has spaces', 'nodots', 42])('refuses the bundle id %j', (bundleId) => {
    expect(() => loadBundleId('staging', yaml(`app:\n  bundleId: ${JSON.stringify(bundleId)}\n`), dir)).toThrow(/bundleId/);
  });
});
