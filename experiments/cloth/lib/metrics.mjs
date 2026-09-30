// Solver-independent measurements on world-space particle positions, one call per 60 Hz frame.
// Penetration = a free particle closer to a capsule axis than the capsule radius minus TOL.
import { qConj, qRotate } from '../../../web/animation/qmath.js';

export const TOL = 0.005;          // 5 mm: counted as a penetration event
export const DEEP = 0.02;          // 2 cm: counted as deep (visible tunnelling)

function segDist(px, py, pz, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const L2 = abx * abx + aby * aby + abz * abz || 1e-12;
  let t = ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - a[0] - t * abx, dy = py - a[1] - t * aby, dz = pz - a[2] - t * abz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function createMetrics(g, body) {
  const N = g.count;
  const m = {
    frames: 0, penEvents: 0, deepEvents: 0, framesWithPen: 0, maxDepth: 0, perCapsule: {},
    maxStretch: 1, sumStretch: 0, stretchSamples: 0, nan: false, exploded: false,
    jitterSum: 0, jitterN: 0, hemLagRun: 0, hemLagN: 0, maxPinErr: 0, near: 0, maxRingStretch: 1, hemRiseMax: 0, flipFrames: 0,
  };
  const hist = [];                       // last 2 positions in hips-local space (for idle jitter)
  const hem = [];
  for (let v = 0; v < N; v++) if (g.row[v] === g.rows - 1) hem.push(v);
  let hash = 2166136261 >>> 0;

  function frame(f, P, pinTargets) {
    m.frames++;
    let any = false;
    for (let v = 0; v < N; v++) {
      const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
      if (!Number.isFinite(x + y + z)) { m.nan = true; continue; }
      if (g.mask[v] >= 1) {
        if (pinTargets) m.maxPinErr = Math.max(m.maxPinErr, Math.hypot(x - pinTargets[3 * v], y - pinTargets[3 * v + 1], z - pinTargets[3 * v + 2]));
        continue;
      }
      for (const c of f.capsules) {
        const depth = c.r - segDist(x, y, z, c.a, c.b);
        if (depth > -0.015) m.near++;
        if (depth > TOL) {
          m.penEvents++; any = true; m.perCapsule[c.name] = (m.perCapsule[c.name] || 0) + 1;
          if (depth > DEEP) m.deepEvents++;
          if (depth > m.maxDepth) m.maxDepth = depth;
        }
      }
      const dh = Math.hypot(x - f.hipsPos[0], y - f.hipsPos[1], z - f.hipsPos[2]);
      if (dh > 2.5) m.exploded = true;
    }
    if (any) m.framesWithPen++;
    // stretch of structural edges: vertical (down) edges -> maxStretch/meanStretch, ring edges -> maxRingStretch
    const E = g.edges;
    for (let k = 0; k < E.length / 2; k++) {
      const a = E[2 * k], b = E[2 * k + 1];
      const L = Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]);
      const s = L / g.edgeRest[k];
      if (g.row[a] === g.row[b]) { if (s > m.maxRingStretch) m.maxRingStretch = s; continue; }   // ring (around) edges: gaps between spring-bone chains
      if (s > m.maxStretch) m.maxStretch = s;
      m.sumStretch += s; m.stretchSamples++;
    }
    if (m.maxStretch > 3 || m.maxRingStretch > 20) m.exploded = true;
    // hips-local positions for jitter / hem lag
    const qi = qConj(f.hipsQ);
    const local = new Float32Array(N * 3);
    for (let v = 0; v < N; v++) {
      const r = qRotate(qi, [P[3 * v] - f.hipsPos[0], P[3 * v + 1] - f.hipsPos[1], P[3 * v + 2] - f.hipsPos[2]]);
      local[3 * v] = r[0]; local[3 * v + 1] = r[1]; local[3 * v + 2] = r[2];
    }
    // idle jitter: last second of the idle segment (6.5-7.5 s), RMS second difference (mm)
    if (f.t >= 6.5 && f.t < 7.5) {
      if (hist.length === 2) {
        let s = 0;
        for (let k = 0; k < local.length; k++) { const a = local[k] - 2 * hist[1][k] + hist[0][k]; s += a * a; }
        m.jitterSum += s / N; m.jitterN++;
      }
      hist.push(local); if (hist.length > 2) hist.shift();
    }
    // hem trailing during steady run (4-5.5 s): mean local z of the hem minus rest (negative = behind)
    if (f.t >= 4 && f.t < 5.5) {
      let s = 0; for (const v of hem) s += local[3 * v + 2] - g._hemRestZ[v]; m.hemLagRun += s / hem.length; m.hemLagN++;
    }
    // hem rise: mean hips-local height of the hem above its rest height (skirt flipped up / bunched at the waist)
    { let s = 0; for (const v of hem) s += local[3 * v + 1] - g._hemRestY[v]; s /= hem.length;
      if (s > m.hemRiseMax) m.hemRiseMax = s; if (s > 0.10) m.flipFrames++; }
    // FNV-1a over the float32 bytes of this frame (determinism)
    const bytes = new Uint8Array(Float32Array.from(P).buffer);
    for (let k = 0; k < bytes.length; k++) { hash ^= bytes[k]; hash = Math.imul(hash, 16777619) >>> 0; }
  }

  function result() {
    return {
      frames: m.frames, penEvents: m.penEvents, deepEvents: m.deepEvents, framesWithPen: m.framesWithPen,
      penPerFrame: +(m.penEvents / Math.max(1, m.frames)).toFixed(3), maxDepthMm: +(m.maxDepth * 1000).toFixed(1),
      perCapsule: m.perCapsule, nearPerFrame: +(m.near / Math.max(1, m.frames)).toFixed(1),
      maxStretch: +m.maxStretch.toFixed(3), maxRingStretch: +m.maxRingStretch.toFixed(3), meanStretch: +(m.sumStretch / Math.max(1, m.stretchSamples)).toFixed(4),
      nan: m.nan, exploded: m.exploded,
      idleJitterMm: +(Math.sqrt(m.jitterSum / Math.max(1, m.jitterN)) * 1000).toFixed(3),
      hemLagRunMm: +(1000 * m.hemLagRun / Math.max(1, m.hemLagN)).toFixed(1),
      maxPinErrMm: +(m.maxPinErr * 1000).toFixed(2),
      hemRiseMaxMm: +(m.hemRiseMax * 1000).toFixed(0), flipFrames: m.flipFrames,
      hash: hash.toString(16),
    };
  }
  return { frame, result };
}

/** Hips-local rest z / y of every vertex (hem lag / hem rise reference). */
export function annotateRest(g, body) {
  const H = body.heads.hips;
  g._hemRestZ = Float32Array.from({ length: g.count }, (_, v) => g.pos[3 * v + 2] - H[2]);
  g._hemRestY = Float32Array.from({ length: g.count }, (_, v) => g.pos[3 * v + 1] - H[1]);
  return g;
}
