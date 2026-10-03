// SPDX-License-Identifier: GPL-3.0-or-later
// Rig description for the canonical humanoid: concrete bone-name maps and the pure rest-geometry
// measurement every clip receives as ctx.rig. No three.js; runs in the browser and in node.
// FROZEN by docs/ANIMATION_PLAN.md: add maps/fields, never rename or change semantics.

import { JOINT_NAMES, TIP } from './canonical.js';
import { vSub, vLen, vNorm, vDot, vCross } from './qmath.js';

/** Canonical joint -> MPFB `game_engine` bone (glTF node) name. `Root` is the root-motion bone, not a joint. */
export const MPFB_GAME_ENGINE = (() => {
  const m = { hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head: 'head' };
  const fingers = { Thumb: ['thumb', ['Metacarpal', 'Proximal', 'Distal']], Index: ['index', ['Proximal', 'Intermediate', 'Distal']],
    Middle: ['middle', ['Proximal', 'Intermediate', 'Distal']], Ring: ['ring', ['Proximal', 'Intermediate', 'Distal']],
    Little: ['pinky', ['Proximal', 'Intermediate', 'Distal']] };
  for (const [s, x] of [['left', '_l'], ['right', '_r']]) {
    Object.assign(m, { [`${s}Shoulder`]: `clavicle${x}`, [`${s}UpperArm`]: `upperarm${x}`, [`${s}LowerArm`]: `lowerarm${x}`,
      [`${s}Hand`]: `hand${x}`, [`${s}UpperLeg`]: `thigh${x}`, [`${s}LowerLeg`]: `calf${x}`, [`${s}Foot`]: `foot${x}`, [`${s}Toes`]: `ball${x}` });
    for (const [f, [b, segs]] of Object.entries(fingers)) segs.forEach((g, i) => { m[`${s}${f}${g}`] = `${b}_0${i + 1}${x}`; });
  }
  return m;
})();
/** Bone that carries root motion / the pelvis-height offset in exported clips. */
export const MPFB_ROOT_BONE = 'Root';

/**
 * Rest joint heads (character frame) from the joints sidecar (output/base_body.joints.json) for given
 * morph influences ({ morphName: weight }, e.g. sliderInfluences(values) from character.js).
 */
export function headsFromSidecar(sidecar, influences = {}, map = MPFB_GAME_ENGINE) {
  const heads = {};
  for (const j of JOINT_NAMES) {
    const b = map[j], p = b && sidecar.bones[b];
    if (!p) continue;
    const h = [p[0], p[1], p[2]];
    for (const [m, w] of Object.entries(influences)) {
      const d = w && sidecar.morphs?.[m]?.[b];
      if (d) { h[0] += w * d[0]; h[1] += w * d[1]; h[2] += w * d[2]; }
    }
    heads[j] = h;
  }
  return heads;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, vDot(vNorm(u), vNorm(v)))));

/**
 * Rest geometry of the current body (the value clips get as ctx.rig). `heads` = { joint: [x,y,z] } in the
 * character frame, rest pose, morphs applied. Requires at least the leg, arm, hips/spine/head joints.
 */
export function restGeometry(heads) {
  const dir = {}, len = {};
  for (const j of JOINT_NAMES) {
    const t = TIP[j];
    if (heads[j] && t && heads[t]) { const d = vSub(heads[t], heads[j]); len[j] = vLen(d); dir[j] = vNorm(d); }
  }
  const axes = {}, restBend = {};
  for (const s of ['left', 'right']) {
    const ua = dir[`${s}UpperArm`], la = dir[`${s}LowerArm`];
    const fallback = vNorm(vCross(ua, [0, 0, 1]));            // forearm flexes towards +Z
    restBend[`${s}LowerArm`] = angle(ua, la);
    let h = restBend[`${s}LowerArm`] > 10 * Math.PI / 180 ? vNorm(vCross(ua, la)) : fallback;
    if (vDot(h, fallback) < 0) h = h.map(v => -v);
    axes[`${s}LowerArm`] = h;                                  // + angle = elbow flexion
    axes[`${s}LowerLeg`] = [1, 0, 0];                          // + angle = knee flexion (rest bend too small to derive)
    restBend[`${s}LowerLeg`] = angle(dir[`${s}UpperLeg`], dir[`${s}LowerLeg`]);
  }
  const side = f => mean(['left', 'right'].map(f));
  return {
    heads, dir, len, axes, restBend,
    legLength: side(s => len[`${s}UpperLeg`] + len[`${s}LowerLeg`]),        // hip -> knee -> ankle
    armLength: side(s => len[`${s}UpperArm`] + len[`${s}LowerArm`]),        // shoulder -> elbow -> wrist
    hipHeight: side(s => heads[`${s}UpperLeg`][1]),
    height: heads.head[1],                                                  // head JOINT height (not skull top)
    ankleHeight: side(s => heads[`${s}Foot`][1]),
    toesHeight: side(s => heads[`${s}Toes`][1]),
    footLength: side(s => len[`${s}Foot`]),                                 // ankle -> ball
    hipWidth: Math.abs(heads.leftUpperLeg[0] - heads.rightUpperLeg[0]),
    shoulderWidth: Math.abs(heads.leftUpperArm[0] - heads.rightUpperArm[0]),
  };
}
