// The feeds the apps update from, as a device fetches them from the release host: each one's manifest checks out with
// the environment's release key, names the version a release just switched it to, and lists only files that download
// with their SHA-256. A bundle whose feed is missing or wrong stops updating without a sound, so this runs on every
// release. scripts/test-deployed.sh runs it.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { releaseKeyIn } from '../../scripts/sign-release.mjs';
import { deployed } from './target';

const d = deployed();
// Where each app's feed is on the release host (src/core/updates.ts).
const FEEDS = { desktop: 'desktop/release.json', iphone: 'iphone/release.json' };
// Prod's Test step runs before its release publishes, and so before that release deletes the shared feed.
const beforePublish = process.env.DEPLOYED_BEFORE_PUBLISH === '1';
// An Ed25519 public key's DER prefix, before the 32 bytes a build carries.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

test('each feed checks out with the release key and names the version released, and its files download', async ({ request }, info) => {
  test.skip(info.project.name !== 'desktop', 'The feeds are the same at every size');
  test.skip(!d.releaseUrl, `${d.env} has no release host`);
  // Time for each feed's edge cache, below.
  test.setTimeout(5 * 60_000);
  const key = releaseKeyIn(process.env.MULTISCALE_CONFIG_DIR ?? '', d.env);
  if (!key) throw new Error(`The config folder has no ${d.env}.release-key.pem or .pub to check the feeds with.`);
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(key, 'base64')]), format: 'der', type: 'spki' });
  const downloaded = new Set<string>();
  for (const [feed, path] of Object.entries(FEEDS)) {
    const expected = d.version && d.feeds.includes(feed) ? d.version : null;
    let response = await request.get(`${d.releaseUrl}/${path}`);
    // The private bucket answers a missing file with 403. A feed this release didn't switch may not exist yet.
    if (!d.feeds.includes(feed) && [403, 404].includes(response.status())) {
      info.annotations.push({ type: 'skipped', description: `No ${feed} feed yet` });
      continue;
    }
    // A feed caches for a minute at the edge, so one just switched may take that long to show.
    const versionOf = async (r: typeof response) => (r.ok() ? (JSON.parse(((await r.json()) as { manifest: string }).manifest) as { version: string }).version : null);
    for (let wait = 0; expected && (await versionOf(response)) !== expected && wait < 90_000; wait += 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      response = await request.get(`${d.releaseUrl}/${path}`);
    }
    expect(response.status(), `the ${feed} feed, ${path}`).toBe(200);
    const { manifest, signature } = (await response.json()) as { manifest: string; signature: string };
    expect(verify(null, Buffer.from(manifest), publicKey, Buffer.from(signature, 'base64')), `the ${feed} feed's signature`).toBe(true);
    const { version, files } = JSON.parse(manifest) as { version: string; files: { path: string; sha256: string }[] };
    if (expected) expect(version, `the ${feed} feed's version`).toBe(expected);
    for (const file of files.filter((f) => !downloaded.has(f.sha256))) {
      const body = await (await request.get(`${d.releaseUrl}/files/${file.sha256}`)).body();
      expect(createHash('sha256').update(body).digest('hex'), `${file.path} in the ${feed} feed`).toBe(file.sha256);
      downloaded.add(file.sha256);
    }
  }
});

// Bundles from before the apps' own feeds read release.json at the host's root. Each release deletes it, so no one is
// left reading a feed nothing switches.
test('the shared feed at the root is gone', async ({ request }, info) => {
  test.skip(info.project.name !== 'desktop', 'The feeds are the same at every size');
  test.skip(!d.releaseUrl, `${d.env} has no release host`);
  test.skip(beforePublish, "needs: this release's publish, which deletes it, and which release-prod checks");
  // A copy may stay at the edge for the minute it cached for.
  await expect
    .poll(async () => [403, 404].includes((await request.get(`${d.releaseUrl}/release.json`)).status()), { message: `${d.releaseUrl}/release.json answers 403 or 404`, timeout: 90_000, intervals: [10_000] })
    .toBe(true);
});

// The Mac app the desktop feed names, as an installed app updates to it: electron-updater reads latest-mac.yml from the
// record's folder, which must say what the signed record does, then downloads the zip, in single byte ranges for only
// the blocks that changed, and checks its SHA-512.
test("the desktop feed's app is on the downloads host as its record says, and the zip downloads in ranges", async ({ request }, info) => {
  test.skip(info.project.name !== 'desktop', 'The feeds are the same at every size');
  test.skip(!d.releaseUrl || !d.downloadsUrl, `${d.env} has no release or downloads host`);
  test.setTimeout(5 * 60_000);
  const feed = await request.get(`${d.releaseUrl}/desktop/release.json`);
  expect(feed.status()).toBe(200);
  const { app } = JSON.parse(((await feed.json()) as { manifest: string }).manifest) as { app?: { version: string; folder: string; file: string; sha512: string; size: number } };
  if (!app) {
    info.annotations.push({ type: 'skipped', description: 'The desktop feed names no app yet' });
    return;
  }
  const folder = `${d.downloadsUrl}/${app.folder}`;
  const yml = await (await request.get(`${folder}latest-mac.yml`)).text();
  const field = (name: string) => new RegExp(`^\\s*-?\\s*${name}: '?([^'\\n]+)'?$`, 'm').exec(yml)?.[1];
  expect([field('version'), field('path'), field('sha512'), field('size')], 'latest-mac.yml').toEqual([app.version, app.file, app.sha512, String(app.size)]);
  const zip = await request.get(`${folder}${app.file}`);
  const body = await zip.body();
  expect([body.length, createHash('sha512').update(body).digest('base64')], `${app.file}'s size and SHA-512`).toEqual([app.size, app.sha512]);
  const range = await request.get(`${folder}${app.file}`, { headers: { Range: 'bytes=100-199' } });
  expect(range.status(), 'a single byte range').toBe(206);
  expect((await range.body()).equals(body.subarray(100, 200))).toBe(true);
});
