# Cloth solver report

**Question.** CharacterCreator needs to decide three things:
- which cloth solver to use for garments (skirt, dress, cape);
- how to simulate hair and loose parts;
- how to store the cloth data so it works in three.js now and in Unity, Unreal or Godot later.

**Short answer.**
- **Garments in the browser:** use our own small XPBD solver in plain JS (candidate D). It was the only solver with 0 collision penetrations in all 12 test runs. It is also stable, deterministic and about 2 KB gzipped.
- **Jolt soft body** is the fallback option. It was the fastest at 2048 particles. But at that resolution the skirt flips up in about 40 % of the frames.
- **Hair and loose parts:** use VRM spring bones.
- **Data format:** glTF with the custom vertex attribute `_CLOTH_PIN` as the cloth mask (see [CLOTH_SPEC.md](CLOTH_SPEC.md); this report first proposed `COLOR_0.r`, see section 6), plus a small `extras.cloth` block for parameters, and colliders defined as capsules between canonical joints.

All numbers come from the experiment in `experiments/cloth/`; its README lists the commands to reproduce them.

## 1. Setup

**Timeline.** The real `web/animation` animator runs on a fake bone hierarchy, headless in node and identically in Chrome:
- 1 s of idle to let the cloth settle (not measured);
- then 10 s at 60 Hz: walk 0–3 s, run 3–5.5 s, idle 5.5–7.5 s, idle→run 7.5–10 s;
- all transitions are 0.3 s crossfades, and root travel is included (about 16 m in total).

The animation fingerprint is `c1e70ee4`. The run clip was being reworked in parallel while this ran, so re-running later may give slightly different numbers.

**Bodies.** Six bodies: neutral, tall, short, heavy, child and old. Each is the slider-morphed `base_body.glb` with the matching joint heads.

**Garment.** A procedural A-line skirt from the waist to just below the knee, fitted to each body's silhouette.
- Two resolutions: 32×16 = **512** particles and 64×32 = **2048** particles.
- Mask: the waistband row is 1 (it follows the hips rigidly); every other row is 0 (fully simulated).

**Colliders.** 8 capsules: pelvis, torso, thigh L/R, knee L/R and shin L/R.
- Each capsule runs between two canonical joints.
- The radius is the 75th percentile of the distances of that bone's own vertices, measured separately for each body.
- Hair uses different colliders: a head sphere, the neck, the chest and both shoulders.

**What was measured.**

| Measure | Definition |
|---|---|
| Penetration event | A particle more than 5 mm inside a capsule, counted once per frame |
| Deep event | A particle more than 20 mm inside a capsule |
| Stretch | Edge length divided by rest length, for down edges and ring edges separately |
| Idle jitter | RMS second difference in hips space over the last 1 s of idle |
| Hem rise / flipped frames | How far the mean hem height rises above rest; a frame counts as flipped when it rises more than 10 cm (skirt flipped up or bunched at the waist) |
| Determinism | An FNV hash of every position in every frame |
| Timing | ms per frame for `step()` plus reading the positions back |

- **Machine:** Ryzen 7 5700G, node 24.6, HeadlessChrome 154; WebGPU ran on an NVIDIA Ampere adapter.
- **Screenshots:** mid-walk (t = 1.5 s), mid-run (4.2 s) and idle→run (8.4 s), front-3/4 and side views, all inspected.

## 2. Candidates: install size and license

Licenses were read from the `LICENSE` file inside each installed package.

| | Version | License | Runtime payload | gzip / brotli | npm unpacked |
|---|---|---|---|---|---|
| **A** Rapier soft body | `@dimforge/rapier3d(-compat)` 0.21.0 | Apache-2.0 | `.wasm` 3010 KB (or compat `rapier.mjs` 4239 KB, with the wasm inlined as base64) | 1148 / 832 KB (compat: 1606 / 1168 KB) | 5.1 MB (compat 14.5 MB) |
| **B** Jolt soft body | `jolt-physics` 1.1.0 (JoltPhysics.js) | MIT (Jorrit Rouwe) | `.wasm` 1974 KB + JS 942 KB (or compat 3147 KB) | 730+135 / 495+92 KB (compat: 892 / 607 KB) | 44 MB (many builds) |
| **C** three-simplecloth | 0.0.6 | MIT (bandinopla) | 12 KB, but needs three **r182** and the WebGPU renderer (the viewer uses r170 WebGL) | 5 / 4 KB | 98 KB |
| **D** own XPBD | `lib/solvers/xpbd.mjs`, about 110 lines | own code | 6 KB | 2 / 2 KB | – |
| **E** VRM spring bones | `@pixiv/three-vrm-springbone` 3.5.5 | MIT (pixiv) | 24 KB minified | 6 / 5 KB | 0.5 MB |

What each candidate supports:

| | Per-vertex max distance (mask) | Colliders | Notes |
|---|---|---|---|
| A Rapier | No; pins are binary only (`setPinnedParticles`) | Real rigid bodies, any shape | Soft bodies are a new API in the 0.2x line (this test used 0.21.0) |
| B Jolt | Yes: skinned constraints with `MaxDistance` and `BackStop` (tested, see section 3) | Real rigid bodies, any shape | |
| C three-simplecloth | Blends skinned and simulated positions by colour | Spheres only | Mask is read from the colour **G** channel; structural springs only (no bending); explicit integration with a per-step clamp of 1 cm; drag depends on the step rate |
| D own XPBD | Yes: `(1-mask)·maxDistance` | Capsules | Distance, shear and bending constraints; wind; friction relative to the collider's velocity |
| E spring bones | No; chains only | Sphere and capsule | Standardised as the glTF extension `VRMC_springBone` |

## 3. Results: skirt

The skirt runs on 6 bodies for 10 s each. Penetration events and flipped frames are summed over the 6 bodies. Max depth, stretch, jitter and hem rise are the maximum over the 6 bodies. Timings are in section 3.2.

### 3.1 Stability and collision

| Solver | Particles | Penetration events | Deep (>20 mm) | Max depth (mm) | Max down stretch | Max ring stretch | Idle jitter (mm) | Hem rise max (mm) | Flipped frames | Exploded | Deterministic |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **D XPBD** | 512 | **0** | 0 | 0 | 1.36 | 1.37 | 0.86 | 99 | **0** | none | yes |
| **D XPBD** | 2048 | **0** | 0 | 0 | 1.96 | 1.63 | 0.79 | 138 | 93 | none | yes |
| A Rapier | 512 | 12 | 0 | 11.8 | 1.91 | 1.82 | 3.46 | 88 | 0 | none | yes |
| A Rapier | 2048 | 18 | 0 | 9.6 | 2.73 | 2.69 | 1.71 | 158 | 318 | none | yes |
| B Jolt | 512 | **0** | 0 | 0 | 1.52 | 1.84 | 1.17 | 122 | 6 | none | yes |
| B Jolt | 2048 | 221 | 1 | 20.0 | 2.60 | 2.78 | 1.39 | **296** | **1469** | none | yes |
| E spring bones | 512 | 1913 | 351 | 68 | 1 (rigid) | **10.3** | 0.006 | 250 | 922 | none | yes |
| E spring bones | 2048 | 3820 | 1017 | 72 | 1 (rigid) | **19.0** | 0.20 | 263 | 1033 | none | yes |
| C simplecloth, default settings | 512 | 3,205 | 99 | 67 | 8.8 | 8.8 | 6.5 | 567 | 1,874 | stretch 6–9× | yes |
| C simplecloth, default settings | 2048 | 7,117 | 99 | 40 | **87** | 59 | 4.7 | 259 | 536 | stretch 15–87× | yes |
| C simplecloth, tuned (0.35 / 0.99 / 1440 steps per s) | 512 | 1,537 | 0 | 6.1 | 1.99 | 2.01 | 13.8 | 635 | 3,451 (all frames) | crumpled | yes |
| C simplecloth, tuned (0.35 / 0.99 / 1440 steps per s) | 2048 | 2,039 | 0 | 6.1 | 3.28 | 3.29 | 8.1 | 671 | 3,002 (all frames) | crumpled | yes |

Per body, as penetration events / hem rise in mm / flipped frames:

| Solver | Particles | neutral | tall | short | heavy | child | old |
|---|---|---|---|---|---|---|---|
| D XPBD | 512 | 0 / 71 / 0 | 0 / 99 / 0 | 0 / 31 / 0 | 0 / 72 / 0 | 0 / 67 / 0 | 0 / 80 / 0 |
| D XPBD | 2048 | 0 / 101 / 1 | 0 / 138 / 69 | 0 / 60 / 0 | 0 / 108 / 7 | 0 / 104 / 3 | 0 / 106 / 13 |
| A Rapier | 512 | 0 / 69 / 0 | 0 / 88 / 0 | 3 / 37 / 0 | 0 / 72 / 0 | 8 / 62 / 0 | 1 / 78 / 0 |
| A Rapier | 2048 | 1 / 124 / 38 | 9 / 158 / 129 | 0 / 85 / 0 | 6 / 145 / 67 | 0 / 106 / 7 | 2 / 140 / 77 |
| B Jolt | 512 | 0 / 55 / 0 | 0 / 73 / 0 | 0 / 122 / 6 | 0 / 57 / 0 | 0 / 48 / 0 | 0 / 68 / 0 |
| B Jolt | 2048 | 7 / 236 / 255 | 13 / 253 / 262 | 13 / 216 / 238 | 49 / 296 / 249 | 78 / 245 / 234 | 61 / 206 / 231 |
| E spring bones | 512 | 319 / 175 / 230 | 633 / 250 / 288 | 44 / 80 / 0 | 159 / 176 / 218 | 424 / 108 / 49 | 334 / 135 / 137 |

**Determinism.** Every solver gave the same hash when re-run on the same machine. The 4 CPU solvers also gave bit-identical hashes between node and Chrome, at both 512 and 2048 particles. For C, repeating the same configuration gave the same hash.

**What the screenshots showed.**
- **D XPBD.** The skirt drapes and swings, and stays down in run and in idle→run. At the knee the mesh pokes through slightly in places, because the knee capsule is thinner than the mesh (see Risks). The 2048 child run shows some crumpling at the hip.
  - The first XPBD version flipped the skirt up to hip level during run. The cause was that pushing a particle out of a collider handed it the full speed of the fast-moving knee.
  - The fix is a velocity pass after collision: the particle's outward normal speed is clamped to the collider surface's speed, and friction acts relative to the collider. After the fix, 0 frames were flipped at 512.
- **B Jolt.** At 512 the skirt looks clean, the smoothest of all. At 2048 the heavy body in run has the skirt bunched and folded at the waist, which matches the 1469 flipped frames.
  - Friction 0 halves the problem (hem rise 162 mm, 86 flipped frames on heavy) but does not remove it.
  - More iterations or more collision steps made it worse.
  - The Dihedral bend type exploded as soon as the cloth touched a capsule (it is stable without colliders), so the Distance bend type is used.
  - With 1 collision step (60 Hz), run exploded after the run clip was changed. 2 steps (120 Hz) is the default here.
- **A Rapier.** Looks similar to Jolt at 512, but stretchier: 1.9× at 512 and 2.7× at 2048.
  - The first settings (frequency 30, bend frequency 2, 4 iterations) gave 2.4× stretch.
  - The tuned settings (240 / 10 / 8) are what the tables use.
- **E spring bones on a skirt.** The legs cut straight through the skirt, the chains separate (ring gaps up to 19×), and the hem trails 30–40 cm behind in run. This confirms that spring bones are not suitable for skirts.
- **C simplecloth.** Default settings: the skirt streams out horizontally behind the character in run. Tuned settings: it crumples into a ring at the waist.
  - It crumples even with no colliders and during idle (hem rise 330–440 mm).
  - The likely causes are no bending resistance, an explicit spring integrator, and very heavy drag relative to the world (0.96 per step at 360 steps per second).
  - I could not rule out that part of this comes from my integration. What I did check: the unique vertex count equals the particle count, initialisation is awaited, and the rendered mesh and the read-back positions agree. It is not usable for this purpose as it is.

**Jolt skinned constraints** (the portable mask applied 1:1, `skinned: true` in `lib/solvers/jolt.mjs`). These work from JS:
- `mSkinnedConstraints` and `mInvBindMatrices` in the settings, then `SkinVertices()` every frame.
- Neutral, 512 particles, maxDistance 0.6 m: 0 penetrations, pin error 1 mm, deterministic.
- Gotcha: `mMaxDistance = 0` gives NaN; clamp it to at least 1 mm.
- With a uniform small max distance (0.05 m) the constraint fights the leg colliders and the cloth over-stretches (5×). Here the skin target is rigid on the hips, so the max distance has to be a gradient from the mask. It should not be one value for the whole garment.

### 3.2 Timing

CPU timing, single thread, neutral body, best of 3 runs (`timing.mjs`). A 60 Hz frame is 16.7 ms.

| Solver | 512: median / p95 ms | 2048: median / p95 ms | Chrome, same runs (mean ms): 512 / 2048 |
|---|---|---|---|
| D XPBD (10 substeps) | **0.81** / 1.28 | 3.57 / 6.08 | 0.90 / 4.45 |
| B Jolt (8 iterations, 2 collision steps) | 0.73 / 0.83 | **2.82** / 2.89 | 0.74 / 2.86 |
| A Rapier (8 iterations) | 17.3 / 40.4 | 75.8 / 115 | 19.3 / 78.5 |
| E spring bones | 0.57 / 0.63 | 3.99 / 5.23 | 0.76 / 4.73 |

C runs on the GPU, so it is timed separately:

| C simplecloth (WebGPU) | 512 | 2048 |
|---|---|---|
| Default settings, with per-frame readback / without readback | 3.4–4.0 / 2.4–3.1 ms | 3.7–4.9 / 2.0–2.8 ms |
| Tuned (1440 steps per s), with per-frame readback / without readback | 9.3–10.3 / 7.8–8.7 ms | 9.1–10.6 / 7.5–8.4 ms |

- C's cost is dominated by compute dispatches, not by the number of particles.
- **WebGPU in headless Chrome here:** `navigator.gpu` is available only on a secure context (`http://localhost`). On `about:blank` it is missing. The adapter is NVIDIA Ampere and not a fallback; the SwiftShader fallback adapter also works.

## 4. Results: hair

`hair.mjs` simulates 24 strands of 4 cm segments hanging from the back of the scalp, on 6 bodies over the same 10 s. The first joint of each strand is rigid on the head. The same XPBD code is used as a chain solver (distance and skip-one bending, with no links between strands).

| Solver | Joints | ms per frame | Penetration events | Deep | Max depth (mm) | Max stretch | Tip swing (mm) | Idle jitter (mm) | Deterministic |
|---|---|---|---|---|---|---|---|---|---|
| E spring bones, short hair (7 joints) | 168 | 0.195 | 0 | 0 | 0 | 1 | 269 | 0.003 | yes |
| D XPBD chains, short hair | 168 | 0.192 | 0 | 0 | 0 | 1.02 | 297 | 0.12 | yes |
| E spring bones, long hair (12 joints) | 288 | 0.40 | 315 | 10 | 25.9 | 1 | 480 | 0.008 | yes |
| D XPBD chains, long hair | 288 | 0.33 | **0** | 0 | 0 | 1.04 | 547 | 0.54 | yes |

- Both are cheap and stable. The strands clearly move: tip swing is 27–55 cm in run, and 40–180 joints per frame come within 1 cm of a collider.
- Spring bones test collision per joint only, so long strands that lie on the back and shoulders go up to 26 mm into the chest and shoulder capsules. XPBD resolves them.

## 5. Recommendations

**1. Garments in the browser: use D, own XPBD** (`lib/solvers/xpbd.mjs`, about 110 lines, no dependencies).
- It was the only solver with 0 penetrations in all 12 runs (6 bodies × 2 resolutions) and 0 flipped frames at 512.
- It costs 0.8 ms per frame at 512 particles and 3.6 ms at 2048 (single thread, desktop), and adds 2 KB gzipped.
- It is deterministic and bit-identical between node and Chrome.
- It implements exactly the portable model: mask → max distance, capsules, wind and damping. That means the same algorithm can be ported line for line to C#, GDScript or C++ if an engine lacks an equivalent.
- Budget: about 500 particles per garment. Move the solver to a Web Worker if there are several garments or the target is mobile.
- Next steps: self-collision between layers, arm colliders, and a smoother mask gradient.

**Fallback: B, Jolt**, if we need rigid-body interaction or native-engine parity. It is the fastest at 2048 with a very flat p95 (2.9 ms), and its skinned `MaxDistance` matches the mask 1:1.
- It costs about 0.9 MB of WASM gzipped.
- At 2048 the skirt flips up in about 40 % of the frames. This must be solved before we use it.

**Do not use:**
- **A Rapier:** about 20× slower (17 / 76 ms), binary pins only, more stretch.
- **C three-simplecloth:** requires three r182 WebGPU, colliders are spheres only, it does not keep a skirt's shape, and it is version 0.0.6.
- **E spring bones for skirts:** legs pass through (1900–3800 events), and the chains separate.

**2. Hair and loose parts: E, VRM spring bones.** Store them as the `VRMC_springBone` glTF extension: joints with stiffness, gravity and drag, plus sphere and capsule colliders on nodes.
- It is a published standard with runtimes for three.js (`three-vrm`), Unity (UniVRM), Godot (a VRM add-on) and Unreal (VRM4U).
- It is 6 KB gzipped, and it was stable with 0 penetrations for short hair.
- For long hair that rests on the back and shoulders, either add colliders or run the same chains through the XPBD solver: 0 penetrations, similar cost, and it reads the same data.

**3. Data format:** see section 6.

**4. Other engines:** see section 7. Everywhere, the data is the skinned garment, the mask, the parameters and the capsules. The solver is always the engine's native one; XPBD is the port only for engines where the mask cannot be expressed natively.

## 6. Portable data format

Each garment is a skinned glTF mesh on the body skeleton, exactly as garments are loaded now.

**Mask.**
- The custom vertex attribute `_CLOTH_PIN` (one float per vertex) is the cloth mask: 1 = follows the skin, 0 = fully simulated, with a smooth gradient in between. [CLOTH_SPEC.md](CLOTH_SPEC.md) is the normative definition.
- This report first proposed `COLOR_0.r`, because Blender, Unity, Unreal and Godot all import vertex colours, while underscore-prefixed custom attributes are dropped by several importers. The build uses `_CLOTH_PIN` instead, because three.js multiplies `COLOR_0` into the base colour and darkened the cloth (CLOTH_SPEC, "Deviation from a COLOR_0 mask").
- An engine that needs a vertex-colour mask copies `_CLOTH_PIN` into one channel on import, or uses the exporter's `pinAsColor` option (docs/EXPORT.md), which also writes the mask as `COLOR_0`.

**Parameters.** Mesh `extras.cloth`, all in SI units:

```json
{ "cloth": {
  "version": 1,
  "maxDistance": 0.6,          // m; per vertex: (1 - _CLOTH_PIN) * maxDistance
  "stretchStiffness": 1.0,     // 0..1 (1 = inextensible)
  "bendStiffness": 0.05,       // 0..1
  "damping": 0.4,              // 1/s air drag relative to the wind
  "friction": 0.3,             // 0..1 against colliders
  "thickness": 0.008,          // m collision offset
  "gravity": [0, -9.81, 0],    // m/s^2
  "wind": [0, 0, 0],           // m/s air velocity (world)
  "colliders": ["pelvis", "torso", "thighL", "thighR", "kneeL", "kneeR", "shinL", "shinR"]
} }
```

**Colliders.** These are defined once per character, not per garment.
- Each capsule is `{ name, jointA, jointB, t0, t1, radius }` between canonical joints. The radius is per body shape, or linear in the sliders the way `tools/make_colliders.mjs` (being built in parallel) models it with `radiusMorphs`.
- Garments list the collider names they use.
- Hair keeps its own `VRMC_springBone` colliders, but should be generated from the same capsule list.

**How XPBD reads it (the reference).**
- `mask = 1` → the vertex is kinematic.
- Otherwise the vertex is limited to its max distance from its skinned position.
- Stretch compliance is 0 when `stretchStiffness = 1`. Bend compliance is about 2e-3 for `bendStiffness = 0.05`. The exact curve between stiffness and compliance is not calibrated yet.
- Damping is linear drag towards the wind velocity, and friction acts relative to the collider velocity.

## 7. Other engines

| Engine | Solver | Mask | Colliders | Parameters |
|---|---|---|---|---|
| **Unity** | `Cloth` component | `cloth.coefficients[i].maxDistance = (1-mask)·maxDistance`; the coefficients index the welded (unique) vertices, so map through positions | `CapsuleCollider` on bones, plus sphere pairs for tapered capsules | `stretchingStiffness`, `bendingStiffness`, `damping`, `friction`, `externalAcceleration` / `randomAcceleration` or a WindZone for wind |
| **Unreal** (Chaos Cloth) | Chaos cloth (Cloth asset or Dataflow) | `MaxDistance` weight map = 1-mask, scaled by maxDistance; optional backstop | Physics Asset capsules (sphyls) and spheres on bones | Edge / bend stiffness, damping, drag and lift, wind |
| **Godot 4** | `SoftBody3D` (Jolt backend available since 4.4) | **Binary only**: pin points where mask ≥ 0.99 and attach them via BoneAttachment3D | `CapsuleShape3D` on `AnimatableBody3D` under bone attachments | `linear_stiffness`, `damping_coefficient`, `drag_coefficient`; wind through Area3D |
| **Godot 4**, full mask | Port the XPBD solver (GDScript, C# or a GDExtension), or use the Jolt skinned constraints from a GDExtension | Full mask | Capsules | As XPBD |
| **Native Jolt** (any C++ engine) | `SoftBodySharedSettings` | `Skinned.mMaxDistance = max(1 mm, (1-mask)·maxDistance)`; `mInvMass = 0` where mask = 1 | Capsule bodies | `mCompliance`, `mLinearDamping`, `mFriction` |
| **Hair**, all engines | `VRMC_springBone` via UniVRM, VRM4U, the Godot VRM add-on or three-vrm | – | – | – |

Import in each engine is a small editor script that reads `_CLOTH_PIN` (or `COLOR_0` from a `pinAsColor` export) and `extras` from the glTF: Unity through glTFast or UnityGLTF with a post-processor, Unreal through a Python or editor utility, Godot through an import script.

## 8. Risks, and what was not verified

**Not verified** (the engine column in section 7 comes from documentation and prior knowledge; none of it was run here):
- Nothing was run in Unity, Unreal or Godot. That includes Unity's welded coefficient index order, how Chaos imports weight maps from vertex colours, and whether Godot 4.4 Jolt soft bodies are stable on skinned characters.
- Only a skirt was tested. Dresses (shoulder straps), capes (anchored at the shoulders, larger swing) and several layered garments were not. None of the setups have cloth-to-cloth or self-collision.
- The skin target in the test is rigid on the hips. Real garments are skinned to the legs too, which changes how the max-distance gradient behaves.
- No arm or hand colliders: in the screenshots the hands pass through the skirt.
- Performance is from one desktop CPU and GPU only. Mobile, Safari and Firefox were not tested, and neither was a Web Worker. Determinism was checked within one machine (node vs Chrome), not across CPUs or browsers.
- Wind was implemented but not measured.
- The mapping from the stiffness numbers to each engine is not calibrated. The same 0..1 values will not look identical across engines.

**Risks:**
- **Collider fit.** The 75th-percentile radii leave the mesh knee poking through the cloth in some XPBD frames. `tools/make_colliders.mjs` uses the 25th percentile (an inscribed capsule), which would make poke-through worse. Use the percentile plus the cloth thickness, or add an inflated collider set for cloth.
- **Moving inputs.** The animation (`web/animation/clips.js`, run clip) and the export tools changed while this ran. `bench.mjs` prints an animation fingerprint, and results are only comparable when it matches.
- **Jolt at 2048 particles flips the skirt up**, and its Dihedral bend type exploded on contact. These are open issues if Jolt is chosen.
- **Rapier soft bodies are brand new**, and C is at version 0.0.6. Their APIs may change.
- **Our own XPBD is our code to maintain.** Tearing, self-collision, sleeping and multithreading are all our job.
