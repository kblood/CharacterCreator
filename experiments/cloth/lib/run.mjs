// One simulation run: body x garment resolution x solver over the fixed 11 s timeline (1 s preroll +
// 10 s measured). Shared by the node benchmark and the browser page.
import { frames, hipsAttach, HZ } from './drive.mjs';
import { buildSkirt } from './garment.mjs';
import { createMetrics, annotateRest } from './metrics.mjs';

export function pinTargets(g, body, f) {
  const out = new Float32Array(g.count * 3);
  for (let v = 0; v < g.count; v++) {
    const p = hipsAttach(f, body, [g.pos[3 * v], g.pos[3 * v + 1], g.pos[3 * v + 2]]);
    out[3 * v] = p[0]; out[3 * v + 1] = p[1]; out[3 * v + 2] = p[2];
  }
  return out;
}

/**
 * solverMod: module with createSolver(g, body, frame0, pin0, params) (may be async) -> { step, positions, dispose }.
 * onFrame(f, positions, g) optional (rendering / screenshots). Returns metrics + timing.
 */
export async function runOne(solverMod, body, n, { params = {}, onFrame, keepTrace = false } = {}) {
  const g = annotateRest(buildSkirt(body, n), body);
  const metrics = createMetrics(g, body);
  const dt = 1 / HZ;
  let solver = null, tInit = 0;
  const ms = [], trace = [];
  const now = () => (globalThis.performance ?? Date).now();
  for (const f of frames(body)) {
    const pin = pinTargets(g, body, f);
    if (!solver) {
      const t0 = now();
      solver = await solverMod.createSolver(g, body, f, pin, params);
      tInit = now() - t0;
    } else {
      const t0 = now();
      await solver.step(f, pin, dt);
      const P = solver.positions();
      ms.push(now() - t0);
      if (f.measured) metrics.frame(f, P, pin);
      if (keepTrace && f.measured) trace.push(Float32Array.from(P));
    }
    if (onFrame) await onFrame(f, solver.positions(), g);
  }
  solver.dispose?.();
  const measured = ms.slice(Math.round(1 * HZ));             // skip preroll frames for timing
  const s = [...measured].sort((a, b) => a - b);
  const q = k => +s[Math.min(s.length - 1, Math.floor(k * s.length))].toFixed(3);
  return {
    particles: g.count, initMs: +tInit.toFixed(1),
    msMean: +(measured.reduce((a, b) => a + b, 0) / measured.length).toFixed(3), msMedian: q(0.5), msP95: q(0.95), msMax: q(1),
    ...metrics.result(), trace,
  };
}
