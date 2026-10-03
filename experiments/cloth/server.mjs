// SPDX-License-Identifier: GPL-3.0-or-later
// Tiny static server for the cloth experiment. Serves the REPO ROOT read-only, so the page can import
// web/animation/*.js and load output/*.glb without copying anything.
//   node server.mjs [port]      -> http://localhost:8123/experiments/cloth/page/index.html
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv[2] || process.env.PORT || 8123);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.png': 'image/png', '.css': 'text/css' };

export function startServer(port = PORT) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.resolve(ROOT, '.' + u);
    if ((f !== ROOT && !f.startsWith(ROOT + path.sep)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));   // loopback only
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log(`serving repo root on http://localhost:${PORT}/experiments/cloth/page/index.html`);
}
