// The deployment the deployed specs check: its web app at DEPLOYED_WEB_URL, its feeds at DEPLOYED_RELEASE_URL, the Mac
// apps at DEPLOYED_DOWNLOADS_URL, its test
// user from MULTISCALE_TARGET (as scripts/test-target.mjs prints it), on staging its history user from
// MULTISCALE_HISTORY_TARGET, and, from a release, the version it must be serving in EXPECT_VERSION, with the feeds that
// must serve it too in EXPECT_FEEDS. scripts/test-deployed.sh sets them all.

export interface Deployed {
  env: string;
  url: string;
  user: { username: string; password: string };
  /** The history-scale test's own user, whose five-year account makes a long first sync: on staging only. */
  historyUser: { username: string; password: string } | null;
  version: string | null;
  /** Where the apps' feeds are, when the deployment has a release host. */
  releaseUrl: string | null;
  /** The feeds a release switched to version: desktop and iphone. */
  feeds: string[];
  /** Where the Mac apps are, when the deployment has a downloads host. */
  downloadsUrl: string | null;
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
  let history: { test_user?: Deployed['user'] } = {};
  try {
    history = JSON.parse(process.env.MULTISCALE_HISTORY_TARGET ?? '');
  } catch {
    // Off staging there's none, and the history project asks for it where it runs.
  }
  return {
    env: target.env,
    url: url.replace(/\/$/, ''),
    user: target.test_user,
    historyUser: history.test_user?.username && history.test_user.password ? history.test_user : null,
    version: process.env.EXPECT_VERSION || null,
    releaseUrl: process.env.DEPLOYED_RELEASE_URL?.replace(/\/$/, '') || null,
    feeds: (process.env.EXPECT_FEEDS ?? '').split(' ').filter(Boolean),
    downloadsUrl: process.env.DEPLOYED_DOWNLOADS_URL?.replace(/\/$/, '') || null,
  };
}
