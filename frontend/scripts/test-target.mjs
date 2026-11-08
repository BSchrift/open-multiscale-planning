// Prints, as JSON, the backend the signed-in Playwright specs and XCUITest sign in to, for MULTISCALE_TARGET.
// ENV=local: the stack at LOCAL_API_URL with its built-in client. ENV=staging or prod: that deployment's API and test
// client from <env>.outputs.json, as integration.testUser from <env>.yaml, whose password is read from SSM with the
// environment's own AWS profile and region. MULTISCALE_TEST_USER=history signs in as integration.historyUser instead,
// the history-scale test's own user (scripts/test-history.sh). The caller checks CONFIRM_PROD.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadAppConfig, readEnvYaml, readOutputs } from '../src/core/appConfig.ts';

const readFile = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

function target() {
  const env = process.env.ENV || 'local';
  const configDir = resolve(process.env.MULTISCALE_CONFIG_DIR || join(import.meta.dirname, '../../config'));
  const app = loadAppConfig(env, readFile, configDir, process.env.LOCAL_API_URL);
  if (app.env === 'local') {
    if (!process.env.LOCAL_API_URL) throw new Error('LOCAL_API_URL is not set. Start scripts/local-stack.sh first.');
    return { env: app.env, api_url: app.apiUrl, client_id: app.authClientId };
  }
  const file = `${configDir}/${env}.yaml`;
  const yaml = readEnvYaml(app.env, readFile, configDir);
  const { profile, region } = yaml.aws ?? {};
  const history = process.env.MULTISCALE_TEST_USER === 'history';
  const key = history ? 'historyUser' : 'testUser';
  const username = yaml.integration?.[key];
  if (typeof profile !== 'string' || !profile) throw new Error(`${file}: aws.profile is missing`);
  if (typeof region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) throw new Error(`${file}: aws.region is not an AWS region`);
  if (typeof username !== 'string' || !username) throw new Error(`${file}: integration.${key} is missing${history ? '. See docs/setup.md.' : ''}`);
  const clientId = readOutputs(app.env, readFile, configDir).TestClientId;
  if (typeof clientId !== 'string' || !clientId) throw new Error(`${configDir}/${env}.outputs.json: TestClientId is missing`);

  const parameter = `/multiscale/${env}/${history ? 'history' : 'test'}-user-password`;
  let password = '';
  try {
    password = execFileSync('aws', ['ssm', 'get-parameter', '--name', parameter, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'], {
      env: { ...process.env, AWS_PROFILE: profile, AWS_REGION: region },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch {
    // Reported below, with what aws printed above it.
  }
  if (!password) throw new Error(`Could not read SSM parameter ${parameter} with profile ${profile} in ${region}. See docs/setup.md.`);
  return { env, api_url: app.apiUrl, client_id: clientId, region, test_user: { username, password } };
}

try {
  console.log(JSON.stringify(target()));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
