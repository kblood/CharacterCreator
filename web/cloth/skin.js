// SPDX-License-Identifier: GPL-3.0-or-later
// CPU skinning for the cloth runtime (pure JS, no three.js). Same math as three.js skinning of a SkinnedMesh
// in 'attached' bind mode (its modelMatrix * bindMatrixInverse cancels), so the result is in WORLD space:
//   world = sum_j w_j * M_j * (base + sum_t influence_t * delta_t),   M_j = boneWorld_j * boneInverse_j * bindMatrix
// Matrices are column-major Float32Array/Float64Array(16 * joints), like three.js Matrix4.elements.

/** out = bind + sum(influence * delta) over the morph targets that move this garment (relative targets). */
export function morphBase(out, bind, targets, influences) {
  out.set(bind);
  for (let t = 0; t < targets.length; t++) {
    const w = influences[t];
    if (!w) continue;
    const d = targets[t];
    if (!d) continue;
    for (let i = 0; i < out.length; i++) out[i] += w * d[i];
  }
  return out;
}

/** out[3i..] = skinned world position of base vertex i (all vertices, or `list` of vertex indices). */
export function skinPositions(out, base, skinIndex, skinWeight, mats, list = null) {
  const n = list ? list.length : base.length / 3;
  for (let k = 0; k < n; k++) {
    const i = list ? list[k] : k;
    const x = base[3 * i], y = base[3 * i + 1], z = base[3 * i + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let j = 0; j < 4; j++) {
      const w = skinWeight[4 * i + j];
      if (!w) continue;
      const m = 16 * skinIndex[4 * i + j];
      ox += w * (mats[m] * x + mats[m + 4] * y + mats[m + 8] * z + mats[m + 12]);
      oy += w * (mats[m + 1] * x + mats[m + 5] * y + mats[m + 9] * z + mats[m + 13]);
      oz += w * (mats[m + 2] * x + mats[m + 6] * y + mats[m + 10] * z + mats[m + 14]);
    }
    out[3 * k] = ox; out[3 * k + 1] = oy; out[3 * k + 2] = oz;
  }
  return out;
}

/** Skinned normals (linear part of the blended matrix, renormalised). */
export function skinNormals(out, normals, skinIndex, skinWeight, mats) {
  const n = normals.length / 3;
  for (let i = 0; i < n; i++) {
    const x = normals[3 * i], y = normals[3 * i + 1], z = normals[3 * i + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let j = 0; j < 4; j++) {
      const w = skinWeight[4 * i + j];
      if (!w) continue;
      const m = 16 * skinIndex[4 * i + j];
      ox += w * (mats[m] * x + mats[m + 4] * y + mats[m + 8] * z);
      oy += w * (mats[m + 1] * x + mats[m + 5] * y + mats[m + 9] * z);
      oz += w * (mats[m + 2] * x + mats[m + 6] * y + mats[m + 10] * z);
    }
    const l = Math.hypot(ox, oy, oz) || 1;
    out[3 * i] = ox / l; out[3 * i + 1] = oy / l; out[3 * i + 2] = oz / l;
  }
  return out;
}

/** Column-major 4x4 multiply: out = a * b (out may not alias a or b). */
export function mat4Mul(out, o, a, ao, b, bo) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[o + 4 * c + r] = a[ao + r] * b[bo + 4 * c] + a[ao + 4 + r] * b[bo + 4 * c + 1]
        + a[ao + 8 + r] * b[bo + 4 * c + 2] + a[ao + 12 + r] * b[bo + 4 * c + 3];
    }
  }
  return out;
}

/** Area-weighted vertex normals of triangles `tris` over positions X (count = X.length / 3). */
export function triNormals(out, X, tris) {
  out.fill(0);
  for (let t = 0; t < tris.length; t += 3) {
    const a = 3 * tris[t], b = 3 * tris[t + 1], c = 3 * tris[t + 2];
    const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2];
    const vx = X[c] - X[a], vy = X[c + 1] - X[a + 1], vz = X[c + 2] - X[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (l > 1e-12) { out[i] /= l; out[i + 1] /= l; out[i + 2] /= l; }
  }
  return out;
}
