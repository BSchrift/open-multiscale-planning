// Builds the Mac app for one environment: ENV=staging npm run electron:build. Pass --dir to skip the disk image.
// Signed with the keychain's Developer ID, else ad hoc, and notarized when APPLE_API_KEY, APPLE_API_KEY_ID and
// APPLE_API_ISSUER are set, as scripts/release.sh sets them: see scripts/mac-signing.ts.

import { execFileSync } from 'node:child_process';
import { notarize } from '@electron/notarize';
import { build } from 'electron-builder';
import { builderConfig } from '../electron/identity.ts';
import { compile } from './electron-compile.mjs';
import { keychainIdentities, signedConfig, signingIdentity } from './mac-signing.ts';

const { config, identity } = await compile();
// Checked before the slow part, so a key without a Developer ID fails at once.
const signing = signedConfig(builderConfig(config.env, identity), signingIdentity(keychainIdentities()), process.env);
console.log(signing.note);
execFileSync('npx', ['vite', 'build'], { stdio: 'inherit', env: { ...process.env, ENV: config.env } });
// electron-builder notarizes the app and staples its ticket before putting it in the disk image.
const paths = await build({ config: signing.config, mac: process.argv.includes('--dir') ? ['dir'] : ['dmg'] });
const dmg = paths.find((path) => path.endsWith('.dmg'));
if (signing.notarize && dmg) {
  // Then the disk image, which electron-builder only signs. This staples it too.
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  await notarize({ tool: 'notarytool', appPath: dmg, appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER });
  console.log(`Notarized ${dmg}`);
}
console.log(paths.join('\n') || `release/${config.env}`);
