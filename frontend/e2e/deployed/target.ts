// The deployment the deployed specs check: its web app at DEPLOYED_WEB_URL, its feeds at DEPLOYED_RELEASE_URL, its test
// user from MULTISCALE_TARGET (as scripts/test-target.mjs prints it), and, from a release, the version it must be serving
// in EXPECT_VERSION, with the feeds that must serve it too in EXPECT_FEEDS. scripts/test-deployed.sh sets them all.

export interface Deployed {
  env: string;
  url: string;
  user: { username: string; password: string };
  version: string | null;
  /** Where the apps' feeds are, when the deployment has a release host. */
  releaseUrl: string | null;
  /** The feeds a release switched to version: desktop, iphone and shared. */
  feeds: string[];
}

export function deployed(): Deployed {
  const url = process.env.DEPLOYED_WEB_URL ?? '';
  if (!/^https:\/\//.test(url)) throw new Error('DEPLOYED_WEB_URL is not set. Run scripts/test-deployed.sh.');
  let target: { env?: string; test_user?: Deployed['user'] } = {};
  try {
    target = JSON.parse(process.env.MULTISCALE_TARGET ?? '');
  } catch {
    // Reported below.
  }
  if (!target.env || !target.test_user?.username || !target.test_user.password) {
    throw new Error('MULTISCALE_TARGET has no test user. Run scripts/test-deployed.sh.');
  }
  return {
    env: target.env,
    url: url.replace(/\/$/, ''),
    user: target.test_user,
    version: process.env.EXPECT_VERSION || null,
    releaseUrl: process.env.DEPLOYED_RELEASE_URL?.replace(/\/$/, '') || null,
    feeds: (process.env.EXPECT_FEEDS ?? '').split(' ').filter(Boolean),
  };
}
