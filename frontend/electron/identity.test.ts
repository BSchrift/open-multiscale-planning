import { describe, expect, it } from 'vitest';
import { appIdentity, builderConfig } from './identity';

describe('appIdentity', () => {
  it('prod is plain Multiscale', () => {
    expect(appIdentity('prod')).toEqual({ name: 'Multiscale', appId: 'io.github.bschrift.multiscale', scheme: 'multiscale' });
  });

  it('other environments install side by side, with their own data and sign-in return', () => {
    expect(appIdentity('staging')).toEqual({
      name: 'Multiscale Staging',
      appId: 'io.github.bschrift.multiscale.staging',
      scheme: 'multiscale-staging',
    });
    expect(appIdentity('local').scheme).toBe('multiscale-local');
  });

  it('the bundle id can be overridden', () => {
    expect(appIdentity('staging', 'com.example.tasks').appId).toBe('com.example.tasks.staging');
  });
});

describe('builderConfig', () => {
  const config = builderConfig('staging', appIdentity('staging'));

  it('names the app, its bundle id and its sign-in scheme for the environment', () => {
    expect(config.productName).toBe('Multiscale Staging');
    expect(config.appId).toBe('io.github.bschrift.multiscale.staging');
    expect(config.protocols).toEqual([{ name: 'Multiscale Staging', schemes: ['multiscale-staging'] }]);
    expect(config.directories.output).toBe('release/staging');
  });

  it('builds a Mac app with no signing identity, and publishes nothing', () => {
    expect(config.mac.identity).toBe('-');
    expect(config.publish).toBeNull();
  });

  it('locks the packaged binary so other code cannot run inside it to read the stored sign-in', () => {
    expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.electronFuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
  });

  it('ships the built app without source maps or code the bundles already contain', () => {
    expect(config.files).toEqual(expect.arrayContaining(['dist/**', 'dist-electron/**', '!**/*.map']));
    expect(config.files).toContain('!node_modules/**');
    expect(config.files.filter((f) => f.startsWith('node_modules/')).join()).toMatch(/^node_modules\/better-sqlite3\//);
  });
});
