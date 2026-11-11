// The feeds the apps update from, as a device fetches them from the release host: each one's manifest checks out with
// the environment's release key, names the version a release just switched it to, and lists only files that download
// with their SHA-256. A bundle whose feed is missing or wrong stops updating without a sound, so this runs on every
// release. scripts/test-deployed.sh runs it.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { releaseKeyIn } from '../../scripts/sign-release.mjs';
import { deployed } from './target';

const d = deployed();
// Where each feed is on the release host. The desktop and iPhone apps read their own; bundles from before that read the
// shared one (src/core/updates.ts).
const FEEDS = { desktop: 'desktop/release.json', iphone: 'iphone/release.json', shared: 'release.json' };
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
