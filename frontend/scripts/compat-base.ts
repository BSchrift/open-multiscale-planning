// The old bundle scripts/test-compat.sh tests this checkout's beside: the oldest version any surface of a deployment
// serves, by build. With surfaces released apart, one person's devices can run the web app, the Mac's and the iPhone's
// versions at once, and each rolls back to its own. The compatibility rules only ever widen, so the widest gap is the
// one to test. Prints the version, such as 0.1.0-85e85c2, whose end is the commit it was built from.
//   node scripts/compat-base.ts <env>.outputs.json

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Live {
  version: string;
  build: number;
  surface: string;
}

// What each surface serves: web's page, each app's feed, and the shared feed bundles from before those read.
const FEEDS = { desktop: 'desktop/release.json', iphone: 'iphone/release.json', shared: 'release.json' };

export async function oldestLive(outputs: { WebUrl?: string; ReleaseUrl?: string }, fetch = globalThis.fetch): Promise<Live> {
  if (!outputs.WebUrl) throw new Error('The outputs have no WebUrl to read the version web serves from.');
  const read = async (url: string) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { version: string; build: number; manifest?: string };
    return body.manifest ? (JSON.parse(body.manifest) as { version: string; build: number }) : body;
  };
  const web = await read(`${outputs.WebUrl}/version.json`);
  if (!web) throw new Error(`Couldn't read ${outputs.WebUrl}/version.json.`);
  const live: Live[] = [{ version: web.version, build: web.build, surface: 'web' }];
  // A feed may not exist yet, before its first release.
  for (const [surface, path] of outputs.ReleaseUrl ? Object.entries(FEEDS) : []) {
    const feed = await read(`${outputs.ReleaseUrl}/${path}`);
    if (feed) live.push({ version: feed.version, build: feed.build, surface });
  }
  return live.reduce((oldest, l) => (l.build < oldest.build ? l : oldest));
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  const outputs = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { WebUrl?: string; ReleaseUrl?: string };
  oldestLive(outputs).then(
    (oldest) => {
      console.error(`The oldest version live is ${oldest.version}, on ${oldest.surface}.`);
      console.log(oldest.version);
    },
    (error: unknown) => {
      console.error(String(error instanceof Error ? error.message : error));
      process.exit(1);
    },
  );
}
