// Debug trace: node trace.mjs <solver> [n] [body] ['<json params>'] -> every 0.5 s: max stretch, one hem vertex vs its rigid target.
import fs from 'node:fs';
import { frames } from './lib/drive.mjs';
import { buildSkirt } from './lib/garment.mjs';
import { pinTargets } from './lib/run.mjs';
const [solver = 'xpbd', n = '500', bodyId = 'neutral', params = '{}'] = process.argv.slice(2);
const S = await import(`./lib/solvers/${solver}.mjs`);
await S.init?.();
const data = JSON.parse(fs.readFileSync(new URL('./data/bodies.json', import.meta.url), 'utf8'));
const body = data.bodies[bodyId], g = buildSkirt(body, Number(n));
let s, k = 0, prevP = null;
const f3 = (A, i) => [A[3 * i], A[3 * i + 1], A[3 * i + 2]].map(x => x.toFixed(3)).join(',');
for (const f of frames(body)) {
  const pin = pinTargets(g, body, f);
  if (!s) { s = await S.createSolver(g, body, f, pin, JSON.parse(params)); console.log(s.info ?? ''); continue; }
  await s.step(f, pin, 1 / 60);
  const P = s.positions();
  if (process.env.FINE && f.t > +process.env.FINE && f.t < +process.env.FINE + 0.3) {
    // fastest particle this frame (relative to the previous frame) and its nearest capsule
    let best = 0, bi = 0;
    for (let v = 0; v < g.count; v++) {
      const d = Math.hypot(P[3 * v] - prevP[3 * v], P[3 * v + 1] - prevP[3 * v + 1], P[3 * v + 2] - prevP[3 * v + 2]);
      if (d > best) { best = d; bi = v; }
    }
    const near = f.capsules.map(c => {
      const ab = c.b.map((x, i) => x - c.a[i]), ap = [0, 1, 2].map(i => P[3 * bi + i] - c.a[i]);
      const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
      return [c.name, (Math.hypot(...ap.map((x, i) => x - t * ab[i])) - c.r) * 1000];
    }).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([n, d]) => `${n} ${d.toFixed(0)}mm`).join(' ');
    console.log(f.t.toFixed(3), 'fastest v', bi, 'row', g.row[bi], 'moved', (best * 1000).toFixed(0), 'mm | nearest', near);
  }
  prevP = Float32Array.from(P);
  if (k++ % 30) continue;
  let ms = 0, arg = 0;
  for (let e = 0; e < g.edges.length / 2; e++) {
    const a = g.edges[2 * e], b = g.edges[2 * e + 1];
    const r = Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]) / g.edgeRest[e];
    if (r > ms) { ms = r; arg = a; }
  }
  const v = g.count - 1;
  console.log(f.t.toFixed(2).padStart(6), f.clip.padEnd(5), 'maxStretch', ms.toFixed(2), 'at row', g.row[arg], '| hem', f3(P, v), '| rigid', f3(pin, v));
}
