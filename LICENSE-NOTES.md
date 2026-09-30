# License notes

This is a summary, not legal advice. Check the upstream licenses when in doubt.

| Part | Source | License | Consequence |
|---|---|---|---|
| MPFB 2 Blender extension (code) | makehumancommunity/mpfb2 | GPL-3.0 | Only *runs* inside Blender at build time. It is not copied into this repo or into the GLB. If you ever vendor or modify MPFB code here, that code is GPL. |
| MakeHuman base mesh, macro/detail targets, `game_engine` rig and weights | MakeHuman system assets | CC0 1.0 | `output/*.glb` and `output/*.joints.json` are derived from CC0 data only, so they can be used in closed/commercial projects without attribution. |
| three.js (loaded by `web/`) | mrdoob/three.js | MIT | Keep the MIT notice if three.js files are vendored into the site. |
| Scripts in this repo (`blender/`, `web/`) | this project | owner's choice (no license file yet = all rights reserved) | Add a LICENSE before publishing the repo. |
| Future hair/clothing/texture assets | various | check each | Prefer CC0; record source + license per asset here. |

Why the GPL does not reach the exported assets: the GLB contains only mesh/morph/weight data that
comes from the CC0 MakeHuman assets; the GPL applies to MPFB's program code, not to its output.
