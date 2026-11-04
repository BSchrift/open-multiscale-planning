// Builds the Mac app for one environment: ENV=staging npm run electron:build. Pass --dir to skip the disk image.

import { execFileSync } from 'node:child_process';
import { build } from 'electron-builder';
import { builderConfig } from '../electron/identity.ts';
import { compile } from './electron-compile.mjs';

const { config, identity } = await compile();
execFileSync('npx', ['vite', 'build'], { stdio: 'inherit', env: { ...process.env, ENV: config.env } });
const paths = await build({
  config: builderConfig(config.env, identity),
  mac: process.argv.includes('--dir') ? ['dir'] : ['dmg'],
});
console.log(paths.join('\n') || `release/${config.env}`);
