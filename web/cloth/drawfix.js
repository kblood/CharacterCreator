// Drawn-frame contacts (pure JS, no three.js; docs/CLOTH_RUNTIME.md "Drawn-frame contacts").
// The drawn cloth is x_sim + (A_now - A_ref) (runtime.js lag compensation): positions solved against the capsules /
// lower layers of the frame the job was sent in (the worker's result is one frame late; the sync path drops the
// fixed-step remainder) and then shifted rigidly with the skinned anchors. A running shin moves 5-8 cm per frame,
// far more than its coat anchor, so the drawn panel lay inside the leg / jeans (tools/cloth_integrity.mjs:
// trenchcoat:jeans 9/9 bodies with the worker, 0/9 in sync). This pass projects the DRAWN free particles out of the
// colliders of the frame that is drawn; the solver state is not touched (no feedback, worker and sync stay
// bit-identical).
//   capsules: as the solver (radius + thickness, anchor-limited groups), but a particle that the motion carried past
//             the capsule axis goes back out on the side it was on in the solved frame (no tunnelling through);
//   layers:   every free particle keeps the lower-layer points it was in front of in the solved frame (nearest per
//             part within `reach`, found once per result in the reference points) and is pushed out of their
//             CURRENT tangent planes; the association follows the point (the same jeans vertex), so a leg that swung
//             into the panel pushes it, wherever the nearest point would be now. Plus the nearest point per part in
//             the drawn frame (DRAW_NEAR) when the particle was in front of that same point in the solved frame (the
//             toe of a shoe that swung forward into the coat hem since).
import { LAYER_STRIDE, LAYER_PARTS } from './layers.js';
import { limitSlackOf } from './solver.js';

export const DRAW_REACH = 0.08;    // m: layer points within this of a particle in the solved frame are its contacts
export const DRAW_NEAR = 0.04;     // m: + the nearest point per part NOW within this, if the particle was in front of it
                                   // in the solved frame (a running toe moves ~8 cm per frame: it was not near then)

/**
 * sim: buildClothModel(...).sim ({ count, pin }); params: clothParams (thickness, layerThickness, limitSlack);
 * limit: Uint8Array per capsule (colliders.js limitFlags).
 * Returns { setRef(Xref, Cref, Lref), apply(P, A, caps, L) -> particles moved }.
 *   setRef: the solved positions (sim order) and the capsules / layer points they were solved against; call once
 *           per solver result (it re-associates the layer contacts).
 *   apply:  P = drawn positions (sim order, modified in place), A = skinned anchors, caps / L = this frame's
 *           capsules / layer points.
 */
export function createDrawFix(sim, params, limit = null) {
  const N = sim.count, free = new Uint8Array(N), slack = new Float64Array(N);
  for (let i = 0; i < N; i++) { free[i] = sim.pin[i] < 0.999 ? 1 : 0; slack[i] = limitSlackOf(params, sim.pin[i]); }
  const th = params.thickness ?? 0.01, thL = params.layerThickness ?? 0.012;
  const lc = new Int32Array(N * LAYER_PARTS).fill(-1);
  const HB = 4096, head = new Int32Array(HB), headN = new Int32Array(HB);
  let next = new Int32Array(0), nextN = new Int32Array(0), Xr = null, Cr = null, Lr = null, nParts = 0;
  const bestN = new Float64Array(LAYER_PARTS), jN = new Int32Array(LAYER_PARTS);
  const key = (x, y, z) => ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & (HB - 1);

  function setRef(Xref, Cref, Lref) {
    Xr = Xref; Cr = Cref; Lr = Lref && Lref.length ? Lref : null;
    lc.fill(-1); nParts = 0;
    if (!Lref || !Lref.length || !Xref) return;
    const S = LAYER_STRIDE, M = Lref.length / S, cell = DRAW_REACH, R2 = cell * cell;
    if (next.length < M) next = new Int32Array(M);
    head.fill(-1);
    for (let j = 0; j < M; j++) {
      nParts = Math.max(nParts, Math.min(LAYER_PARTS, Lref[S * j + 6] + 1));
      const k = key(Math.floor(Lref[S * j] / cell), Math.floor(Lref[S * j + 1] / cell), Math.floor(Lref[S * j + 2] / cell));
      next[j] = head[k]; head[k] = j;
    }
    const best = new Float64Array(LAYER_PARTS);
    for (let i = 0; i < N; i++) {
      if (!free[i]) continue;
      const o = 3 * i, px = Xref[o], py = Xref[o + 1], pz = Xref[o + 2];
      best.fill(R2);
      const fx = px / cell, fy = py / cell, fz = pz / cell, cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
      const sx = fx - cx < 0.5 ? -1 : 1, sy = fy - cy < 0.5 ? -1 : 1, sz = fz - cz < 0.5 ? -1 : 1;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
        for (let j = head[key(cx + a * sx, cy + b * sy, cz + c * sz)]; j >= 0; j = next[j]) {
          const q = S * j, p = Lref[q + 6];
          if (p >= LAYER_PARTS) continue;
          const dx = px - Lref[q], dy = py - Lref[q + 1], dz = pz - Lref[q + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= best[p]) continue;
          // only a point the particle is in front of (sided, like the solver): one behind it went past a thin edge
          if (dx * Lref[q + 3] + dy * Lref[q + 4] + dz * Lref[q + 5] < -thL) continue;
          best[p] = d2; lc[LAYER_PARTS * i + p] = j;
        }
      }
    }
  }

  function apply(P, A, caps, L) {
    if (!Xr) return 0;
    let moved = 0;
    const K = caps ? caps.length / 7 : 0, hasL = L && L.length && nParts;
    const S = LAYER_STRIDE, near = hasL && Lr && Lr.length === L.length, cell = DRAW_NEAR, R2 = cell * cell;
    if (near) {
      const M = L.length / S;
      if (nextN.length < M) nextN = new Int32Array(M);
      headN.fill(-1);
      for (let j = 0; j < M; j++) {
        const k = key(Math.floor(L[S * j] / cell), Math.floor(L[S * j + 1] / cell), Math.floor(L[S * j + 2] / cell));
        nextN[j] = headN[k]; headN[k] = j;
      }
    }
    for (let i = 0; i < N; i++) {
      if (!free[i]) continue;
      const o = 3 * i;
      let px = P[o], py = P[o + 1], pz = P[o + 2], hit = false;
      for (let k = 0; k < K; k++) {
        const c = 7 * k, ax = caps[c], ay = caps[c + 1], az = caps[c + 2];
        const abx = caps[c + 3] - ax, aby = caps[c + 4] - ay, abz = caps[c + 5] - az;
        const l2 = abx * abx + aby * aby + abz * abz;
        let t = l2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * abx, qy = ay + t * aby, qz = az + t * abz;
        let dx = px - qx, dy = py - qy, dz = pz - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        let R = caps[c + 6] + th;
        if (d2 >= R * R) continue;
        if (limit && limit[k]) {
          const tx = A[o] - ax, ty = A[o + 1] - ay, tz = A[o + 2] - az;
          let ta = l2 > 1e-12 ? (tx * abx + ty * aby + tz * abz) / l2 : 0;
          ta = ta < 0 ? 0 : ta > 1 ? 1 : ta;
          const dA = Math.hypot(tx - ta * abx, ty - ta * aby, tz - ta * abz);
          if (dA + slack[i] < R) { R = dA + slack[i]; if (d2 >= R * R) continue; }
        }
        // the side it was on in the solved frame (relative to the capsule then)
        let ex = 0, ey = 0, ez = 0;
        if (Cr && Cr.length === caps.length) {
          const bx = Cr[c], by = Cr[c + 1], bz = Cr[c + 2], ux = Cr[c + 3] - bx, uy = Cr[c + 4] - by, uz = Cr[c + 5] - bz;
          const m2 = ux * ux + uy * uy + uz * uz;
          let s = m2 > 1e-12 ? ((Xr[o] - bx) * ux + (Xr[o + 1] - by) * uy + (Xr[o + 2] - bz) * uz) / m2 : 0;
          s = s < 0 ? 0 : s > 1 ? 1 : s;
          ex = Xr[o] - bx - s * ux; ey = Xr[o + 1] - by - s * uy; ez = Xr[o + 2] - bz - s * uz;
        }
        let d = Math.sqrt(d2);
        if (ex * dx + ey * dy + ez * dz < 0 || d < 1e-9) {
          const el = Math.hypot(ex, ey, ez);
          if (el < 1e-9) { if (d < 1e-9) continue; } else { dx = ex; dy = ey; dz = ez; d = el; }
        }
        const k2 = R / d;
        px = qx + dx * k2; py = qy + dy * k2; pz = qz + dz * k2;
        hit = true;
      }
      if (near) {
        bestN.fill(R2); jN.fill(-1);
        const fx = px / cell, fy = py / cell, fz = pz / cell, cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
        const sx = fx - cx < 0.5 ? -1 : 1, sy = fy - cy < 0.5 ? -1 : 1, sz = fz - cz < 0.5 ? -1 : 1;
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
          for (let j = headN[key(cx + a * sx, cy + b * sy, cz + c * sz)]; j >= 0; j = nextN[j]) {
            const q = S * j, p = L[q + 6];
            if (p >= LAYER_PARTS) continue;
            const d2 = (px - L[q]) ** 2 + (py - L[q + 1]) ** 2 + (pz - L[q + 2]) ** 2;
            if (d2 >= bestN[p]) continue;
            bestN[p] = d2; jN[p] = j;
          }
        }
        for (let p = 0; p < LAYER_PARTS; p++) {
          const j = jN[p];
          if (j < 0 || j === lc[LAYER_PARTS * i + p]) continue;
          const q = S * j;
          // sided: in front of this point (its reference position / normal) in the solved frame
          if ((Xr[o] - Lr[q]) * Lr[q + 3] + (Xr[o + 1] - Lr[q + 1]) * Lr[q + 4] + (Xr[o + 2] - Lr[q + 2]) * Lr[q + 5] < -thL) continue;
          const nx = L[q + 3], ny = L[q + 4], nz = L[q + 5];
          const d = (px - L[q]) * nx + (py - L[q + 1]) * ny + (pz - L[q + 2]) * nz;
          if (d >= thL) continue;
          const k2 = thL - d;
          px += k2 * nx; py += k2 * ny; pz += k2 * nz;
          hit = true;
        }
      }
      if (hasL) for (let p = 0; p < nParts; p++) {
        const j = lc[LAYER_PARTS * i + p];
        if (j < 0) continue;
        const b = LAYER_STRIDE * j, nx = L[b + 3], ny = L[b + 4], nz = L[b + 5];
        const d = (px - L[b]) * nx + (py - L[b + 1]) * ny + (pz - L[b + 2]) * nz;
        if (d >= thL) continue;
        const k2 = thL - d;
        px += k2 * nx; py += k2 * ny; pz += k2 * nz;
        hit = true;
      }
      if (hit) { if (py < th) py = th; P[o] = px; P[o + 1] = py; P[o + 2] = pz; moved++; }   // floor (y = 0) + thickness, as the solver
    }
    return moved;
  }
  return { setRef, apply };
}
