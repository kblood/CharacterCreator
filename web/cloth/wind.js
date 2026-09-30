// Wind for the cloth runtime (pure, deterministic): a steady breeze from the character's front-left plus slow
// gusts (sum of incommensurate sines, no random state), so a filmstrip or a test reproduces exactly.
// strength 0..1 (UI slider x ccCloth.wind) -> up to MAX m/s.
export const WIND_MAX = 6;
const DIR = (() => { const d = [0.55, 0, -0.83]; const l = Math.hypot(...d); return d.map(c => c / l); })();

/** Air velocity (m/s, world) at time t for strength s. */
export function windVelocity(s, t) {
  if (!(s > 0)) return [0, 0, 0];
  const gust = 0.75 + 0.18 * Math.sin(t * 1.7) + 0.12 * Math.sin(t * 4.3 + 1.3) + 0.06 * Math.sin(t * 9.1 + 0.4);
  const v = s * WIND_MAX * gust;
  const swirl = 0.15 * Math.sin(t * 0.9 + 2.1);
  return [v * (DIR[0] + swirl * DIR[2]), 0.05 * v * Math.sin(t * 2.3), v * (DIR[2] - swirl * DIR[0])];
}
