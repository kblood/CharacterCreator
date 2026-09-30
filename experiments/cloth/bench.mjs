// Headless benchmark (node): every solver x particle count x body shape over the 10 s walk/run/idle->run
// timeline; plus a determinism re-run. Writes results/bench.json and prints a table.
//   node bench.mjs [--solvers=xpbd,rapier,jolt,springbone] [--n=500,2000] [--bodies=neutral,tall,...] [--det=1]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOne } from './lib/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'data/bodies.json'), 'utf8'));
const SOLVERS = (args.solvers || 'xpbd,rapier,jolt,springbone').split(',');
const NS = (args.n || '500,2000').split(',').map(Number);
const BODY_IDS = (args.bodies || Object.keys(data.bodies).join(',')).split(',');
const DET = args.det !== '0';

// fingerprint of the animation input (web/animation clips may change): FNV over neutral capsule ends
import { frames } from './lib/drive.mjs';
let animHash = 0x811c9dc5;
for (const f of frames(data.bodies.neutral)) for (const c of f.capsules) for (const v of [...c.a, ...c.b]) {
  animHash = Math.imul(animHash ^ (Math.round(v * 1e4) & 0xffff), 16777619) >>> 0;
}
animHash = animHash.toString(16);
console.log('animation fingerprint', animHash);
const rows = [];
for (const s of SOLVERS) {
  const mod = await import(`./lib/solvers/${s}.mjs`);
  await mod.init?.();
  for (const n of NS) for (const b of BODY_IDS) {
    const r = await runOne(mod, data.bodies[b], n);
    delete r.trace;
    let det = null;
    if (DET && b === 'neutral') {
      const r2 = await runOne(mod, data.bodies[b], n);
      det = r2.hash === r.hash;
    }
    const row = { solver: s, n, body: b, ...r, deterministic: det };
    rows.push(row);
    console.log([s.padEnd(10), String(r.particles).padStart(5), b.padEnd(8),
      `ms ${r.msMean.toFixed(2)} (p95 ${r.msP95.toFixed(2)})`, `pen ${r.penEvents} deep ${r.deepEvents} max ${r.maxDepthMm}mm`,
      `stretch ${r.maxStretch}/${r.maxRingStretch}`, `jit ${r.idleJitterMm}mm`, `hemLag ${r.hemLagRunMm}mm`, `rise ${r.hemRiseMaxMm}mm flip ${r.flipFrames}f`, `pinErr ${r.maxPinErrMm}mm`,
      r.exploded ? 'EXPLODED' : '', r.nan ? 'NaN' : '', det === null ? '' : `det=${det}`].join('  '));
  }
}
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
const file = path.join(HERE, `results/bench_${SOLVERS.join('-')}.json`);
fs.writeFileSync(file, JSON.stringify({ node: process.version, date: new Date().toISOString().slice(0, 10), animHash, rows }, null, 1));
console.log('wrote', path.relative(HERE, file));
