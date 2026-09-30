# CharacterCreator

Realistic, engine-agnostic 3D character generator.
Blender (headless, `C:\Tools\Blender`) builds a rigged base body with morph targets -> exported as GLB ->
Three.js (and Unity/Godot/Unreal) drive sliders and skin colour at runtime.

## Scope v1
- Body: height, weight, muscle, proportions, sex, age (morph targets)
- Face & hair: face sliders, swappable hair meshes, hair colour
- Clothing: swappable parts fitted to the body
- Animation: standard humanoid rig, compatible with Mixamo/KayKit-style clips
- Skin colour via material baseColor (runtime)

## Layout
- `blender/` bpy scripts (base mesh import, shape keys, rig, export)
- `build/`   intermediate .blend files (scratch: C:\Tools\BlenderWorkTemp)
- `web/`     Three.js viewer + slider UI
- `output/`  final GLB assets
- `docs/`    design notes, morph target list
