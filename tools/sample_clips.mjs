// Samples the procedural clips (web/animation/clips.js) for the NEUTRAL body into portable JSON tracks
// (docs/ANIMATION_PLAN.md section 4 D). The JSON is the input for blender/bake_clips.py and for any
// other engine that wants the clips without running our JS.
//
// Run (project root):  node tools/sample_clips.mjs [--fps 60] [--out output/animations] [--clips <module>]
//   --fps 60 (default): at 30 fps three.js' linear key interpolation lets run's toes dip ~5 mm below the floor
//   between keys; at 60 fps it is <= 1.7 mm (walk 0.8 mm).
//   --clips  alternative clip module (default web/animation/clips.js); only for testing the tool.
//
// Output: <out>/<clip>.json per clip + <out>/index.json. Keys i = 0..n are sampled at clip time i*T/n
// (T = timing(ctx).duration, n = max(2, round(T*fps))) and stored at time i/fps, so duration = n/fps,
// timeScale = T/duration and the last key equals the first (seamless loop). One-shot clips (loop false, e.g.
// jump) are sampled the same way from t = 0 to T; they also carry `next` (the clip to return to) and `events`
// (clip-time seconds of take-off / touch-down ..., scaled like the keys). rootMotion.speed / axis come from
// timing().velocity (walk_back: axis [0,0,-1], strafe_left: [1,0,0]); the travel itself is never baked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { qNormalize, qAlign } from '../web/animation/qmath.js';
import { JOINT_NAMES } from '../web/animation/canonical.js';
import { MPFB_GAME_ENGINE, MPFB_ROOT_BONE, headsFromSidecar, restGeometry } from '../web/animation/rig.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const a = { fps: 60, out: path.join(PROJECT, 'output', 'animations'), clips: path.join(PROJECT, 'web', 'animation', 'clips.js') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--fps') { a.fps = Number(v); i++; }
    else if (k === '--out') { a.out = path.resolve(v); i++; }
    else if (k === '--clips') { a.clips = path.resolve(v); i++; }
    else if (k === '-h' || k === '--help') { console.log('node tools/sample_clips.mjs [--fps 60] [--out dir] [--clips module]'); process.exit(0); }
    else throw new Error(`unknown argument ${k}`);
  }
  if (!(a.fps > 0 && a.fps <= 240)) throw new Error(`bad --fps ${a.fps}`);
  return a;
}

const r6 = v => { const x = Math.round(v * 1e6) / 1e6; return x === 0 ? 0 : x; };   // no -0 in JSON
const r4 = v => Math.round(v * 1e4) / 1e4;

export function sampleClip(clip, ctx, fps) {
  const tm = clip.timing(ctx);
  const T = tm.duration;
  if (!(T > 0) || !Number.isFinite(T)) throw new Error(`${clip.name}: bad duration ${T}`);
  const n = Math.max(2, Math.round(T * fps));
  const poses = [], contacts = { left: [], right: [] };
  for (let i = 0; i <= n; i++) {
    // i == n is sampled at exactly T; clips wrap t by duration, the contract says sample(0) == sample(T)
    const t = i * T / n;
    poses.push(clip.sample(t, ctx));
    const c = clip.contacts ? clip.contacts(t, ctx) : { left: 1, right: 1 };
    contacts.left.push(c.left ? 1 : 0); contacts.right.push(c.right ? 1 : 0);
  }
  // only joints the clip outputs (in canonical order); a joint absent in some frame is identity there
  const used = JOINT_NAMES.filter(j => poses.some(p => p.joints && p.joints[j]));
  const unknown = [...new Set(poses.flatMap(p => Object.keys(p.joints || {})))].filter(j => !JOINT_NAMES.includes(j));
  if (unknown.length) throw new Error(`${clip.name}: non-canonical joints ${unknown.join(', ')}`);
  const joints = {};
  for (const j of used) {
    let prev = [0, 0, 0, 1];
    joints[j] = poses.map(p => {
      const q = qAlign(prev, qNormalize(p.joints[j] || [0, 0, 0, 1]));
      if (q.some(v => !Number.isFinite(v))) throw new Error(`${clip.name}/${j}: non-finite quaternion`);
      prev = q;
      return q.map(r6);
    });
  }
  const root = poses.map(p => (p.root || [0, 0, 0]).map(r6));
  const duration = n / fps;
  const v = tm.velocity || [0, 0, tm.speed || 0], vl = Math.hypot(...v);
  const extra = {};
  if (clip.loop === false && clip.next) extra.next = clip.next;
  if (tm.events) extra.events = Object.fromEntries(Object.entries(tm.events).map(([k, t]) => [k, r4(t / (T / duration))]));
  return {
    format: 'charactercreator.humanoid-clip', version: 1, name: clip.name, loop: clip.loop !== false,
    fps, frames: n, duration: r4(duration), timeScale: r6(T / duration),
    frame: 'character: +X left, +Y up, +Z forward, metres; quaternions [x,y,z,w]',
    convention: 'parent-relative rest deltas, docs/ANIMATION_PLAN.md section 1',
    body: { sliders: {}, legLength: r4(ctx.rig.legLength), hipHeight: r4(ctx.rig.hipHeight), height: r4(ctx.rig.height) },
    rootMotion: { mode: 'in-place', speed: r4(vl), stride: r4(tm.stride || 0), axis: vl > 0 ? v.map(x => r6(x / vl)) : [0, 0, 1] },
    ...extra,
    rig: 'mpfb-game_engine', boneMap: MPFB_GAME_ENGINE, rootBone: MPFB_ROOT_BONE,
    root, contacts, joints,
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const { CLIPS, makeContext } = await import(pathToFileURL(a.clips).href);
  const sidecar = JSON.parse(fs.readFileSync(path.join(PROJECT, 'output', 'base_body.joints.json'), 'utf8'));
  const rig = restGeometry(headsFromSidecar(sidecar, {}));
  const ctx = makeContext(rig);
  fs.mkdirSync(a.out, { recursive: true });
  const names = [];
  for (const [key, clip] of Object.entries(CLIPS)) {
    const c = { ...clip, name: clip.name || key };
    const data = sampleClip(c, ctx, a.fps);
    fs.writeFileSync(path.join(a.out, `${data.name}.json`), JSON.stringify(data));
    names.push(data.name);
    console.log(`SAMPLE ${data.name.padEnd(5)} frames ${data.frames} duration ${data.duration}s timeScale ${data.timeScale}` +
      ` joints ${Object.keys(data.joints).length} speed ${data.rootMotion.speed} m/s axis ${data.rootMotion.axis} stride ${data.rootMotion.stride} m` +
      (data.loop ? '' : ` one-shot -> ${data.next}`));
  }
  fs.writeFileSync(path.join(a.out, 'index.json'),
    JSON.stringify({ clips: names, boneMap: MPFB_GAME_ENGINE, rootBone: MPFB_ROOT_BONE }, null, 1));
  const rel = path.relative(PROJECT, a.out);
  console.log(`SAMPLE done ${names.length} clips -> ${rel && !rel.startsWith('..') ? rel : a.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('SAMPLE FAILED', e.message); process.exit(1); });
}
