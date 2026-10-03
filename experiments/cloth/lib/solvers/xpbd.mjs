// SPDX-License-Identifier: GPL-3.0-or-later
// D) Minimal own XPBD cloth (plain JS, no deps). Substepped XPBD with 1 iteration per substep
// (Macklin et al. 2019 "small steps"): distance (stretch + shear), skip-one distance bending,
// per-vertex maxDistance to the skinned position (mask), capsule colliders interpolated per substep,
// air drag relative to the wind. Contacts: position projection + a velocity pass relative to the capsule
// surface velocity (without it a fast knee launched the skirt up during run). Deterministic: fixed order.
export const name = 'xpbd';

export function createSolver(g, body, frame0, pin0, P = {}) {
  const prm = {
    substeps: 10, stretchCompliance: 0, shearCompliance: 1e-6, bendCompliance: 2e-3,
    damping: 0.4, gravity: [0, -9.81, 0], wind: [0, 0, 0], thickness: 0.008, maxDistance: 0.6, friction: 0.3, ...P,
  };
  const N = g.count;
  const x = Float32Array.from(pin0), prev = new Float32Array(N * 3), v = new Float32Array(N * 3);
  const w = Float32Array.from(g.mask, m => (m >= 1 ? 0 : 1));
  const maxD = Float32Array.from(g.mask, m => (1 - m) * prm.maxDistance);
  const sets = [
    [g.edges, g.edgeRest, prm.stretchCompliance],
    [g.shear, g.shearRest, prm.shearCompliance],
    [g.bends, g.bendRest, prm.bendCompliance],
  ];
  let capsPrev = frame0.capsules, pinPrev = Float32Array.from(pin0);
  const lerp = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];

  function solveDistance(E, R, alpha, h2) {
    const a_ = alpha / h2;
    for (let k = 0, n = R.length; k < n; k++) {
      const a = E[2 * k], b = E[2 * k + 1], wa = w[a], wb = w[b], W = wa + wb;
      if (W === 0) continue;
      const dx = x[3 * a] - x[3 * b], dy = x[3 * a + 1] - x[3 * b + 1], dz = x[3 * a + 2] - x[3 * b + 2];
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L < 1e-9) continue;
      const lam = -(L - R[k]) / (W + a_) / L;
      x[3 * a] += wa * lam * dx; x[3 * a + 1] += wa * lam * dy; x[3 * a + 2] += wa * lam * dz;
      x[3 * b] -= wb * lam * dx; x[3 * b + 1] -= wb * lam * dy; x[3 * b + 2] -= wb * lam * dz;
    }
  }

  // contact per particle this substep: normal + capsule surface velocity (for the velocity pass)
  const hit = new Uint8Array(N), cn = new Float32Array(N * 3), cv = new Float32Array(N * 3);
  function collide(caps, capsBefore, h) {
    const th = prm.thickness;
    hit.fill(0);
    for (let i = 0; i < N; i++) {
      if (!w[i]) continue;
      for (let k = 0; k < caps.length; k++) {
        const c = caps[k];
        const px = x[3 * i], py = x[3 * i + 1], pz = x[3 * i + 2];
        const abx = c.b[0] - c.a[0], aby = c.b[1] - c.a[1], abz = c.b[2] - c.a[2];
        let t = ((px - c.a[0]) * abx + (py - c.a[1]) * aby + (pz - c.a[2]) * abz) / (abx * abx + aby * aby + abz * abz);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = c.a[0] + t * abx, qy = c.a[1] + t * aby, qz = c.a[2] + t * abz;
        const dx = px - qx, dy = py - qy, dz = pz - qz, d = Math.sqrt(dx * dx + dy * dy + dz * dz), R = c.r + th;
        if (d >= R || d < 1e-9) continue;
        const s = R / d;
        x[3 * i] = qx + dx * s; x[3 * i + 1] = qy + dy * s; x[3 * i + 2] = qz + dz * s;
        // surface velocity of the capsule axis point with the same t (capsule moved since the last substep)
        const b = capsBefore[k];
        const q0x = b.a[0] + t * (b.b[0] - b.a[0]), q0y = b.a[1] + t * (b.b[1] - b.a[1]), q0z = b.a[2] + t * (b.b[2] - b.a[2]);
        hit[i] = 1;
        cn[3 * i] = dx / d; cn[3 * i + 1] = dy / d; cn[3 * i + 2] = dz / d;
        cv[3 * i] = (qx - q0x) / h; cv[3 * i + 1] = (qy - q0y) / h; cv[3 * i + 2] = (qz - q0z) / h;
      }
    }
  }
  // velocity pass for contacts: the projection must not launch cloth faster than the surface moves
  // (normal velocity clamped to the capsule's, tangential velocity relative to it reduced by friction)
  function contactVelocities() {
    const f = prm.friction;
    for (let i = 0; i < N; i++) {
      if (!hit[i]) continue;
      const o = 3 * i;
      const rx = v[o] - cv[o], ry = v[o + 1] - cv[o + 1], rz = v[o + 2] - cv[o + 2];
      const rn = rx * cn[o] + ry * cn[o + 1] + rz * cn[o + 2];
      const tx = rx - rn * cn[o], ty = ry - rn * cn[o + 1], tz = rz - rn * cn[o + 2];
      const n = Math.min(rn, 0) + 0;                      // separating relative velocity -> 0 (no bounce)
      v[o] = cv[o] + n * cn[o] + (1 - f) * tx; v[o + 1] = cv[o + 1] + n * cn[o + 1] + (1 - f) * ty; v[o + 2] = cv[o + 2] + n * cn[o + 2] + (1 - f) * tz;
    }
  }

  function step(frame, pin, dt) {
    const S = prm.substeps, h = dt / S, h2 = h * h, [gx, gy, gz] = prm.gravity, [wx, wy, wz] = prm.wind;
    const drag = Math.min(1, prm.damping * h);
    let capsBefore = capsPrev;
    for (let s = 1; s <= S; s++) {
      const u = s / S;
      const caps = frame.capsules.map((c, k) => ({ a: lerp(capsPrev[k].a, c.a, u), b: lerp(capsPrev[k].b, c.b, u), r: c.r }));
      for (let i = 0; i < N; i++) {
        const o = 3 * i;
        prev[o] = x[o]; prev[o + 1] = x[o + 1]; prev[o + 2] = x[o + 2];
        if (!w[i]) {                       // kinematic: follow the skinned target
          for (let c = 0; c < 3; c++) x[o + c] = pinPrev[o + c] + (pin[o + c] - pinPrev[o + c]) * u;
          continue;
        }
        v[o] += (gx - 0) * h - drag * (v[o] - wx); v[o + 1] += gy * h - drag * (v[o + 1] - wy); v[o + 2] += gz * h - drag * (v[o + 2] - wz);
        x[o] += v[o] * h; x[o + 1] += v[o + 1] * h; x[o + 2] += v[o + 2] * h;
      }
      for (const [E, R, a] of sets) solveDistance(E, R, a, h2);
      // maxDistance (mask) to the skinned position
      for (let i = 0; i < N; i++) {
        if (!w[i] || maxD[i] >= prm.maxDistance) continue;
        const o = 3 * i, tx = pinPrev[o] + (pin[o] - pinPrev[o]) * u, ty = pinPrev[o + 1] + (pin[o + 1] - pinPrev[o + 1]) * u, tz = pinPrev[o + 2] + (pin[o + 2] - pinPrev[o + 2]) * u;
        const dx = x[o] - tx, dy = x[o + 1] - ty, dz = x[o + 2] - tz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > maxD[i]) { const k = maxD[i] / d; x[o] = tx + dx * k; x[o + 1] = ty + dy * k; x[o + 2] = tz + dz * k; }
      }
      collide(caps, capsBefore, h);
      for (let i = 0; i < 3 * N; i++) v[i] = (x[i] - prev[i]) / h;
      contactVelocities();
      capsBefore = caps;
    }
    capsPrev = frame.capsules; pinPrev = Float32Array.from(pin);
  }
  return { step, positions: () => x, params: prm, dispose() {} };
}
