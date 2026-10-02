# CharacterCreator as a plugin: contract draft

Status: **draft for review, nothing here is implemented.** Written 2026-10-01 from the state of commit `6159908`,
revised 2026-10-02 with the owner's decisions (section 10).
Things marked *(verify)* come from memory of the code or from the catalog and must be checked before they are
frozen into a schema.

Decisions taken (details in section 10)
1. **Hosts: all of them**: web (three.js and others) **and native engines** (Unity, Godot, Unreal).
2. **Anyone can make clothing packs**, so outside authors need tooling, a linter and a licence/size policy.
3. **Distribution: a folder in git** (submodule/subtree), not npm or a CDN.

## 1. Goal and non-goals

CharacterCreator becomes a **character system that other applications embed** (hosts). The WebXR app
(`CharacterCreatorXR`) is only the first host and a demo; the viewer in `web/main.js` is the second.

Goals
- One small, versioned API a host programs against. Everything else is internal and may change.
- Content (clothing, hair, animation clips, later body presets) can be added as **data packs** without touching code.
- A host updates the plugin by changing a version, not by copying files and re-reading source.
- The same simulation core serves hosts that are not three.js: Unity, Godot and Unreal are in scope (section 8).
- Outside authors can publish clothing packs and get them validated before anyone loads them (section 12).

Non-goals (for now)
- Input, UI, camera, rendering loop, VR tracking and **IK from head/hands** stay with the host. They live in the WebXR
  demo today (`src/ik/*`, `src/ui/*`) and are not part of the plugin. An optional "tracked avatar" add-on may come later.
- No scripting inside content packs. A pack is data; it never ships executable code (section 6).
- No rewrite of the core in another language before the contract and its golden tests exist (section 8).

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

### 4.4 Distribution: a folder in git

The plugin is consumed as a **folder under version control** in the host's repository (git submodule or subtree),
pinned to a tag. No npm package, no CDN dependency.

```
host-repo/
  third_party/character-system/        <- submodule at tag v1.2.0
    plugin.json  index.js  internal/  packs/core/  native/  tools/
  packs/                               <- the host's own pack folders (also usable as submodules)
```

- Web hosts without a bundler import `./third_party/character-system/index.js` by relative path (import map optional). The
  cloth worker is addressed relative to `import.meta.url`, so it works from any folder name.
- Native hosts use the same folder: the engine adapter (section 8) lives in `native/<engine>/`, the shared assets in `packs/`.
- Compiled binaries (wasm, `.dll`/`.so`/`.dylib`) are **not committed** to the source branch: they are built by a script
  (`tools/build_native.*`) or attached to release tags. A web host gets the wasm file from the release or builds it. This keeps
  the repository small; the cost is that a host without a Rust toolchain must download the release artefact.
- A pack is a folder too, with its own `pack.json`, so a creator can publish it as an ordinary git repository and a host adds it
  as a submodule. The host lists the packs it wants; nothing is discovered automatically.
- Pinning gives the compatibility story: the host chooses when to move to a new tag. The linter and contract tests (sections 7
  and 12) tell it what broke.
- Git LFS or a size policy is needed for GLB/texture-heavy packs *(verify against the real pack sizes: today the base pack is
  about 30 MB)*.

## 5. Host API (draft)

Plain ES module, no globals, no DOM. TypeScript-style signatures for clarity only. This is the **three.js binding**; the
language-neutral core API that every other host uses is in 5.5.

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

### 5.5 Language-neutral core API (for native engines and non-three hosts)

Native hosts cannot use `THREE.Object3D`. The core therefore exposes only **data in, data out**, with flat arrays and no
callbacks. Draft (C-style names; the ABI is the same whether it is reached from wasm or from a native library):

```
cc_system_create(pack_paths, count, options)    -> system*          // loads and merges catalogs, validates
cc_system_catalog_json(system)                  -> utf8 JSON         // read-only catalog + capabilities
cc_character_create(system, settings_json)      -> character*
cc_character_apply(character, partial_json)                          // sliders, sex, tints, hair, outfit
cc_character_wear(character, id) / remove(...)  -> result code      // conflict resolution from catalog rules
cc_character_set_input(character, input*)                            // clip request, pose override, gaze, face weights, wind, velocity
cc_character_step(character, dt)                                     // advances clips, eyes, breast spring, cloth (fixed 60 Hz inside)
cc_character_outputs(character)                 -> outputs*          // see below
cc_character_destroy / cc_system_destroy
```

`outputs` (all per frame, flat float arrays, owned by the core, valid until the next `step`):
- bone local transforms in canonical joint order (53 bones);
- morph weights for the body and for each garment/hair mesh (names listed once in the catalog);
- per cloth garment: deformed vertex positions (and normals if requested) in the garment's rest vertex order;
- visibility masks (which body zones/triangles are hidden by the worn outfit);
- stats (ms, cloth counters).

The engine adapter then does the engine-specific part: import the GLB with the engine's importer, bind skin and morph
targets, and write the outputs into its mesh buffers each frame. The three.js runtime in section 3 is simply the first such adapter.

*(verify)* Whether writing cloth vertex positions every frame is cheap enough in each engine, and whether the engines'
own skinning agrees with the reference (rest pose, bind matrices), is **not measured**. Section 9 makes a spike on one native
engine an explicit early step.

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

**Decided: native engines (Unity, Godot, Unreal) are hosts.** That makes a shared native core necessary: re-implementing
the cloth solver, breast spring, clip sampling and slider maths separately in C#, GDScript and C++ would give three
diverging copies. The plan:

- **One core in Rust**, exposing the C ABI of section 5.5. It builds to a native library (Windows/Linux/macOS, later
  Android for standalone headsets) and to WebAssembly for web hosts.
- **The JavaScript core stays** as the reference implementation and as the fallback for web hosts without wasm. Both are
  checked against the same **golden vectors** (fixed inputs, expected bone transforms, morph weights, cloth positions within a
  tolerance, outfit resolution). A Rust port is only accepted when it passes them.
- **Thin engine adapters** (`native/unity` C# package, `native/godot` GDExtension, `native/unreal` module) load GLB with the
  engine importer and write the core's outputs into engine meshes. They contain no simulation.
- Order of porting, by value and risk: (1) catalog/outfit/slider maths (small, easy to verify), (2) clip sampling and eye/breast
  springs, (3) the XPBD cloth solver (largest cost, hardest to match exactly; cloth is chaotic, so golden tests need
  statistical tolerances, as the integrity harness already does).
- Nothing is ported before the contract tests exist (section 7) and before a **spike** shows the path end to end on one
  native engine (section 9, step 6). The spike answers the unmeasured questions: cost of per-frame cloth writes, skinning
  agreement with the reference, wasm speed against the JS solver.
- Content packs and the catalog format are already engine-neutral (GLB + JSON), which is what native hosts need first.
- Cost to accept: a Rust toolchain in the project, CI for several targets, three adapters to maintain, and harder debugging
  across the ABI. This is the price of "all hosts".

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
6. **Native spike.** One engine (suggest Godot or Unity; pick by the owner's own use), JS core compiled or ported only as far as
   needed to show one character with morphs, skin and one cloth garment. Measure cloth write cost, skinning agreement and
   wasm-versus-JS solver speed. Decide section 8's port order from the numbers.
7. **Outside-author kit** (section 12): fitting tool, pack template, linter CLI, documentation. Test with a pack built by
   someone who did not write the pipeline.
8. **Second pack.** Build a small pack (two garments) in its own repository and load it as a submodule without code changes.
9. Rust core, in the order of section 8, each step accepted by golden vectors. Engine adapters follow the spike's result.

Acceptance for step 2: the WebXR demo's `src/avatar.js` is under about 100 lines of glue, and no host file imports from `internal/`.

Suggested tags: `0.x` until step 5 is done and a third host exists; `1.0` only then.

## 10. Open questions

Decided by the owner (2026-10-02)
1. **Hosts:** all of them: web and native engines (Unity, Godot, Unreal). Consequence: Rust core + C ABI + engine adapters (section 8).
2. **Packs:** anyone can make clothing packs. Consequence: outside-author kit, linter, licence/size policy (section 12).
3. **Distribution:** a folder in git (submodule/subtree). Consequence: section 4.4; binaries via build script or release tags.

Still open
1. **Which native engine first** for the spike (section 9, step 6)? Suggest the one the owner will actually use.
2. **TypeScript:** hand-written `.d.ts` kept in sync by a test (proposed), or move the plugin to TypeScript?
3. **Fitting tool form:** a Blender add-on, a standalone CLI that runs Blender headless, or both (section 12)? The CLI is what CI and
   outside authors need first.
4. **Pack licence policy:** which licences may a pack declare by default (CC0, CC-BY, MIT, proprietary-with-flag)? Hosts can
   restrict further; the plugin only needs a default.
5. **Pack trust labels:** does the community want "verified" packs (linter passed, licence checked) distinguished from raw ones?
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
- "All hosts" is the largest scope item: three engine adapters plus web, each with its own skinning, morph and material
  behaviour. The spike (section 9, step 6) exists to find out early whether the per-frame outputs of section 5.5 are viable.
- "Anyone can make packs" opens quality, licence and abuse questions (oversized meshes, misleading `license` fields, content
  that violates third-party rights). The linter checks structure and limits; it cannot check that a declared licence is true.
  The default policy and a take-down path need to be decided before packs are accepted into any shared list.
- Cloth is chaotic: a Rust port will not reproduce JS cloth bit for bit. Acceptance has to be statistical (integrity numbers,
  stretch percentiles), not exact, and that has to be agreed before step 9.

## 12. Outside-author kit (packs from anyone)

Today a garment only works because our build pipeline (`blender/cc_clothing.py`) produces what the runtime expects:
skin weights on the 53-bone rig, 92 fitted morph targets, body-zone bits, a cloth pin mask (`COLOR_0.r`), layer/occupies/
conflicts metadata and clearance against lower layers. An outside author needs all of that without reading our source.

Kit contents (proposed)
1. **Pack template**: an empty git repository with `pack.json`, `clothing.json`, folder layout, and a CI file that runs the linter.
2. **Fitting tool**: takes an author's garment mesh (OBJ/FBX/GLB, UVs, textures) plus a small spec (slot, layer, zones, cloth on/off,
   pin region) and produces the finished GLB with weights, morphs, zones and pin mask. Delivered as a Blender headless CLI
   (`tools/fit_garment`) first, a Blender add-on later *(open question 3)*. The existing garment specs in `cc_clothing.py` are the
   model: the spec format becomes public and documented.
3. **Linter CLI** (`tools/check_pack`): schema validation, licence field and SPDX check, size limits (vertices, textures, bytes),
   `check_garment`'s geometry and clearance checks on all bodies, cloth sanity run. Exit code for CI.
4. **Documentation**: [CLOTHING_GUIDE.md](CLOTHING_GUIDE.md) and [AVOIDING_CLIPPING.md](AVOIDING_CLIPPING.md) become the author handbook;
   a short "make your first garment in an hour" walkthrough is added.
5. **Licence and provenance**: every asset in a pack lists `license` and `source`; the pack declares what it is built from
   (e.g. a CC0 MakeHuman garment as a base, as in our own garments). Packs with `proprietary` assets are allowed but flagged, and a
   host policy can exclude them (section 6).
6. **Compatibility report**: the linter states which contract version and which body morph set (`fittedFor`) the pack targets, so a
   host can see at once whether it loads.

What the plugin does not promise authors: that every combination of garments looks right. The linter reports clipping against
the bodies and common layers; combinations between two third-party packs are the authors' and hosts' to test (the integrity harness
can be pointed at any outfit list).
