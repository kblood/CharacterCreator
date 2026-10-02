// Fixed, seeded input perturbations for chaotic cloth cases (tests/cloth.test.mjs). The cloth solver is
// deterministic, but some cases are chaotic: moving a lower layer by ~1e-7 m (about one float32 ulp at 1 m) flips
// pass / fail. A single run is therefore a coin toss; tests assert over a FIXED set of perturbations instead, so the
// result is reproducible (same seeds -> same numbers) and measures the case, not one lucky / unlucky build.
//   perturbGarment(D, id, seed, amp) -> a shallow copy of D whose garment `id` has its bind positions moved by a
//   seeded +-amp per coordinate (seed 0 = unperturbed). D itself is not modified.

/** mulberry32: small deterministic PRNG (same sequence on every platform). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function perturbGarment(D, id, seed, amp = 1e-7) {
  if (!seed) return D;
  const g = D.garments[id];
  const rnd = mulberry32(seed), positions = Float32Array.from(g.positions);
  for (let i = 0; i < positions.length; i++) positions[i] += (rnd() < 0.5 ? -amp : amp);
  return { ...D, garments: { ...D.garments, [id]: { ...g, positions } } };
}
