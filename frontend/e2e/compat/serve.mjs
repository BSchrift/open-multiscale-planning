// Serves the two builds scripts/test-compat.sh made from one origin, so they share a browser's database as two bundles
// of the app share a device's. Each request gets the build its browser context's `bundle` cookie names, old or new, so
// a test swaps bundles on a device by changing the cookie, and an old and a new device can sign in side by side through
// the one localhost callback a deployment allows.
//   node serve.mjs [port], with the builds in COMPAT_OLD and COMPAT_NEW. Without a port, any free one.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const builds = { old: process.env.COMPAT_OLD, new: process.env.COMPAT_NEW };
if (!builds.old || !builds.new) {
  console.error('COMPAT_OLD and COMPAT_NEW are not set. Run scripts/test-compat.sh.');
  process.exit(1);
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

createServer((request, response) => {
  const dir = builds[/(?:^|;\s*)bundle=(old|new)(?:;|$)/.exec(request.headers.cookie ?? '')?.[1]];
  if (!dir) {
    response.writeHead(400).end('No bundle cookie: set it to old or new.');
    return;
  }
  // The URL's path has no dot segments left. Any path that isn't a file, such as /auth/callback, is the app's page.
  const path = join(dir, new URL(request.url, 'http://localhost').pathname);
  const file = isFile(path) ? path : join(dir, 'index.html');
  // Never cached, since both builds have files at the same paths.
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(response);
}).listen(Number(process.argv[2]) || 0, 'localhost', function () {
  console.log(`Serving at http://localhost:${this.address().port}`);
});
