// Headless Chrome (system Chrome/Edge via puppeteer-core): runs page/index.html for each config, saves
// screenshots at the requested times and collects the in-browser metrics/timing -> results/browser_<tag>.json.
//   node shoot.mjs [--solvers=xpbd,rapier,jolt,springbone] [--n=500] [--bodies=neutral] [--shots=1.5,4.2,8.4]
//                  [--view=front34] [--out=<dir>] [--caps=1] [--tag=name]
//   node shoot.mjs --page=simplecloth [--n=500] [--bodies=neutral] ...   (candidate C, WebGPU page)
// Screenshots go to --out (default: <os tmp>/cloth-shots), never into the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const a = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
const SC = a.page === 'simplecloth';
const SOLVERS = SC ? ['simplecloth'] : (a.solvers || 'xpbd,rapier,jolt,springbone').split(',');
const NS = (a.n || '500').split(','), BODIES = (a.bodies || 'neutral').split(',');
const SHOTS = a.shots ?? '1.5,4.2,8.4', VIEW = a.view || 'front34';
const OUT = a.out || path.join(os.tmpdir(), 'cloth-shots');
const PORT = Number(a.port || 8125);
fs.mkdirSync(OUT, { recursive: true });

const exe = [process.env.CHROME, process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => fs.existsSync(p));
if (!exe) { console.error('No Chrome/Edge found; set CHROME'); process.exit(2); }
const srv = await startServer(PORT);
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--window-size=900,900', '--enable-unsafe-webgpu'] });
const results = [];
try {
  for (const s of SOLVERS) for (const n of NS) for (const b of BODIES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
    const url = `http://localhost:${PORT}/experiments/cloth/${SC ? 'simplecloth' : 'page'}/index.html?solver=${s}&n=${n}&body=${b}&shots=${SHOTS}&view=${VIEW}${a.caps ? '&caps=1' : ''}${a.params ? '&params=' + encodeURIComponent(a.params) : ''}`;
    await page.goto(url);
    const t0 = Date.now();
    for (;;) {
      const st = await page.evaluate(() => ({ shot: window.__shotReady || null, done: !!window.__done }));
      if (st.shot) {
        const file = path.join(OUT, `${s}_${n}_${b}_${VIEW}_${st.shot}.png`);
        await page.screenshot({ path: file });
        console.log('shot', path.basename(file));
        await page.evaluate(() => window.__continue());
      } else if (st.done) break;
      else if (Date.now() - t0 > 240000) { errors.push('timeout'); break; }
      else await new Promise(r => setTimeout(r, 50));
    }
    const r = await page.evaluate(() => window.__result || null);
    if (r) results.push({ ...r, errors });
    console.log(s, n, b, r?.error ? 'ERROR ' + r.error : r ? `browser ms ${r.msMean} (p95 ${r.msP95}) pen ${r.penEvents} hash ${r.hash}` : 'NO RESULT', errors.length ? errors.slice(0, 3) : '');
    await page.close();
  }
} finally { await browser.close(); srv.close(); }
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
const tag = a.tag || SOLVERS.join('-');
fs.writeFileSync(path.join(HERE, `results/browser_${tag}.json`), JSON.stringify({ chrome: await Promise.resolve(exe ? 'system chrome' : ''), rows: results }, null, 1));
console.log('screenshots in', OUT);
