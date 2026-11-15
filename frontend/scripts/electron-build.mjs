// Builds the Mac app for one environment: ENV=staging npm run electron:build. Pass --dir to skip the disk image.
// Signed with the keychain's Developer ID, else ad hoc, and notarized when APPLE_API_KEY, APPLE_API_KEY_ID and
// APPLE_API_ISSUER are set, as scripts/release.sh sets them: see scripts/mac-signing.ts.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { notarize } from '@electron/notarize';
import { build } from 'electron-builder';
import { builderConfig } from '../electron/identity.ts';
import { compile } from './electron-compile.mjs';
import { appVersion } from './mac-inbox.ts';
import { keychainIdentities, signedConfig, signingIdentity } from './mac-signing.ts';

const { config, identity } = await compile();
// Checked before the slow part, so a key without a Developer ID fails at once.
const signing = signedConfig(builderConfig(config.env, identity), signingIdentity(keychainIdentities()), process.env);
console.log(signing.note);
execFileSync('npx', ['vite', 'build'], { stdio: 'inherit', env: { ...process.env, ENV: config.env } });
// The app's version is 0.1.<build>, so app versions only go up, as builds do: the app's package.json in app.asar says
// it, which app.getVersion() and so the app's updater read, and Info.plist's CFBundleVersion is the build. Set here,
// not in the hashed builder config, since it changes with every commit.
const { build: buildNumber } = JSON.parse(readFileSync('dist/version.json', 'utf8'));
const version = appVersion(JSON.parse(readFileSync('package.json', 'utf8')).version, buildNumber);
const versioned = { ...signing.config, extraMetadata: { version }, buildVersion: String(buildNumber) };
// electron-builder notarizes the app and staples its ticket before putting it in the disk image and the zip. The zip,
// of the same app, is what the app updates itself from.
const paths = await build({ config: versioned, mac: process.argv.includes('--dir') ? ['dir'] : ['dmg', 'zip'] });
const dmg = paths.find((path) => path.endsWith('.dmg'));
if (signing.notarize && dmg) {
  // Then the disk image, which electron-builder only signs. This staples it too.
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  await notarize({ tool: 'notarytool', appPath: dmg, appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER });
  console.log(`Notarized ${dmg}`);
}
console.log(paths.join('\n') || `release/${config.env}`);
