// Serves each build the performance runner times on its own port, so each is its own origin with its own database, as
// two devices are. Gzipped, and the hashed assets cached as CloudFront serves them, so a warm start finds them cached
// and the byte counts are what goes over the network.
//   node serve.mjs <name>=<build folder> ...   prints "Serving <name> at http://localhost:<port>" for each

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { createGzip } from 'node:zlib';

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

for (const arg of process.argv.slice(2)) {
  const [name, dir] = arg.split('=');
  createServer((request, response) => {
    // The URL's path has no dot segments left. Any path that isn't a file is the app's page.
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = join(dir, pathname);
    const file = isFile(path) ? path : join(dir, 'index.html');
    const type = types[extname(file)] ?? 'application/octet-stream';
    const gzip = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '') && type !== 'image/png' && type !== 'font/woff2';
    response.writeHead(200, {
      'content-type': type,
      'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
    const body = createReadStream(file);
    (gzip ? body.pipe(createGzip()) : body).pipe(response);
  }).listen(0, 'localhost', function () {
    console.log(`Serving ${name} at http://localhost:${this.address().port}`);
  });
}
