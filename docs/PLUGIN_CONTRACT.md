# CharacterCreator as a plugin: contract draft

Status: **draft for review, nothing here is implemented.** Written 2026-10-01 from the state of commit `6159908`.
Things marked *(verify)* come from memory of the code or from the catalog and must be checked before they are
frozen into a schema.

## 1. Goal and non-goals

CharacterCreator becomes a **character system that other applications embed** (hosts). The WebXR app
(`CharacterCreatorXR`) is only the first host and a demo; the viewer in `web/main.js` is the second.

Goals
- One small, versioned API a host programs against. Everything else is internal and may change.
- Content (clothing, hair, animation clips, later body presets) can be added as **data packs** without touching code.
- A host updates the plugin by changing a version, not by copying files and re-reading source.
- The same simulation core can later serve hosts that are not three.js (see section 8).

Non-goals (for now)
- Input, UI, camera, rendering loop, VR tracking and **IK from head/hands** stay with the host. They live in the WebXR
  demo today (`src/ik/*`, `src/ui/*`) and are not part of the plugin. An optional "tracked avatar" add-on may come later.
- No scripting inside content packs. A pack is data; it never ships executable code (section 6).
- No rewrite in another language before the contract exists (section 8).

## 2. What exists today (findings)

- A host currently imports about **ten internal modules** directly: `character.js`, `humanoid.js`, `clothing.js`,
  `clothing_rules.js`, `materials.js`, `eyelife.js`, `breastphysics.js`, `cloth/runtime.js`, `animation/*`. Any rename breaks the host.
- **Assembly lives in app code, twice.** Loading the body GLB, applying sliders and skeleton, tints, hair, clothing,
  cloth and breast physics, and the order they update in, are written in `web/main.js` (about 790 lines) and again in
  the WebXR `src/avatar.js` (about 415 lines). The plugin should own this assembly; hosts should not repeat it.
- `createClothing()` builds a **DOM UI** and needs `loader`, `getBody`, `addPart`, `onChange`, `setStatus`, `t`, `lang`.
  A host without a DOM (or one that wants its own UI) has to feed it a detached element. UI must move out of the core.
- The **catalog is already data**: `output/clothing.json` (slots, zones, rules, items with `layer`, `occupies`,
  `conflicts`, `hidesBodyZones`, `hidesLowerVertices`, `colors`, `cloth`, `license`, `source`), `hair.json`, per-clip
  `animations/*.json`, `base_body.joints.json`. This is the natural content-pack format.
- Some behaviour is **hard-coded per garment id** in host code (e.g. `BREAST_SUPPORT` in `web/main.js` and in the WebXR
  app). A third-party garment cannot be supported until that moves into the catalog.
- Sync today is a **file copy** (`tools/sync_assets.mjs`) with a commit id and hashes in `SYNCED.json`: no API version,
  no compatibility check.

## 3. Architecture: three layers

```
host app (WebXR demo, viewer, game ...)       owns: loop, input, UI, camera, tracking, IK
        |   Host API (section 5), stable, semver
character-system  (this repo)
   core      pure data + maths, no three.js, no DOM:   sliders -> morph weights, outfit rules, layer/zone masks,
             cloth solver, breast spring, animation clips, eye/blink, rig + joint maths
   runtime   three.js adapter: GLB loading, skinning, materials, cloth/hair colliders, update loop, disposal
   packs     data: base body, clothing, hair, clips, licences   (section 4)
```

Rules
- `core` may not import three.js or touch the DOM. Today `character.js` (sliders), `clothing_rules.js`, `cloth/solver.js`,
  `cloth/colliders.js`, `breastphysics.js` (springs), `animation/clips.js`, `animation/canonical.js` and `qmath.js` are
  already close to this; `materials.js`, `clothing.js` (UI part) and `cloth/runtime.js` are runtime/adapter code.
- `runtime` exposes the Host API and nothing else. The existing modules become private under `character-system/internal/`.
- Content packs reference the core only through catalog fields, never through function names.

## 4. Package and pack format

### 4.1 Plugin package (code)

```
character-system/
  plugin.json          manifest (below)
  index.js             the only public entry: export { createCharacterSystem, CONTRACT_VERSION }
  internal/            everything else, private, may change in any release
  types/index.d.ts     public types (hand-written, kept in sync by a test)
  packs/core/          the base pack (body, default hair, default clothing)
```

`plugin.json` (draft)

```json
{
  "name": "character-system",
  "version": "1.0.0",
  "contract": "1.0",
  "license": "MIT",
  "runtime": { "three": ">=0.170 <0.200", "worker": "optional", "wasm": false },
  "packs": ["packs/core/pack.json"],
  "assetLicense": "CC0-1.0 (see packs/*/pack.json per asset)"
}
```

### 4.2 Content pack (data only)

```
my-pack/
  pack.json            id, version, requires { contract: "^1.0" }, adds: [ "clothing", "hair", "clips" ], license
  clothing.json        items[] in the existing schema (+ the new fields in 4.3)
  hair.json            styles[]
  animations/*.json    clips in the existing clip format
  *.glb, textures      referenced by relative path from the catalogs
```

Merging: packs are applied in load order; an item id may not collide with an earlier pack (error, not override),
unless the pack declares `"overrides": ["id"]`. The core pack is always first.

### 4.3 Catalog changes needed before third parties can add clothing

| Need | Today | Proposed |
|---|---|---|
| Breast support per garment | hard-coded id table in host code | `item.breastSupport` (0..1) *(verify current values)* |
| Licence per asset | `license`, `source` free text | required; `license` must be an SPDX id or `proprietary`; `source` a URL or note. Host can refuse by policy |
| Body zones a garment hides | `hidesBodyZones` + `hidesLowerVertices` | unchanged; zone names become a documented, versioned enum |
| Garment-to-body fit | baked at build time against 92 morphs | pack must declare the morph set it was fitted for (`fittedFor: "morphs-92-v1"`), mismatch => warning, no crash |
| Cloth parameters | `cloth` block (pin attribute, stiffness ...) | schema + documented ranges; unknown keys rejected |
| Localisation | `label.{da,en}` | any BCP-47 key, `en` required |

A JSON Schema for each file (`clothing.schema.json`, `hair.schema.json`, `clip.schema.json`, `pack.schema.json`) is part
of the contract. Packs are validated against it at load and in CI. `tools/check_garment.mjs` already checks geometry
budgets, clearance, skinning and zones; it becomes the **pack linter** a pack author runs.

## 5. Host API (draft)

Plain ES module, no globals, no DOM. TypeScript-style signatures for clarity only.

```ts
createCharacterSystem(opts: {
  three: typeof THREE,                 // injected, so the host controls the three.js copy
  baseUrl: string,                     // where packs are served from
  packs?: string[],                    // extra pack.json URLs, after the core pack
  loader?: GLTFLoader,                 // optional, host may share its loader/caches (KTX2, Draco ...)
  worker?: 'auto' | 'off' | URL,       // cloth worker
  logger?: { warn(m): void, error(m): void },
}): Promise<CharacterSystem>

interface CharacterSystem {
  readonly contract: string;           // "1.0"
  readonly catalog: Catalog;           // read-only: sliders, slots, items, hair styles, clips, licences
  createCharacter(init?: CharacterSettings): Promise<Character>;
  dispose(): void;
}

interface Character {
  readonly root: THREE.Object3D;       // add to the host scene; the plugin never adds itself to a scene
  readonly bones: BoneMap;             // name -> THREE.Bone, canonical names (section 5.3)

  // look
  settings(): CharacterSettings;                     // serialisable snapshot (the same JSON the exporter saves)
  apply(partial: Partial<CharacterSettings>): void;  // sliders, sex, tints, hair; batches into one update
  setSex(sex: 'male' | 'female'): void;
  wear(id: string): WearResult;                      // resolves conflicts via the catalog rules
  remove(id: string): void;
  outfit(): string[];
  setUnderwear(on: boolean): void;

  // motion (pick ONE driver at a time)
  play(clip: string, opts?: { fade?: number, speed?: number }): void;
  setLocomotion(v: { speed: number, dir: [number, number], grounded: boolean }): void;  // optional clip-driven locomotion
  setPose(pose: Pose | null): void;                  // host-driven skeleton (VR IK, mocap); null returns to clips
  setGaze(g: { yaw: number, pitch: number } | null): void;
  setFace(w: Record<string, number> | null): void;   // ARKit-style names, future-proof, ignored if unknown

  // per frame
  update(dt: number, ctx?: { wind?: number, velocity?: [number, number, number] }): void;
  readonly stats: { cloth: ClothStats, ms: number };

  // facts the host needs
  measure(): { height: number, eyeHeight: number, handLength: number, scale: number };
  colliders(): Capsule[];              // body capsules, for host-side collision (e.g. VR hands)
  export(opts: ExportOptions): Promise<ArrayBuffer>;   // glTF/GLB, current exporter

  on(event: 'change' | 'error' | 'clothing-loaded', fn: (e: any) => void): () => void;
  dispose(): void;
}
```

### 5.1 Lifecycle and update order

`createCharacterSystem` -> `createCharacter` -> host adds `root` to its scene -> each frame `update(dt)` **once**
(before rendering, after the host has set pose/gaze) -> `dispose()`.
Inside `update` the plugin fixes the order that `main.js` and the WebXR `avatar.js` each re-implement today:
clip/pose -> skeleton and measure -> eye life -> breast physics -> cloth (with one-frame draw-lag compensation) -> morph weights.
The host must not call internal modules in between.

### 5.2 Ownership and threading

- The plugin owns every GPU resource it creates and releases them in `dispose()`. A garment worn again is served from a
  CPU cache; GPU buffers are re-uploaded by three.js on the next draw (current behaviour in the WebXR app).
- Cloth runs in a worker when allowed and falls back to the main thread (current behaviour). The host sees only
  `stats.cloth`. Worker URL resolution must work without a bundler, so the worker is addressed relative to the plugin's own URL.
- No network calls except fetching pack files from `baseUrl`.

### 5.3 Canonical rig

`bones` and `setPose` use the **canonical joint names** from `animation/canonical.js` (`JOINTS`; left/right,
+Y up, +Z forward, metres). The plugin maps them to the 53-bone game-engine rig internally. A host (like the VR demo's
IK) can drive the skeleton without knowing MPFB bone names.

### 5.4 Errors

- Unknown id, bad pack, licence refused by policy: `wear()` returns `{ ok: false, reason }`; `createCharacter` rejects with typed errors.
- Rendering never throws from `update`; failures degrade (a garment without cloth data renders as skinned mesh) and are
  reported through `on('error')`.

## 6. Security and trust

- **Content packs are data, never code.** No `import` from a pack, no scripts, no shaders (materials are chosen from the
  plugin's own set and tinted by catalog fields). That makes third-party packs safe to load and easy to validate.
- Plugin code is trusted code and is loaded like any other dependency (same origin or pinned URL with a hash).
- A host policy object can restrict licences, e.g. `allowLicenses: ['CC0-1.0', 'MIT']`; items outside it are not offered.
- Size limits are part of the schema (vertices, texture sizes) so a pack cannot freeze a headset.

## 7. Versioning and compatibility

- `contract` is `MAJOR.MINOR`. Within a major, the API and schemas only gain optional fields. Removing or changing
  meaning bumps the major. The plugin refuses packs whose `requires.contract` it cannot satisfy and logs why.
- `plugin.json.version` is semver for the package; `contract` changes more slowly.
- Hosts can query `system.contract` and `system.catalog.capabilities` (e.g. `{ cloth: true, face: false }`) and degrade.
- Deprecations live one major, with a console warning that names the replacement.
- **Contract tests** (new): a headless suite that runs a scripted host against the public API only and compares to
  golden numbers (outfit resolution, measured height, morph weights, a short cloth run). It replaces the file-copy
  assumption that "the sync worked".

## 8. Rust, WebAssembly and non-three hosts

Decision gate, not a commitment.
- `core` is written to a boundary that does not mention three.js: typed arrays in, typed arrays out, no callbacks.
  Candidates for a native core are the cloth solver, breast spring, clip sampling and the slider-to-morph maths.
- Compile that core to WebAssembly for web hosts and to a native library with a small C ABI for engines such as Unity,
  Godot or Unreal. The JS version stays as the reference and the fallback; golden tests compare both.
- Port **only after** (a) the contract tests exist and (b) a headset measurement shows the solver is a bottleneck, or a
  concrete native host is chosen. Until then the JS core is the product.
- Content packs and the catalog format are already engine-neutral (GLB + JSON), which is what a native host needs first.

## 9. Migration plan

1. **Inventory and freeze the boundary.** List which internal functions the viewer and the WebXR app call today
   (about ten modules); decide the public subset. Output: `types/index.d.ts` + this document at v1.
2. **Move assembly into the plugin.** Extract the common part of `web/main.js` and `src/avatar.js` into `createCharacter`.
   The viewer becomes a host of the plugin, with its UI split out of `clothing.js`.
3. **Catalog schema + linter.** Write the JSON Schemas, move per-garment hard-coded data (e.g. breast support) into the
   catalog, make `check_garment` validate packs.
4. **Packaging.** `plugin.json`, `pack.json`, a build script that produces a versioned folder/zip; the WebXR app consumes
   it by URL or by a pinned folder instead of `sync_assets.mjs`.
5. **Contract tests** against the public API; both hosts must pass them.
6. **Second pack.** Build a tiny third-party-style pack (two garments) outside this repo to prove packs work without code changes.
7. Re-evaluate section 8 with measurements.

Acceptance for step 2: the WebXR demo's `src/avatar.js` is under about 100 lines of glue, and no host file imports from `internal/`.

## 10. Open questions

1. **Who are the hosts?** Web only, or also native engines? This decides whether `core` gets a C ABI and when.
2. **Distribution:** an npm package, a CDN URL, or a git submodule/folder? No-bundler hosts favour a URL with an import map; npm favours bundled apps.
3. **TypeScript:** hand-written `.d.ts` kept in sync by a test (proposed), or move the plugin to TypeScript?
4. **Packs from third parties:** accepted from anyone (needs the licence policy and size limits above) or curated?
5. **Fitting contract:** garments are fitted at build time to 92 morph targets. Do packs have to be built with our Blender
   pipeline (`blender/cc_clothing.py`), or do we ship a fitting tool for outside authors? Today only our pipeline guarantees the skin weights, zones and cloth pin masks the runtime expects.
6. **Optional add-ons:** should tracked-avatar IK, face/eye tracking and the exporter be separate packages built on the Host API? (See the research in the WebXR repo, `docs/research/`.)
7. **Licence of the plugin:** MIT for code, CC0 for assets (done for the repos). A pack author needs the same clarity per asset.

## 11. Risks

- Freezing the API too early around what two hosts need; mitigated by keeping `contract < 1.0` (0.x, may break) until a
  third host exists.
- Per-frame cost of a clean boundary (copying between core and runtime): measure before committing to wasm.
- The assembly extraction (step 2) touches the most code and can regress cloth ordering; the cloth integrity harness and the
  contract tests must pass before and after.
- Third-party content quality: clipping, spiky cloth and body-through-cloth are still open problems (see
  [AVOIDING_CLIPPING.md](AVOIDING_CLIPPING.md)); the linter reduces but does not remove them.
