// Saves one stack's entry from `cdk deploy --outputs-file` as <config dir>/<env>.outputs.json, which app builds and
// scripts read.
// Usage: node bin/write-outputs.ts <env> <cdk outputs file>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../lib/config.ts';

const [envName, outputsFile] = process.argv.slice(2);
const outputs = (JSON.parse(readFileSync(outputsFile, 'utf8'))[`Multiscale-${envName}`] ?? {}) as Record<string, string>;

// The control stack has no outputs anything reads.
const missing = envName === 'control' ? [] : ['ApiUrl', 'CognitoDomain', 'AppClientId'].filter((key) => !outputs[key]);
if (missing.length > 0) throw new Error(`Stack outputs are missing ${missing.join(', ')}`);

writeFileSync(join(configDir(), `${envName}.outputs.json`), `${JSON.stringify(outputs, null, 2)}\n`);
