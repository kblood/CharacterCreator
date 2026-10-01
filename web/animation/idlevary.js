// Automatic idle variation (docs/ANIMATION_CLIPS.md): while the animator rests in `idle`, every so often
// play one cycle of an idle variant (idle_look / idle_breathe / idle_fidget) and fade back to idle, so a
// character never stands perfectly still for long. Plain ES module, no DOM; deterministic for a given seed
// and sequence of update(dt) calls (the viewer seeds it with 1 under ?shot).

export const IDLE_VARIANTS = ['idle_look', 'idle_breathe', 'idle_fidget'];

/** Small deterministic PRNG (mulberry32): seed -> () => [0, 1). */
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * opts: { variants (names; missing clips are skipped), seed, first (s of idle before the first variant),
 *         gap: [min, max] s of idle between variants, fade (s) }.
 * update(dt, animator) -> name of the variant it started this call, or null.
 */
export function createIdleVariation({ variants = IDLE_VARIANTS, seed = 1, first = 6, gap = [8, 14], fade = 0.6, base = 'idle' } = {}) {
  const rand = rng(seed);
  let enabled = true, waited = 0, wait = first, last = null;
  const pick = list => {
    const pool = list.length > 1 ? list.filter(v => v !== last) : list;
    return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  };
  return {
    get enabled() { return enabled; },
    setEnabled(on) { enabled = !!on; waited = 0; },
    reset() { waited = 0; wait = first; },
    update(dt, animator) {
      if (!enabled || !animator) return null;
      const st = animator.state();
      // only count time in plain idle that nothing is fading into or out of
      if (st.clip !== base || st.fading || st.paused) { if (st.clip !== base) waited = 0; return null; }
      waited += Math.max(0, Number(dt) || 0);
      if (waited < wait) return null;
      const list = variants.filter(v => animator.has?.(v) ?? true);
      if (!list.length) return null;
      const v = pick(list);
      last = v; waited = 0; wait = gap[0] + (gap[1] - gap[0]) * rand();
      animator.play(v, { fade, once: true, then: base, fadeOut: fade });
      return v;
    },
  };
}
