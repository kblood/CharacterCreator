// Runtime material upgrades that glTF cannot express (three.js r170, onBeforeCompile patches).
//
// Skin (material "Skin" -> MeshPhysicalMaterial):
//  * fake subsurface scattering: per-channel wrap lighting on direct lights (red wraps furthest past the
//    terminator) + back-light transmission through thin parts (ears, nostrils; region mask R channel);
//  * lower specular (F0 ~0.026 instead of 0.04) + a faint sheen instead of the waxy GGX highlight;
//  * procedural micro-normal "pores" (tiling DataTexture), faded out beyond ~1.2 m camera distance;
//  * areola tone-down for male bodies (region mask G channel, strength from the gender slider): the female
//    MakeHuman albedo paints areolas that read as small breasts on the flat male chest geometry.
//  The runtime tint keeps working unchanged: material.color = tint * gain multiplies the texture as before
//  (map_fragment); the SSS wrap/transmission only redistribute the lit colour, the areola blend targets the
//  tint itself (color / gain = the mean skin colour), so it follows any picked skin colour.
//
// Hair (materials "Hair_*"): root-to-tip shade gradient (glTF attribute _CCHAIR = distance from the scalp),
//  optional hairline fade (alpha cut where _CCEDGE = distance from bare skin is small; off by default, see
//  hairUniforms),
//  duller specular, and an optional vertex-shader shoulder collision (capsules on the upper arms and the upper
//  back push long strands out; weighted by _CCHAIR so roots never move; no bone is touched).
//
// Cornea: a small fixed catchlight (view-space light direction) so the eyes read alive in any lighting.
import * as THREE from 'three';

const CC = { PORE_REPEAT: 42, PORE_STRENGTH: 0.35 };

// ---- procedural pore normal texture (tileable, deterministic) ----
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let poreTexture = null;
export function makePoreTexture(N = 256, seed = 11) {
  const rnd = mulberry32(seed), h = new Float32Array(N * N);
  const wrap = i => ((i % N) + N) % N;
  for (let p = 0; p < N * N * 0.035; p++) {             // pores: small gaussian dips, random depth / size
    const cx = rnd() * N, cy = rnd() * N, s = 0.7 + rnd() * 0.9, d = 0.5 + rnd() * 0.5;
    const R = Math.ceil(s * 3);
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      const dx = Math.floor(cx) + x - cx, dy = Math.floor(cy) + y - cy;
      h[wrap(Math.floor(cy) + y) * N + wrap(Math.floor(cx) + x)] -= d * Math.exp(-(dx * dx + dy * dy) / (2 * s * s));
    }
  }
  for (let i = 0; i < N * N; i++) h[i] += (rnd() - 0.5) * 0.25;   // fine grain
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const gx = h[y * N + wrap(x + 1)] - h[y * N + wrap(x - 1)];
    const gy = h[wrap(y + 1) * N + x] - h[wrap(y - 1) * N + x];
    const o = (y * N + x) * 4;
    data[o] = Math.round(THREE.MathUtils.clamp(-gx * 0.5, -1, 1) * 127.5 + 127.5);
    data[o + 1] = Math.round(THREE.MathUtils.clamp(-gy * 0.5, -1, 1) * 127.5 + 127.5);
    data[o + 2] = 255; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function toPhysical(m) {
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, m);        // standard props; physical ones keep defaults
  p.defines = { STANDARD: '', PHYSICAL: '' };
  return p;
}

const DIRECT_DIFFUSE = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
function patchChunk(shader, chunk, from, to) {
  const inc = `#include <${chunk}>`;
  if (!shader.includes(inc)) throw new Error(`[materials] shader has no ${inc}`);
  const src = THREE.ShaderChunk[chunk];
  if (!src.includes(from)) throw new Error(`[materials] ${chunk}: patch anchor not found`);
  return shader.replace(inc, src.replace(from, to));
}
function insertAfter(shader, anchor, code) {
  if (!shader.includes(anchor)) throw new Error(`[materials] anchor ${anchor} not found`);
  return shader.replace(anchor, `${anchor}\n${code}`);
}

// ---- skin ----
export const skinUniforms = {
  ccRegions: { value: null }, ccHasRegions: { value: 0 },
  ccWrap: { value: new THREE.Vector3(0.2, 0.08, 0.045) },
  ccTransmit: { value: new THREE.Vector3(0.55, 0.16, 0.08) },
  ccAreola: { value: 0 }, ccInvGain: { value: 1 },
  ccPores: { value: null }, ccPoreRepeat: { value: CC.PORE_REPEAT }, ccPoreStrength: { value: CC.PORE_STRENGTH },
  ccSSS: { value: 1 },
};

/** Areola tone-down from the gender slider (-1 female .. 1 male): 0 for female, ~0.35 neutral, 0.7 male. */
export const areolaStrength = gender => THREE.MathUtils.clamp(0.35 * (1 + (Number(gender) || 0)), 0, 0.7);

export function setSkinParams({ gender, sss } = {}) {
  if (gender !== undefined) skinUniforms.ccAreola.value = areolaStrength(gender);
  if (sss !== undefined) skinUniforms.ccSSS.value = sss ? 1 : 0;
}

export function upgradeSkin(old, regionsTexture) {
  const m = toPhysical(old);
  m.specularIntensity = 0.65;          // F0 0.026 (skin ~0.028) instead of 0.04
  m.roughness = Math.max(m.roughness, 0.56);
  m.sheen = 0.25; m.sheenRoughness = 0.75; m.sheenColor = new THREE.Color(0.95, 0.8, 0.75);
  m.envMapIntensity = 0.85;
  poreTexture ??= makePoreTexture();
  skinUniforms.ccPores.value = poreTexture;
  skinUniforms.ccRegions.value = regionsTexture ?? null;
  skinUniforms.ccHasRegions.value = regionsTexture ? 1 : 0;
  const g = Number(old.userData?.tint?.gain);
  skinUniforms.ccInvGain.value = g > 0 ? 1 / g : 1;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, skinUniforms);
    let f = sh.fragmentShader;
    f = f.replace('#include <common>', `#include <common>
uniform sampler2D ccRegions; uniform float ccHasRegions; uniform vec3 ccWrap; uniform vec3 ccTransmit;
uniform float ccAreola; uniform float ccInvGain; uniform float ccSSS;
uniform sampler2D ccPores; uniform float ccPoreRepeat; uniform float ccPoreStrength;
float ccThinV = 0.0;`);
    f = insertAfter(f, '#include <map_fragment>', `
#ifdef USE_MAP
  if ( ccHasRegions > 0.5 ) {
    vec3 ccReg = texture2D( ccRegions, vMapUv ).rgb;
    ccThinV = ccReg.r * ccSSS;
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuse * ccInvGain * 0.97, clamp( ccReg.g * 1.4, 0.0, 1.0 ) * ccAreola );
  }
#endif`);
    f = patchChunk(f, 'normal_fragment_maps', 'mapN.xy *= normalScale;', `mapN.xy *= normalScale;
  {
    float ccFade = 1.0 - smoothstep( 0.35, 1.2, length( vViewPosition ) );
    vec2 ccP = texture2D( ccPores, vNormalMapUv * ccPoreRepeat ).xy * 2.0 - 1.0;
    mapN.xy += ccP * ccPoreStrength * ccFade;
  }`);
    f = patchChunk(f, 'lights_physical_pars_fragment', DIRECT_DIFFUSE, `{
    float ccNL = dot( geometryNormal, directLight.direction );
    vec3 ccW = ccWrap * ccSSS;
    vec3 ccWrapNL = clamp( ( vec3( ccNL ) + ccW ) / ( 1.0 + ccW ), 0.0, 1.0 );
    reflectedLight.directDiffuse += ccWrapNL * directLight.color * BRDF_Lambert( material.diffuseColor );
    float ccBack = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), 3.0 ) * ccThinV;
    reflectedLight.directDiffuse += ccBack * ccTransmit * directLight.color * material.diffuseColor;
  }`);
    sh.fragmentShader = f;
  };
  m.customProgramCacheKey = () => 'ccSkin1';
  m.needsUpdate = true;
  return m;
}

// ---- hair ----
export const hairUniforms = {
  ccRootTone: { value: 0.78 }, ccTipTone: { value: 1.08 }, ccGradLen: { value: 0.22 },
  // hairline fade: OFF by default. With the single alpha-tested card layer it erodes temples/sideburns into a
  // jagged, balder edge instead of softening it (compared off / 12 mm / 25 mm on 4 styles). Kept for tuning.
  ccEdgeFade: { value: 0.012 }, ccHairline: { value: 0 },
  ccCollide: { value: 0 },
  ccCapA: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
  ccCapB: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
  ccCapR: { value: [0, 0, 0] },
};
export const HAIR_COLLIDE_FROM = 0.05;            // m from the scalp: shorter strands never move

export function upgradeHair(old, geometry) {
  const m = toPhysical(old);
  m.specularIntensity = 0.55;
  m.roughness = Math.max(m.roughness, 0.66);
  m.envMapIntensity = 0.45;
  const hasLen = !!geometry?.attributes?._cchair, hasEdge = !!geometry?.attributes?._ccedge;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, hairUniforms);
    let v = sh.vertexShader;
    v = v.replace('#include <common>', `#include <common>
${hasLen ? 'attribute float _cchair;' : ''} ${hasEdge ? 'attribute float _ccedge;' : ''}
varying float vCcLen; varying float vCcEdge;
uniform float ccCollide; uniform vec3 ccCapA[3]; uniform vec3 ccCapB[3]; uniform float ccCapR[3];`);
    v = insertAfter(v, '#include <skinning_vertex>', `
  vCcLen = ${hasLen ? '_cchair' : '0.1'};
  vCcEdge = ${hasEdge ? '_ccedge' : '1.0'};
  {
    float ccW = ccCollide * smoothstep( ${HAIR_COLLIDE_FROM.toFixed(3)}, ${(HAIR_COLLIDE_FROM + 0.08).toFixed(3)}, vCcLen );
    if ( ccW > 0.0 ) {
      for ( int i = 0; i < 3; i ++ ) {
        vec3 ab = ccCapB[ i ] - ccCapA[ i ];
        float h = clamp( dot( transformed - ccCapA[ i ], ab ) / max( dot( ab, ab ), 1e-8 ), 0.0, 1.0 );
        vec3 d = transformed - ( ccCapA[ i ] + ab * h );
        float l = length( d );
        if ( l < ccCapR[ i ] && l > 1e-5 ) transformed += d / l * ( ccCapR[ i ] - l ) * ccW;
      }
    }
  }`);
    sh.vertexShader = v;
    let f = sh.fragmentShader;
    f = f.replace('#include <common>', `#include <common>
varying float vCcLen; varying float vCcEdge;
uniform float ccRootTone; uniform float ccTipTone; uniform float ccGradLen; uniform float ccEdgeFade; uniform float ccHairline;`);
    f = insertAfter(f, '#include <map_fragment>', `
  diffuseColor.rgb *= mix( ccRootTone, ccTipTone, smoothstep( 0.0, ccGradLen, vCcLen ) );
  #ifdef USE_MAP
  {
    // soft hairline: near bare skin the alpha is cut by the strand structure of the texture (brighter strands
    // survive longer than the gaps between them), so the card edge breaks up into strands instead of a line
    float ccFade = smoothstep( 0.0, ccEdgeFade, vCcEdge );
    float ccStrand = clamp( dot( sampledDiffuseColor.rgb, vec3( 0.3333 ) ) * 2.0 - 1.0, - 1.0, 1.0 );
    float ccKeep = clamp( ( ccFade - 0.5 ) * 2.4 + ccStrand * 0.9 + 0.5, 0.0, 1.0 );
    diffuseColor.a *= mix( 1.0, ccKeep, ccHairline * ( 1.0 - ccFade * ccFade ) );
  }
  #endif`);
    sh.fragmentShader = f;
  };
  m.customProgramCacheKey = () => `ccHair1${hasLen}${hasEdge}`;
  m.needsUpdate = true;
  return m;
}

// Shoulder / upper-back capsules for the hair collision: [bone A, bone B, fraction of A->B used, max radius].
export const HAIR_CAPSULES = [
  ['upperarm_l', 'lowerarm_l', 0.45, 0.06],
  ['upperarm_r', 'lowerarm_r', 0.45, 0.06],
  ['spine_03', 'neck_01', 0.8, 0.11],
];

/**
 * Hair collision state for one hair mesh (bound to the body skeleton). calibrate() sets each capsule radius to
 * min(max radius, 0.96 x the smallest distance of any collision-weighted hair vertex from the capsule in the
 * REST pose with the current morphs), so the rest pose is never changed; update() moves the capsules with the
 * animated bones every frame (mesh-local space, the space of `transformed` after skinning).
 */
export function createHairCollider(mesh) {
  const sk = mesh.skeleton, geo = mesh.geometry;
  const len = geo.attributes._cchair;
  const idx = HAIR_CAPSULES.map(([a, b]) => [sk.bones.findIndex(x => x.name === a), sk.bones.findIndex(x => x.name === b)]);
  const ok = !!len && idx.every(([a, b]) => a >= 0 && b >= 0);
  const verts = [];
  if (ok) for (let i = 0; i < len.count; i++) if (len.getX(i) > HAIR_COLLIDE_FROM) verts.push(i);
  const radii = [0, 0, 0];
  const tmpM = new THREE.Matrix4(), A = new THREE.Vector3(), B = new THREE.Vector3(), P = new THREE.Vector3();
  const segDist = (p, a, b) => {
    const ab = B.copy(b).sub(a), t = THREE.MathUtils.clamp(P.copy(p).sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12), 0, 1);
    return p.distanceTo(ab.multiplyScalar(t).add(a));
  };
  function restHead(bi) {                         // bone head in mesh (vertex) space in the rest pose
    const invBind = new THREE.Matrix4().copy(mesh.bindMatrix).invert();
    return new THREE.Vector3().applyMatrix4(tmpM.copy(sk.boneInverses[bi]).invert()).applyMatrix4(invBind);
  }
  function calibrate() {
    if (!ok || !verts.length) { radii.fill(0); return radii.slice(); }
    const caps = HAIR_CAPSULES.map(([, , frac], k) => {
      const a = restHead(idx[k][0]), b = restHead(idx[k][1]);
      return [a, a.clone().lerp(b, frac)];
    });
    const pos = geo.attributes.position, mp = geo.morphAttributes.position || [], inf = mesh.morphTargetInfluences || [];
    const active = inf.map((w, t) => [w, t]).filter(([w, t]) => w !== 0 && mp[t]);
    const best = HAIR_CAPSULES.map(() => Infinity), v = new THREE.Vector3();
    for (const i of verts) {
      v.fromBufferAttribute(pos, i);
      for (const [w, t] of active) { v.x += w * mp[t].getX(i); v.y += w * mp[t].getY(i); v.z += w * mp[t].getZ(i); }
      caps.forEach(([a, b], k) => { const d = segDist(v, a, b); if (d < best[k]) best[k] = d; });
    }
    HAIR_CAPSULES.forEach(([, , , maxR], k) => { radii[k] = Math.max(0, Math.min(maxR, 0.96 * best[k])); });
    return radii.slice();
  }
  const bw = new THREE.Vector3();
  function update() {
    if (!ok) return;
    const inv = mesh.bindMatrixInverse;
    HAIR_CAPSULES.forEach(([, , frac], k) => {
      const [ia, ib] = idx[k];
      A.setFromMatrixPosition(sk.bones[ia].matrixWorld).applyMatrix4(inv);
      bw.setFromMatrixPosition(sk.bones[ib].matrixWorld).applyMatrix4(inv);
      hairUniforms.ccCapA.value[k].copy(A);
      hairUniforms.ccCapB.value[k].copy(A).lerp(bw, frac);
      hairUniforms.ccCapR.value[k] = radii[k];
    });
  }
  return { ok, calibrate, update, radii: () => radii.slice(), weightedVertices: verts.length };
}

// ---- cornea catchlight ----
export const eyeUniforms = { ccCatch: { value: 0.9 }, ccCatchDir: { value: new THREE.Vector3(0.22, 0.3, 1).normalize() } };
export function upgradeCornea(m) {
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, eyeUniforms);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float ccCatch; uniform vec3 ccCatchDir;`);
    sh.fragmentShader = insertAfter(sh.fragmentShader, '#include <opaque_fragment>', `
  {
    vec3 ccV = normalize( vViewPosition );
    vec3 ccR = reflect( - ccV, normal );
    float ccS = pow( max( dot( ccR, ccCatchDir ), 0.0 ), 350.0 ) * ccCatch;
    gl_FragColor.rgb += vec3( ccS );
    gl_FragColor.a = max( gl_FragColor.a, ccS );
  }`);
  };
  m.customProgramCacheKey = () => 'ccCornea1';
  m.needsUpdate = true;
}
