# Cloth / hair solver experiment

This is a self-contained comparison of cloth solvers for CharacterCreator garments (skirt, dress, cape) and for hair and loose parts. The results and recommendations are in [`docs/CLOTH_SOLVER_REPORT.md`](../../docs/CLOTH_SOLVER_REPORT.md).

The experiment reads the project and never writes to it. It imports `web/animation/*.js`, `web/character.js`, `web/humanoid.js` and `tools/glb.mjs`, and it loads `output/base_body.glb` and `output/base_body.joints.json`. Everything it writes stays in this folder, apart from the screenshots, which go to a temp directory.

| Candidate | Where | Runs in |
|---|---|---|
| A: Rapier 0.21 soft body (WASM) | `lib/solvers/rapier.mjs` | node + browser |
| B: Jolt soft body (`jolt-physics`, WASM) | `lib/solvers/jolt.mjs` | node + browser |
| C: three-simplecloth (WebGPU compute) | `simplecloth/` (own `package.json`, it needs three r182) | browser only (WebGPU) |
| D: own XPBD, plain JS (about 110 lines) | `lib/solvers/xpbd.mjs` | node + browser |
| E: `@pixiv/three-vrm-springbone` | `lib/solvers/springbone.mjs` | node + browser |

## Install

```sh
cd experiments/cloth
npm install                      # three 0.170, rapier, jolt-physics, three-vrm-springbone, puppeteer-core
cd simplecloth && npm install    # three 0.182 + three-simplecloth; postinstall runs patch.mjs
```

`simplecloth/patch.mjs` writes an instrumented copy of the library to `simplecloth/patched/` (git-ignored). The only change is that the particle buffer is exposed, so the page can read it back for the metrics.

The screenshots and browser runs use an installed Chrome or Edge through puppeteer-core. The path is found automatically. If it is not found, set `CHROME=<path to chrome>`.

## Run

```sh
node prep_bodies.mjs     # data/bodies.json: 6 bodies -> joint heads, capsule radii (from the mesh), silhouette
node prep_hair.mjs       # data/hair_colliders.json: head sphere, neck/chest/shoulder capsules
node bench.mjs           # all solvers x n=500,2000 x 6 bodies, 10 s walk/run/idle->run -> results/bench_*.json
node timing.mjs          # clean CPU timing: neutral body, 3 repeats, best median -> results/timing.json
node hair.mjs            # hair strands: springbone vs xpbd, 6 bodies -> results/hair.json
node hair.mjs --joints=12 && cp results/hair.json results/hair_long.json && node hair.mjs   # long hair, then short again
node summarize.mjs       # prints the markdown tables used in the report from results/*.json
node tune.mjs xpbd 500 neutral '{"friction":0}' '{"substeps":6}'    # parameter sweeps (use a POSIX shell for the JSON)
node trace.mjs jolt 500 neutral                                     # 0.5 s debug trace (FINE=<t> per-frame detail)

# browser (headless Chrome): metrics measured in the browser + screenshots at the given times
node shoot.mjs --solvers=xpbd,rapier,jolt,springbone --n=500 --shots=1.5,4.2 --view=side --out=<dir>
node shoot.mjs --page=simplecloth --n=500,2000 --shots=1.5,4.2 --view=side --params='{"stiffness":0.35,"dampening":0.99,"stepsPerSecond":1440}'
node shoot.mjs --page=simplecloth --n=500 --params='{"noColliders":true}'   # diagnostic: cloth with no colliders
node wgpu_probe.mjs      # is WebGPU available in headless Chrome here? (tries a few flag sets)

# interactive: node server.mjs, then open
#   http://localhost:8123/experiments/cloth/page/index.html?solver=xpbd&n=500&body=neutral&play=1&view=front34&caps=1
#   http://localhost:8123/experiments/cloth/simplecloth/index.html?n=500&shots=
```

The static server serves the repo root on 127.0.0.1 only.

## What one run is

- **Timeline:** 1 s idle to settle, which is not measured. Then 10 s at 60 Hz:
  - walk 0–3 s;
  - run 3–5.5 s;
  - idle 5.5–7.5 s;
  - idle→run 7.5–10 s.

  All transitions are 0.3 s crossfades. The poses come from the real `web/animation` animator, running on a fake bone hierarchy (`lib/drive.mjs`). Root travel is included. `bench.mjs` prints an animation fingerprint, because the clips in `web/animation` can change.
- **Garment:** an A-line skirt from the waist (the spine joint) to just below the knee (`lib/garment.mjs`), fitted to each body from its silhouette. `n=500` is 32×16 = 512 particles; `n=2000` is 64×32 = 2048. The waistband row has mask 1 (pinned, rigid on the hips) and the rest has mask 0.
- **Colliders:** 8 capsules (pelvis, torso, thigh and knee L/R, shin L/R) between canonical joints. The radii are measured from the morphed mesh for each body.
- **Metrics** (`lib/metrics.mjs`):
  - penetration events: particle-frames more than 5 mm inside a capsule;
  - deep events: more than 20 mm inside;
  - max depth;
  - down-edge stretch and ring-edge stretch;
  - idle jitter: RMS second difference in hips space, in mm, over the last 1 s of idle;
  - hem lag in run;
  - pin error;
  - FNV hash of all positions, used for determinism.
