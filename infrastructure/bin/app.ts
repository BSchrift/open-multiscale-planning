import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { configDir, loadConfig, loadControl } from '../lib/config.ts';
import { ControlStack } from '../lib/control-stack.ts';
import { PipelineStack } from '../lib/pipeline-stack.ts';
import { SiteStack } from '../lib/site-stack.ts';
import { MultiscaleStack } from '../lib/stack.ts';

const app = new App();
// scripts/deploy.sh sets this, which also requires the real files. Plain synth builds all three from whatever config
// exists, falling back to the examples, with no credentials or Go.
const deploying = app.node.tryGetContext('deploy') as string | undefined;
const names = ['control', 'staging', 'prod', 'pipeline'] as const;
if (deploying && !names.some((name) => name === deploying)) throw new Error('deploy must be control, staging, prod or pipeline');
// scripts/deploy.sh sets canary=skip for CANARY=skip: a new backend version takes all traffic at once.
const canary = app.node.tryGetContext('canary') as string | undefined;
if (canary !== undefined && canary !== 'skip') throw new Error('canary must be skip or unset');
// And alarms=off for ALARMS=off: one release ships while a release alarm is firing.
const alarms = app.node.tryGetContext('alarms') as string | undefined;
if (alarms !== undefined && alarms !== 'off') throw new Error('alarms must be off or unset');

const dir = configDir();
for (const name of names.filter((n) => !deploying || n === deploying)) {
  const real = Boolean(deploying);
  if (name === 'pipeline') {
    // In the control account, deploying staging and prod. Only when control.yaml sets it up.
    const control = loadControl(dir, real);
    if (control.pipeline) {
      const environments = { staging: loadConfig('staging', dir, real).config, prod: loadConfig('prod', dir, real).config };
      new PipelineStack(app, 'Multiscale-pipeline', { control: { ...control, pipeline: control.pipeline }, environments });
    } else if (real) {
      throw new Error(`${dir}/control.yaml has no pipeline section. See docs/releasing.md.`);
    }
  } else if (name === 'control') {
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
      canary,
      alarms,
      pipelineAccount: control?.pipeline ? control.aws.account : undefined,
    });
  }
}
