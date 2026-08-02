/*
 * A static server for the reviewer's bundle.
 *
 * Deliberately dependency-free: the reviewer unzips the folder and runs
 * `node serve.js`. No npm install, no network, nothing to set up.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  // Never let a request climb out of the bundle.
  const target = path.normalize(path.join(ROOT, clean));
  if (!target.startsWith(ROOT)) return null;

  // The build writes a route as either `guides/coherent-data.html` or a folder
  // with an index.html, depending on the trailing-slash setting. Try the plain
  // file, then the .html sibling, then the folder.
  const tries = [target, `${target}.html`, path.join(target, 'index.html')];
  for (const candidate of tries) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one; fall through to the next candidate.
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  let file = resolve(req.url ?? '/');

  if (!file) {
    const notFound = path.join(ROOT, '404.html');
    if (fs.existsSync(notFound)) {
      res.writeHead(404, { 'Content-Type': TYPES['.html'] });
      fs.createReadStream(notFound).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // The reviewer edits nothing, but a stale review layer would be confusing.
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${String(PORT)}/`;
  console.log(`\n  TDC documentation — review copy\n`);
  console.log(`  Open at: ${url}`);
  console.log(`  Stop with: Ctrl+C\n`);
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(opener, [url], () => {
    // No browser to open is not an error; the URL is printed above.
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${String(PORT)} is taken. Start on another one:  PORT=4174 node serve.js\n`);
    process.exit(1);
  }
  throw e;
});
