import { describe, expect, it } from 'vitest';
import { ENTITLEMENTS, signedConfig } from '../scripts/mac-signing';
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

  describe('signed on this Mac', () => {
    const developerId = '2222222222222222222222222222222222222222';
    const key = { APPLE_API_KEY: '/config/AuthKey_ABCDE12345.p8', APPLE_API_KEY_ID: 'ABCDE12345', APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555' };

    it('stays ad hoc without a Developer ID, and says why it is not notarized', () => {
      const signed = signedConfig(config, '-', {});
      expect(signed.config).toEqual({ ...config, mac: { ...config.mac, notarize: false } });
      expect(signed.notarize).toBe(false);
      expect(signed.note).toMatch(/ad hoc/);
    });

    it('signs the app and its disk image with the Developer ID, keeping the hardened runtime and fuses', () => {
      const signed = signedConfig(config, developerId, {});
      expect(signed.config.mac).toEqual({ ...config.mac, identity: developerId, entitlements: ENTITLEMENTS, entitlementsInherit: ENTITLEMENTS, notarize: false });
      expect(signed.config.mac.hardenedRuntime).toBe(true);
      expect(signed.config.electronFuses).toEqual(config.electronFuses);
      expect(signed.config).toHaveProperty('dmg', { sign: true });
      expect(signed.note).toMatch(/Not notarizing: APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are not set/);
    });

    it('notarizes when the environment holds the App Store Connect key', () => {
      const signed = signedConfig(config, developerId, key);
      expect([signed.config.mac.notarize, signed.notarize]).toEqual([true, true]);
      expect(signed.note).not.toContain('ABCDE12345');
    });

    it('fails rather than ship an app it was asked to notarize but cannot', () => {
      expect(() => signedConfig(config, '-', key)).toThrow(/no Developer ID Application identity/);
      expect(() => signedConfig(config, developerId, { ...key, APPLE_API_ISSUER: '' })).toThrow(/Set all of APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or none/);
    });
  });

  it('ships the built app without source maps or code the bundles already contain', () => {
    expect(config.files).toEqual(expect.arrayContaining(['dist/**', 'dist-electron/**', '!**/*.map']));
    expect(config.files).toContain('!node_modules/**');
    expect(config.files.filter((f) => f.startsWith('node_modules/')).join()).toMatch(/^node_modules\/better-sqlite3\//);
  });
});
