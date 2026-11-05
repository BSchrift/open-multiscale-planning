import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { configDir, loadConfig, loadControl } from '../lib/config.ts';
import { ControlStack } from '../lib/control-stack.ts';
import { SiteStack } from '../lib/site-stack.ts';
import { MultiscaleStack } from '../lib/stack.ts';

const app = new App();
// scripts/deploy.sh sets this, which also requires the real files. Plain synth builds all three from whatever config
// exists, falling back to the examples, with no credentials or Go.
const deploying = app.node.tryGetContext('deploy') as string | undefined;
const names = ['control', 'staging', 'prod'] as const;
if (deploying && !names.some((name) => name === deploying)) throw new Error('deploy must be control, staging or prod');

const dir = configDir();
for (const name of names.filter((n) => !deploying || n === deploying)) {
  const real = Boolean(deploying);
  if (name === 'control') {
    const control = loadControl(dir, real);
    // The delegation role trusts their accounts, so they are needed only when there is a domain.
    const environments = control.dns ? (['staging', 'prod'] as const).map((envName) => loadConfig(envName, dir, real).config) : [];
    const controlStack = new ControlStack(app, 'Multiscale-control', { control, environments });
    if (control.dns) {
      // Deploying control deploys the site first, so make deploy ENV=control covers both.
      controlStack.addDependency(new SiteStack(app, 'Multiscale-site', { control, siteDir: join(import.meta.dirname, '../../site') }));
    }
  } else {
    const { config, control } = loadConfig(name, dir, real);
    new MultiscaleStack(app, `Multiscale-${name}`, {
      envName: name,
      config,
      control,
      backendDist: join(import.meta.dirname, '../../backend/dist'),
      requireBinaries: real,
    });
  }
}
