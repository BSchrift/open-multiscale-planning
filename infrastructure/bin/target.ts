// Prints "<account> <region> <profile>" of one live environment for the shell scripts, after checking its whole config,
// so a missing file or an example value stops them before they build or call anything.
// Usage: node bin/target.ts <control|staging|prod|pipeline>. The pipeline runs in the control account.

import { configDir, loadConfig, loadControl } from '../lib/config.ts';
import type { EnvName } from '../lib/config.ts';

const [name] = process.argv.slice(2);
try {
  const { aws } = name === 'control' || name === 'pipeline' ? loadControl(configDir(), true) : loadConfig(name as EnvName, configDir(), true).config;
  console.log(`${aws.account} ${aws.region} ${aws.profile}`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
