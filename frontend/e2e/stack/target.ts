// The backend the stack specs sign in to. Locally, the stack scripts/local-stack.sh started, at LOCAL_API_URL. With
// ENV=staging, or prod with CONFIRM_PROD=yes, the deployment, as the test user scripts/e2e.sh puts in MULTISCALE_TARGET
// from scripts/test-target.mjs.

export interface Target {
  env: string;
  /** The local stack's API, whose test controls a deployment doesn't have. */
  localApi?: string;
  /** The deployment's test user, who signs in through the hosted sign-in page. */
  user?: { username: string; password: string };
  /** Locally any free port. A deployment's sign-in only returns to the localhost callback registered for it. */
  webPort: number;
}

export function target(): Target {
  const env = process.env.ENV || 'local';
  if (env === 'local') {
    const localApi = process.env.LOCAL_API_URL;
    if (!localApi) throw new Error('LOCAL_API_URL is not set. Start scripts/local-stack.sh first, or run make test-e2e.');
    return { env, localApi, webPort: 0 };
  }
  if (env !== 'staging' && env !== 'prod') throw new Error(`ENV must be local, staging or prod, not ${env}`);
  if (env === 'prod' && process.env.CONFIRM_PROD !== 'yes') throw new Error('Running against prod needs CONFIRM_PROD=yes');
  let deployed: { env?: string; test_user?: Target['user'] } = {};
  try {
    deployed = JSON.parse(process.env.MULTISCALE_TARGET ?? '');
  } catch {
    // Reported below.
  }
  const user = deployed.test_user;
  if (deployed.env !== env || !user?.username || !user.password) {
    throw new Error(`MULTISCALE_TARGET has no ${env} test user. Run make test-e2e ENV=${env}.`);
  }
  return { env, user, webPort: 5199 };
}
