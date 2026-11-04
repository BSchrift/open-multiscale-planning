// Builds the web app for the current ENV and copies it, with the plugin list, into the iOS project.

import { execSync } from 'node:child_process';

execSync('npm run build', { stdio: 'inherit' });
execSync('npx cap sync ios', { stdio: 'inherit' });
