// XPBD cloth solver (pure JS, no three.js, no allocations per step; runs on the main thread or in a worker).
// Small-steps XPBD (Macklin et al. 2019): every fixed step of 1/hz s is split into `substeps` substeps with one
// constraint pass each. Order per substep:
//   predict (gravity, air drag relative to the air velocity, damping relative to the skinned motion)
//   -> distance constraints (stretch stiff, compression softer so folds can form)
//   -> skip-one bending (separate compliance for vertical chains: long coat panels keep their length/shape)
//   -> mirror separation (front panels / vent edges never cross, along the pelvis' lateral axis)
//   -> long-range attachments (each free particle stays within its rest geodesic distance (+ tetherSlack) of the
//      nearest pinned particle: no sagging of long panels with few iterations)
//   -> maxDistance to the skinned position ((1 - pin) * maxDistance)
//   -> collisions last (capsules interpolated inside the step, soft floor)
//   -> velocities from positions, then a contact velocity pass (no launch faster than the collider surface,
//      tangential friction relative to it).
// Deterministic: fixed iteration order, float64 JS math on Float32Array storage.
import { restLengths, mirrorRest } from './model.js';
import { triNormals } from './skin.js';
import { LAYER_STRIDE, LAYER_PARTS } from './layers.js';

export const DEFAULTS = {
  hz: 60, substeps: 8, maxSteps: 4,
  stretch: 0.95, compress: 0.55, bend: 0.35, bendVertical: 0.6,
  damping: 0.12, gravityScale: 1, wind: 0.3, friction: 0.3, thickness: 0.01, maxDistance: 0.3,
  drag: 0.6, dragNormal: 3.0, floorFriction: 0.6, mirrorGap: 0.003, teleport: 0.3, tetherSlack: 0.04, bendFloor: 3, limitSlack: 0.02, limit: 'arms,hips',
  layerThickness: 0.012, layerDepth: 0.04, layerReach: 0.05, layerSided: true,
};

/** stiffness 0..1 -> XPBD compliance (m/N at unit mass): 1e-3 (limp) .. 1e-9 (rigid), log-linear. */
export const compliance = s => 10 ** (-3 - 6 * Math.min(1, Math.max(0, s)));

/** ccCloth extras (GLB) + overrides -> solver parameters (sane defaults for anything missing). */
export function clothParams(extras = {}, over = {}) {
  const e = extras || {};
  const st = e.stiffness || {};
  const pick = (k, v) => (typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k]);
  const p = { ...DEFAULTS };
  p.stretch = pick('stretch', st.stretch);
  p.bend = pick('bend', st.bend);
  p.bendVertical = pick('bendVertical', e.bendVertical ?? st.bend);
  for (const k of ['maxDistance', 'damping', 'gravityScale', 'wind', 'friction', 'thickness', 'layerThickness']) p[k] = pick(k, e[k]);
  p.limit = typeof e.limit === 'string' ? e.limit : DEFAULTS.limit;
  return { ...p, ...over };
}

/**
 * model = buildClothModel(...).sim part + rest positions: { count, pin, edges, bends, bendVertical, mirrors, tris }.
 * restX = simulated particles' morphed bind positions (sim order), for rest lengths.
 */
export function createSolver(sim, restX, params) {
  const prm = { ...params };
  const N = sim.count;
  const x = new Float32Array(N * 3), v = new Float32Array(N * 3), prev = new Float32Array(N * 3);
  const A0 = new Float32Array(N * 3), A1 = new Float32Array(N * 3);
  const w = new Float32Array(N), maxD = new Float32Array(N);
  const nrm = new Float32Array(N * 3);
  const MAXC = 10;
  const cand = new Int16Array(N * MAXC), ncand = new Uint8Array(N);
  const hit = new Uint8Array(N), cn = new Float32Array(N * 3), cv = new Float32Array(N * 3);
  const tSrc = new Int32Array(N).fill(-1), tLen = new Float32Array(N);
  // lower-layer collision (web/cloth/layers.js): nearest layer point per free particle, found once per step
  const lc = new Int32Array(N * LAYER_PARTS).fill(-1);
  const HB = 4096, lHead = new Int32Array(HB);
  let lNext = new Int32Array(0), L0 = null;
  let edgeRest, bendRest, mirRest, C0 = null, capsNow = new Float32Array(0), capVel = new Float32Array(0);
  let started = false, steps = 0, resets = 0;
  const E = sim.edges, B = sim.bends, BV = sim.bendVertical, M = sim.mirrors;

  function setParams(p) {
    Object.assign(prm, p);
    for (let i = 0; i < N; i++) {
      const pin = sim.pin[i];
      w[i] = pin >= 0.999 ? 0 : 1;
      maxD[i] = (1 - pin) * prm.maxDistance;
    }
  }
  function setRest(X) {
    edgeRest = restLengths(E, X);
    bendRest = restLengths(B, X);
    mirRest = mirrorRest(M, X);
    // tethers: multi-source Dijkstra over the edges from every kinematic particle (N is small: O(N^2) scan)
    const adj = Array.from({ length: N }, () => []);
    for (let k = 0; k < edgeRest.length; k++) { adj[E[2 * k]].push(E[2 * k + 1], edgeRest[k]); adj[E[2 * k + 1]].push(E[2 * k], edgeRest[k]); }
    const dist = new Float64Array(N).fill(Infinity), done = new Uint8Array(N);
    tSrc.fill(-1);
    for (let i = 0; i < N; i++) if (sim.pin[i] >= 0.999) { dist[i] = 0; tSrc[i] = i; }
    for (;;) {
      let b = -1, bd = Infinity;
      for (let i = 0; i < N; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; b = i; }
      if (b < 0) break;
      done[b] = 1;
      const l = adj[b];
      for (let j = 0; j < l.length; j += 2) {
        const c = l[j], d = bd + l[j + 1];
        if (d < dist[c]) { dist[c] = d; tSrc[c] = tSrc[b]; }
      }
    }
    for (let i = 0; i < N; i++) tLen[i] = Number.isFinite(dist[i]) ? dist[i] : 0;
  }
  setParams(prm);
  setRest(restX);

  function reset(anchors) {
    x.set(anchors); A0.set(anchors); A1.set(anchors); v.fill(0);
    started = true; C0 = null; L0 = null; resets++;
  }

  // nearest layer point of every free particle, one per layer part (garment), within layerReach (grid of
  // layerReach cells). L = [x, y, z, nx, ny, nz, part]* (LAYER_STRIDE floats, layers.js).
  const lKey = (x, y, z) => ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & (HB - 1);
  const lBest = new Float64Array(LAYER_PARTS);
  let nParts = 0;   // parts present in this step's layer points (<= LAYER_PARTS)
  function layerCandidates(L) {
    const S = LAYER_STRIDE, M = L.length / S, cell = prm.layerReach, R2 = cell * cell;
    if (lNext.length < M) lNext = new Int32Array(M);
    lHead.fill(-1);
    nParts = 0;
    for (let j = 0; j < M; j++) nParts = Math.max(nParts, Math.min(LAYER_PARTS, L[S * j + 6] + 1));
    for (let j = 0; j < M; j++) {
      const k = lKey(Math.floor(L[S * j] / cell), Math.floor(L[S * j + 1] / cell), Math.floor(L[S * j + 2] / cell));
      lNext[j] = lHead[k]; lHead[k] = j;
    }
    for (let i = 0; i < N; i++) {
      const lo = LAYER_PARTS * i;
      for (let p = 0; p < LAYER_PARTS; p++) { lc[lo + p] = -1; lBest[p] = R2; }
      if (!w[i]) continue;
      const o = 3 * i, px = x[o], py = x[o + 1], pz = x[o + 2];
      // cell = reach: the reach sphere overlaps at most 2 cells per axis (the own one + the nearer neighbour)
      const fx = px / cell, fy = py / cell, fz = pz / cell, cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
      const sx = fx - cx < 0.5 ? -1 : 1, sy = fy - cy < 0.5 ? -1 : 1, sz = fz - cz < 0.5 ? -1 : 1;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
        for (let j = lHead[lKey(cx + a * sx, cy + b * sy, cz + c * sz)]; j >= 0; j = lNext[j]) {
          const q = S * j, p = L[q + 6];
          if (p >= LAYER_PARTS) continue;
          const d2 = (L[q] - px) ** 2 + (L[q + 1] - py) ** 2 + (L[q + 2] - pz) ** 2;
          if (d2 < lBest[p]) { lBest[p] = d2; lc[lo + p] = j; }
        }
      }
    }
  }

  function candidates(caps, dt) {
    const K = caps.length / 7, th = prm.thickness;
    for (let i = 0; i < N; i++) {
      ncand[i] = 0;
      if (!w[i]) continue;
      const o = 3 * i, px = x[o], py = x[o + 1], pz = x[o + 2];
      const reach = 0.12 + Math.hypot(v[o], v[o + 1], v[o + 2]) * dt;
      for (let k = 0; k < K && ncand[i] < MAXC; k++) {
        const c = 7 * k;
        const abx = caps[c + 3] - caps[c], aby = caps[c + 4] - caps[c + 1], abz = caps[c + 5] - caps[c + 2];
        const l2 = abx * abx + aby * aby + abz * abz;
        let t = l2 > 1e-12 ? ((px - caps[c]) * abx + (py - caps[c + 1]) * aby + (pz - caps[c + 2]) * abz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - caps[c] - t * abx, dy = py - caps[c + 1] - t * aby, dz = pz - caps[c + 2] - t * abz;
        const R = caps[c + 6] + th + reach;
        if (dx * dx + dy * dy + dz * dz < R * R) cand[i * MAXC + ncand[i]++] = k;
      }
    }
  }

  function solvePairs(P, R, aS, aC, h2, vertFlags, aV, unilateral = false) {
    for (let k = 0, n = R.length; k < n; k++) {
      const a = P[2 * k], b = P[2 * k + 1], wa = w[a], wb = w[b], W = wa + wb;
      if (W === 0) continue;
      const ia = 3 * a, ib = 3 * b;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L < 1e-9) continue;
      const C = L - R[k];
      if (unilateral && C > 0) continue;
      const alpha = (vertFlags && vertFlags[k] ? aV : (C > 0 ? aS : aC)) / h2;
      const s = -C / (W + alpha) / L;
      x[ia] += wa * s * dx; x[ia + 1] += wa * s * dy; x[ia + 2] += wa * s * dz;
      x[ib] -= wb * s * dx; x[ib + 1] -= wb * s * dy; x[ib + 2] -= wb * s * dz;
    }
  }

  // mirror separation along the lateral axis (front panels / back vent never cross)
  let lx = 1, ly = 0, lz = 0;
  function separate() {
    for (let k = 0, n = mirRest.length; k < n; k++) {
      const a = M[2 * k], b = M[2 * k + 1], W = w[a] + w[b];
      if (!W) continue;
      const ia = 3 * a, ib = 3 * b;
      const sep = (x[ia] - x[ib]) * lx + (x[ia + 1] - x[ib + 1]) * ly + (x[ia + 2] - x[ib + 2]) * lz;
      const gap = Math.max(0, Math.min(mirRest[k], prm.mirrorGap));   // never allow a crossing, even if the morphed bind has one
      if (sep >= gap) continue;
      const c = (gap - sep) / W;
      x[ia] += w[a] * c * lx; x[ia + 1] += w[a] * c * ly; x[ia + 2] += w[a] * c * lz;
      x[ib] -= w[b] * c * lx; x[ib + 1] -= w[b] * c * ly; x[ib + 2] -= w[b] * c * lz;
    }
  }

  /**
   * One fixed step. f = { anchors: Float32Array(N*3) skinned targets now, caps: Float32Array(K*7) [a, b, r] now,
   *   floorY, lateral: [x,y,z] unit (character's left), air: [x,y,z] air velocity relative to the character,
   *   limit: Uint8Array(K) 1 = the capsule pushes the cloth out no further than its skinned target (arms, hands) }.
   */
  function step(f) {
    const dt = 1 / prm.hz, S = prm.substeps, h = dt / S, h2 = h * h;
    if (!started) reset(f.anchors);
    A0.set(A1); A1.set(f.anchors);
    // teleport / broken state -> restart from the skinned pose
    let jump = 0;
    for (let i = 0; i < N; i++) {
      if (w[i]) continue;
      const o = 3 * i;
      jump = Math.max(jump, Math.abs(A1[o] - A0[o]), Math.abs(A1[o + 1] - A0[o + 1]), Math.abs(A1[o + 2] - A0[o + 2]));
    }
    if (jump > prm.teleport) { reset(f.anchors); C0 = null; }
    const K = f.caps.length / 7;
    if (!C0 || C0.length !== f.caps.length) C0 = Float32Array.from(f.caps);
    if (capsNow.length !== f.caps.length) { capsNow = new Float32Array(f.caps.length); capVel = new Float32Array(f.caps.length); }
    for (let j = 0; j < f.caps.length; j++) capVel[j] = (f.caps[j] - C0[j]) / dt;
    candidates(prm.collide === false ? new Float32Array(0) : f.caps, dt);
    const LY = f.layer && f.layer.length && prm.collide !== false ? f.layer : null;
    if (LY) {
      if (!L0 || L0.length !== LY.length) L0 = Float32Array.from(LY);
      layerCandidates(LY);
    }
    const thL = prm.layerThickness, depthL = prm.layerDepth, sided = prm.layerSided;
    triNormals(nrm, x, sim.tris);
    const g = -9.81 * prm.gravityScale;
    const [airx, airy, airz] = f.air || [0, 0, 0];
    [lx, ly, lz] = f.lateral || [1, 0, 0];
    const kIso = Math.min(1, prm.drag * h), kNor = Math.min(1, prm.dragNormal * h), kDamp = Math.min(1, prm.damping * 10 * h);
    // bending (skip-one pairs, nearly collinear with the edges) is only stable with one pass per substep while it
    // stays softer than the edges: its compliance is floored at bendFloor * h^2 (stiffness then scales with substeps)
    const aFloor = prm.bendFloor * h2;
    const aS = compliance(prm.stretch), aC = compliance(prm.compress);
    const aB = Math.max(aFloor, compliance(prm.bend)), aV = Math.max(aFloor, compliance(prm.bendVertical));
    const limit = f.limit || null;
    // friction = fraction of the relative tangential velocity lost per 1/hz step in contact (spread over the substeps)
    const th = prm.thickness, floor = (f.floorY ?? 0) + th;
    const fr = 1 - (1 - Math.min(1, prm.friction)) ** (1 / S), ffr = 1 - (1 - Math.min(1, prm.floorFriction)) ** (1 / S);
    for (let s = 1; s <= S; s++) {
      const u = s / S;
      for (let j = 0; j < K * 7; j++) capsNow[j] = C0[j] + (f.caps[j] - C0[j]) * u;
      // predict
      for (let i = 0; i < N; i++) {
        const o = 3 * i;
        prev[o] = x[o]; prev[o + 1] = x[o + 1]; prev[o + 2] = x[o + 2];
        if (!w[i]) {
          x[o] = A0[o] + (A1[o] - A0[o]) * u; x[o + 1] = A0[o + 1] + (A1[o + 1] - A0[o + 1]) * u; x[o + 2] = A0[o + 2] + (A1[o + 2] - A0[o + 2]) * u;
          continue;
        }
        let vx = v[o], vy = v[o + 1] + g * h, vz = v[o + 2];
        const rx = vx - airx, ry = vy - airy, rz = vz - airz;
        const nx = nrm[o], ny = nrm[o + 1], nz = nrm[o + 2], rn = (rx * nx + ry * ny + rz * nz) * kNor;
        vx -= kIso * rx + rn * nx; vy -= kIso * ry + rn * ny; vz -= kIso * rz + rn * nz;
        const ax = (A1[o] - A0[o]) / dt, ay = (A1[o + 1] - A0[o + 1]) / dt, az = (A1[o + 2] - A0[o + 2]) / dt;
        vx -= kDamp * (vx - ax); vy -= kDamp * (vy - ay); vz -= kDamp * (vz - az);
        v[o] = vx; v[o + 1] = vy; v[o + 2] = vz;
        x[o] += vx * h; x[o + 1] += vy * h; x[o + 2] += vz * h;
      }
      solvePairs(B, bendRest, aB, aB, h2, BV, aV, true);   // bending resists folding only (edges own stretch)
      solvePairs(E, edgeRest, aS, aC, h2, null, 0);
      separate();
      // long-range attachments
      const slack = 1 + prm.tetherSlack;
      for (let i = 0; i < N; i++) {
        const r = tSrc[i];
        if (!w[i] || r < 0) continue;
        const o = 3 * i, q = 3 * r;
        const dx = x[o] - x[q], dy = x[o + 1] - x[q + 1], dz = x[o + 2] - x[q + 2], d2 = dx * dx + dy * dy + dz * dz;
        const L = tLen[i] * slack;
        if (d2 > L * L) { const k = L / Math.sqrt(d2); x[o] = x[q] + dx * k; x[o + 1] = x[q + 1] + dy * k; x[o + 2] = x[q + 2] + dz * k; }
      }
      // maxDistance to the skinned target
      for (let i = 0; i < N; i++) {
        if (!w[i]) continue;
        const o = 3 * i;
        const tx = A0[o] + (A1[o] - A0[o]) * u, ty = A0[o + 1] + (A1[o + 1] - A0[o + 1]) * u, tz = A0[o + 2] + (A1[o + 2] - A0[o + 2]) * u;
        const dx = x[o] - tx, dy = x[o + 1] - ty, dz = x[o + 2] - tz, d2 = dx * dx + dy * dy + dz * dz, m = maxD[i];
        if (d2 > m * m) { const k = m / Math.sqrt(d2); x[o] = tx + dx * k; x[o + 1] = ty + dy * k; x[o + 2] = tz + dz * k; }
      }
      // collisions: capsules (candidates of this step), then the floor
      for (let i = 0; i < N; i++) {
        hit[i] = 0;
        if (!w[i]) continue;
        const o = 3 * i;
        for (let q = 0; q < ncand[i]; q++) {
          const c = 7 * cand[i * MAXC + q];
          const px = x[o], py = x[o + 1], pz = x[o + 2];
          const ax = capsNow[c], ay = capsNow[c + 1], az = capsNow[c + 2];
          const abx = capsNow[c + 3] - ax, aby = capsNow[c + 4] - ay, abz = capsNow[c + 5] - az;
          const l2 = abx * abx + aby * aby + abz * abz;
          let t = l2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + t * abx, qy = ay + t * aby, qz = az + t * abz;
          const dx = px - qx, dy = py - qy, dz = pz - qz, d2 = dx * dx + dy * dy + dz * dz;
          let R = capsNow[c + 6] + th;
          if (d2 >= R * R || d2 < 1e-18) continue;
          if (limit && limit[c / 7]) {
            // arms / hands: where the skinned garment itself already lies inside the capsule (a hand hanging at
            // the coat's side), the cloth may come as close as its skinned target does - no fight with the pins
            const tx = A0[o] + (A1[o] - A0[o]) * u - ax, ty = A0[o + 1] + (A1[o + 1] - A0[o + 1]) * u - ay, tz = A0[o + 2] + (A1[o + 2] - A0[o + 2]) * u - az;
            let ta = l2 > 1e-12 ? (tx * abx + ty * aby + tz * abz) / l2 : 0;
            ta = ta < 0 ? 0 : ta > 1 ? 1 : ta;
            const dA = Math.hypot(tx - ta * abx, ty - ta * aby, tz - ta * abz);
            if (dA + prm.limitSlack < R) { R = dA + prm.limitSlack; if (d2 >= R * R) continue; }
          }
          const d = Math.sqrt(d2), k = R / d;
          x[o] = qx + dx * k; x[o + 1] = qy + dy * k; x[o + 2] = qz + dz * k;
          cn[o] = dx / d; cn[o + 1] = dy / d; cn[o + 2] = dz / d;
          hit[i] = 1;
          cv[o] = capVel[c] + t * (capVel[c + 3] - capVel[c]);
          cv[o + 1] = capVel[c + 1] + t * (capVel[c + 4] - capVel[c + 1]);
          cv[o + 2] = capVel[c + 2] + t * (capVel[c + 5] - capVel[c + 2]);
        }
        // lower layers: stay on the outer side of the nearest point's tangent plane (+ layerThickness), for the
        // nearest point of every layer part (garment) separately, so one garment (shoes) can't hide another (jeans).
        // Points deeper than layerDepth behind the plane are ignored (the particle is past a thin edge, not inside).
        if (LY) for (let p = 0; p < nParts; p++) {
          const j = lc[LAYER_PARTS * i + p];
          if (j < 0) continue;
          const b = LAYER_STRIDE * j;
          const qx = L0[b] + (LY[b] - L0[b]) * u, qy = L0[b + 1] + (LY[b + 1] - L0[b + 1]) * u, qz = L0[b + 2] + (LY[b + 2] - L0[b + 2]) * u;
          const nx = LY[b + 3], ny = LY[b + 4], nz = LY[b + 5];
          const d = (x[o] - qx) * nx + (x[o + 1] - qy) * ny + (x[o + 2] - qz) * nz;
          if (d < thL && d > -depthL) {
            if (sided) {
              // only particles that were in front of the layer at the substep start: one already behind it (past
              // a thin edge, around the back of a kicking calf) is not yanked through to the front
              const u0 = (s - 1) / S, pd = (prev[o] - L0[b] - (LY[b] - L0[b]) * u0) * nx + (prev[o + 1] - L0[b + 1] - (LY[b + 1] - L0[b + 1]) * u0) * ny + (prev[o + 2] - L0[b + 2] - (LY[b + 2] - L0[b + 2]) * u0) * nz;
              if (pd < -thL) continue;
            }
            const k = thL - d;
            x[o] += k * nx; x[o + 1] += k * ny; x[o + 2] += k * nz;
            cn[o] = nx; cn[o + 1] = ny; cn[o + 2] = nz;
            cv[o] = (LY[b] - L0[b]) / dt; cv[o + 1] = (LY[b + 1] - L0[b + 1]) / dt; cv[o + 2] = (LY[b + 2] - L0[b + 2]) / dt;
            hit[i] = 1;
          }
        }
        if (x[o + 1] < floor) { x[o + 1] = floor; hit[i] |= 2; }
      }
      separate();   // again after the collisions (a leg capsule may have pushed one panel across the other)
      // velocities + contact velocity pass
      for (let i = 0; i < N; i++) {
        const o = 3 * i;
        v[o] = (x[o] - prev[o]) / h; v[o + 1] = (x[o + 1] - prev[o + 1]) / h; v[o + 2] = (x[o + 2] - prev[o + 2]) / h;
        if (!hit[i]) continue;
        if (hit[i] & 1) {
          const rx = v[o] - cv[o], ry = v[o + 1] - cv[o + 1], rz = v[o + 2] - cv[o + 2];
          const rn = rx * cn[o] + ry * cn[o + 1] + rz * cn[o + 2];
          const tx = rx - rn * cn[o], ty = ry - rn * cn[o + 1], tz = rz - rn * cn[o + 2];
          const nn = Math.min(rn, 0);
          v[o] = cv[o] + nn * cn[o] + (1 - fr) * tx; v[o + 1] = cv[o + 1] + nn * cn[o + 1] + (1 - fr) * ty; v[o + 2] = cv[o + 2] + nn * cn[o + 2] + (1 - fr) * tz;
        }
        if (hit[i] & 2) {
          if (v[o + 1] < 0) v[o + 1] = 0;
          v[o] *= 1 - ffr; v[o + 2] *= 1 - ffr;
        }
      }
    }
    C0.set(f.caps);
    if (LY) L0.set(LY);
    steps++;
    // NaN guard
    for (let i = 0; i < 3 * N; i += 97) if (!Number.isFinite(x[i])) { reset(f.anchors); break; }
    if (!Number.isFinite(x[3 * N - 1])) reset(f.anchors);
  }

  /** Edge stretch ratios (L / rest) of edges with a free end: { p50, p99, max } (of positions P, default the sim). */
  function stretch(P = x) {
    const r = [];
    for (let k = 0; k < edgeRest.length; k++) {
      const a = E[2 * k], b = E[2 * k + 1];
      if (!w[a] && !w[b]) continue;
      const L = Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]);
      r.push(L / Math.max(edgeRest[k], 1e-6));
    }
    r.sort((p, q) => p - q);
    const at = q => (r.length ? r[Math.min(r.length - 1, Math.floor(q * r.length))] : 1);
    return { p50: at(0.5), p99: at(0.99), max: r.length ? r[r.length - 1] : 1 };
  }

  /**
   * Free particles inside a capsule (deeper than tol) / below the floor, for the given collider set. limit: the
   * anchor-limited capsules (as in step(): their radius shrinks to the skinned target's distance + limitSlack).
   */
  function penetrations(caps, floorY = 0, tol = 0.002, limit = null) {
    let n = 0, worst = 0, below = 0;
    const K = caps.length / 7;
    for (let i = 0; i < N; i++) {
      if (!w[i]) continue;
      const o = 3 * i;
      if (x[o + 1] < floorY - tol) below++;
      for (let k = 0; k < K; k++) {
        const c = 7 * k, abx = caps[c + 3] - caps[c], aby = caps[c + 4] - caps[c + 1], abz = caps[c + 5] - caps[c + 2];
        const l2 = abx * abx + aby * aby + abz * abz;
        let t = l2 > 1e-12 ? ((x[o] - caps[c]) * abx + (x[o + 1] - caps[c + 1]) * aby + (x[o + 2] - caps[c + 2]) * abz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x[o] - caps[c] - t * abx, x[o + 1] - caps[c + 1] - t * aby, x[o + 2] - caps[c + 2] - t * abz);
        let R = caps[c + 6];
        if (limit && limit[k]) {
          let ta = l2 > 1e-12 ? ((A1[o] - caps[c]) * abx + (A1[o + 1] - caps[c + 1]) * aby + (A1[o + 2] - caps[c + 2]) * abz) / l2 : 0;
          ta = ta < 0 ? 0 : ta > 1 ? 1 : ta;
          const dA = Math.hypot(A1[o] - caps[c] - ta * abx, A1[o + 1] - caps[c + 1] - ta * aby, A1[o + 2] - caps[c + 2] - ta * abz);
          R = Math.min(R, dA + prm.limitSlack);
        }
        const depth = R - d;
        if (depth > tol) { n++; worst = Math.max(worst, depth); break; }
      }
    }
    return { count: n, worstMm: +(worst * 1000).toFixed(2), belowFloor: below };
  }

  return {
    step, reset, setParams, setRest, stretch, penetrations,
    positions: () => x, velocities: () => v, anchors: () => A1,
    get params() { return { ...prm }; },
    get steps() { return steps; }, get resets() { return resets; }, get count() { return N; },
  };
}

/** FNV-1a hash of a float array's bytes (determinism checks). */
export function hashFloats(a) {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/**
 * Runs job.n fixed steps (the same code path on the main thread and in web/cloth/worker.js). The skinned targets
 * and capsules move linearly from where the previous job ended (A0, C0) to this job's frame (A1, C1):
 *   job = { n, A0, A1, C0, C1, L0?, L1?, floorY, lateral, air: [x,y,z], limit, reset?, settle? }
 * L0/L1: lower-layer collision points [x,y,z,nx,ny,nz,part]* (web/cloth/layers.js) at the previous / this frame.
 * reset: restart from A1 (outfit change, Reset, seek), then `settle` steps with the pose held (the cloth drapes
 * before it is shown). Returns the solver positions (live array).
 */
const scratch = new WeakMap(), EMPTY = new Float32Array(0);
export function advance(solver, job) {
  let s = scratch.get(solver);
  const L1 = job.L1 || EMPTY;
  if (!s || s.A.length !== job.A1.length || s.C.length !== job.C1.length || s.L.length !== L1.length) {
    s = { A: new Float32Array(job.A1.length), C: new Float32Array(job.C1.length), L: new Float32Array(L1.length) };
    scratch.set(solver, s);
  }
  const f = { anchors: s.A, caps: s.C, floorY: job.floorY ?? 0, lateral: job.lateral, air: job.air, limit: job.limit, layer: s.L };
  if (job.reset) {
    solver.reset(job.A1);
    s.A.set(job.A1); s.C.set(job.C1); s.L.set(L1);
    for (let k = 0; k < (job.settle | 0); k++) solver.step(f);
  }
  const n = job.n | 0;
  for (let k = 1; k <= n; k++) {
    const u = k / n;
    const A0 = job.A0 || job.A1, C0 = job.C0 && job.C0.length === job.C1.length ? job.C0 : job.C1;
    const LA = job.L0 && job.L0.length === L1.length ? job.L0 : L1;
    for (let i = 0; i < s.A.length; i++) s.A[i] = A0[i] + (job.A1[i] - A0[i]) * u;
    for (let i = 0; i < s.C.length; i++) s.C[i] = C0[i] + (job.C1[i] - C0[i]) * u;
    for (let i = 0; i < s.L.length; i++) s.L[i] = LA[i] + (L1[i] - LA[i]) * u;
    solver.step(f);
  }
  return solver.positions();
}
