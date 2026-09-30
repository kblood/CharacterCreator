// Body colliders for the cloth runtime (pure JS): output/body_colliders.json "cloth" set (tools/make_colliders.mjs)
// evaluated on the LIVE skeleton every frame. Capsule ends = from + t0 * (to - from) .. from + t1 * (to - from) of
// the posed joint world positions (bone heads; applySkeleton already moved them for the sliders), radius =
// radius + sum(influence * radiusMorphs[morph]) with the same influences as the morph targets (correctives
// included), times the character's world scale.

/** json = body_colliders.json. Returns the capsule definitions for cloth (the thick set, or the base set). */
export function clothColliderDefs(json) {
  const set = json?.cloth?.capsules;
  if (set?.length) return set.map(c => ({ ...c, t0: c.t0 ?? 0, t1: c.t1 ?? 1 }));
  return (json?.capsules || []).filter(c => !c.sphere).map(c => ({ ...c, t0: 0, t1: 1 }));
}

/**
 * Uint8Array flags: 1 = anchor-limited capsule for a garment whose ccCloth.limit lists the capsule's clothLimit
 * group ('arms', 'hips', 'thighs'; see tools/make_colliders.mjs and the collisions in solver.js).
 */
export function limitFlags(defs, groups = 'arms,hips') {
  const gs = new Set(String(groups || '').split(',').map(s => s.trim()).filter(Boolean));
  return Uint8Array.from(defs, d => (d.clothLimit && gs.has(d.clothLimit === true ? 'arms' : d.clothLimit) ? 1 : 0));
}

/**
 * out: Float32Array(defs.length * 7) [ax, ay, az, bx, by, bz, r]. jointPos(name) -> [x, y, z] world or null.
 * influences: { morphName: weight } (character.js sliderInfluences). scale: world scale of the character.
 */
export function evalColliders(out, defs, jointPos, influences, scale = 1) {
  for (let k = 0; k < defs.length; k++) {
    const d = defs[k], A = jointPos(d.from), B = jointPos(d.to), o = 7 * k;
    if (!A || !B) { out.fill(0, o, o + 7); out[o + 1] = -100; out[o + 4] = -100; continue; }   // far below the floor
    for (let c = 0; c < 3; c++) {
      out[o + c] = A[c] + (B[c] - A[c]) * d.t0;
      out[o + 3 + c] = A[c] + (B[c] - A[c]) * d.t1;
    }
    let r = d.radius;
    for (const [m, dr] of Object.entries(d.radiusMorphs || {})) r += (influences?.[m] || 0) * dr;
    out[o + 6] = Math.max(0.005, r * scale);
  }
  return out;
}
