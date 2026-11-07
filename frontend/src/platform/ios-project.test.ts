// A free personal team can't sign an app that asks for capabilities it isn't entitled to, and the failure only shows
// up when installing on a phone. These read the Xcode project, so that shows up here instead.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = join(import.meta.dirname, '../../ios/App');
const read = (path: string) => readFileSync(join(app, path), 'utf8');
const setting = (config: string, name: string) => new RegExp(`^${name} =[ ]?(.*)$`, 'm').exec(config)?.[1];

describe('the iOS project', () => {
  const config = read('Config.xcconfig');
  const project = read('App.xcodeproj/project.pbxproj');
  const info = read('App/Info.plist');

  it('has the extensions off by default, and the default bundle id', () => {
    expect(setting(config, 'MULTISCALE_EXTENSIONS')).toBe('NO');
    expect(setting(config, 'MULTISCALE_BUNDLE_ID')).toBe('io.github.bschrift.multiscale');
  });

  it('reads overrides from a local file after the defaults, with an example to copy', () => {
    expect(config.indexOf('#include? "Config.local.xcconfig"')).toBeGreaterThan(config.indexOf('MULTISCALE_EXTENSIONS = NO'));
    expect(existsSync(join(app, 'Config.example.xcconfig'))).toBe(true);
  });

  it('gives no target any entitlements while the extensions are off', () => {
    expect(setting(config, 'MULTISCALE_ENTITLEMENTS_NO')).toBe('');
    for (const [, value] of project.matchAll(/CODE_SIGN_ENTITLEMENTS = (.*);/g)) {
      expect(value).toBe('"$(MULTISCALE_ENTITLEMENTS_$(MULTISCALE_EXTENSIONS))"');
    }
  });

  it('asks only for an App Group once on, and nothing a phone install would need extra provisioning for', () => {
    const entitlements = read('Shared/AppGroup.entitlements');
    expect([...entitlements.matchAll(/<key>(.*)<\/key>/g)].map((m) => m[1])).toEqual(['com.apple.security.application-groups']);
    expect(info).not.toContain('UIBackgroundModes');
    expect(project).not.toMatch(/SystemCapabilities|com\.apple\.(Push|InAppPurchase|Keychain)/);
  });

  it('never signs the share extension, or commits a team, while it is off', () => {
    expect(setting(config, 'MULTISCALE_SIGN_EXTENSIONS_NO')).toBe('NO');
    expect(project.match(/CODE_SIGNING_ALLOWED = "\$\(MULTISCALE_SIGN_EXTENSIONS_\$\(MULTISCALE_EXTENSIONS\)\)"/g)).toHaveLength(2);
    expect(project).not.toContain('DEVELOPMENT_TEAM');
    expect(project).not.toContain('Embed App Extensions');
  });

  // It only opens the app, in the app's own process, so it needs no App Group and a free personal team can sign it.
  it('builds in the Control Center capture button by default, signed and embedded with no entitlements', () => {
    expect(setting(config, 'MULTISCALE_CONTROL')).toBe('YES');
    expect(project.match(/CODE_SIGNING_ALLOWED = "\$\(MULTISCALE_SIGN_EXTENSIONS_\$\(MULTISCALE_CONTROL\)\)"/g)).toHaveLength(2);
    const widget = [...project.matchAll(/buildSettings = \{([^}]*)\};/g)].map((m) => m[1]!).filter((b) => b.includes('CaptureWidget/Info.plist'));
    expect(widget).toHaveLength(2);
    for (const b of widget) expect(b).not.toContain('CODE_SIGN_ENTITLEMENTS');
    expect(project).toContain('MultiscaleCapture.appex');
    expect(project).toMatch(/MULTISCALE_CONTROL\\" = YES \]; then\\n  cp -R \\"\$BUILT_PRODUCTS_DIR\/MultiscaleCapture\.appex/);
  });

  // A fixed white launch image or web view background would flash white before a dark page, and the status bar
  // would keep the phone's style under a page set to the other one.
  it('follows the phone’s light or dark from launch, and the page’s own choice reaches the status bar', () => {
    const launch = read('App/Base.lproj/LaunchScreen.storyboard');
    expect(launch).not.toContain('image=');
    expect(launch).toMatch(/<view key="view"[^>]*>\s*<rect[^>]*\/>\s*(<autoresizingMask[^>]*\/>\s*)?<color key="backgroundColor" systemColor="systemBackgroundColor"\/>/);
    const capacitor = JSON.parse(readFileSync(join(app, '../../capacitor.config.json'), 'utf8')) as Record<string, { backgroundColor?: string }>;
    expect(capacitor.backgroundColor ?? capacitor.ios?.backgroundColor).toBeUndefined();

    const bridge = read('App/BridgeViewController.swift');
    expect(bridge).toContain('registerPluginInstance(AppearancePlugin())');
    expect(bridge).toContain('let jsName = "MultiscaleAppearance"');
    expect(bridge).toMatch(/window\?\.overrideUserInterfaceStyle = /);
    expect(bridge).toContain('setNeedsStatusBarAppearanceUpdate()');
  });

  it('shows as Multiscale and answers the sign-in scheme', () => {
    expect(info).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Multiscale<\/string>/);
    expect(info).toMatch(/<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>multiscale<\/string>/);
  });
});
