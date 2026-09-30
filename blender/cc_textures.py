"""Texture preparation for build_base.py (runs inside Blender: bpy + numpy, no PIL).

Every texture that is tinted at runtime is *normalised*: its mean colour (linear light, over the opaque
pixels) is scaled to a neutral grey level k, so the runtime tint alone decides the colour:
    final_linear = texel_linear * tint_linear * gain,   gain = 1 / k
gain is written into the glTF material extras ("tint": {"gain": g, "default": "#rrggbb"}) and the
baseColorFactor is set to tint_linear(default) * gain (clamped to 1, the glTF limit), so viewers that know
nothing about tinting still show the default colour. Skin keeps its per-channel variation (lips/cheeks stay
relatively redder), hair/eyebrows/eyelashes/iris keep only luminance (strand / fibre detail).

Arrays are Blender pixel order: row 0 = bottom = UV v 0, so (col / W, row / H) == (u, v).
"""
import os

import bpy
import numpy as np


def s2l(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def hex_to_lin(h):
    h = h.lstrip("#")
    return s2l(np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]))


def load(path, size=None):
    """RGBA float array (H, W, 4), values as stored (sRGB-encoded for colour images)."""
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = "Non-Color"      # read raw bytes, no colour management
    if size and tuple(img.size) != (size, size):
        img.scale(size, size)
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def save(arr, path, quality=88):
    """Save (H, W, 3|4) array. .jpg -> JPEG (alpha dropped), .png -> RGBA PNG."""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], axis=2)
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    jpg = path.lower().endswith((".jpg", ".jpeg"))
    img.file_format = "JPEG" if jpg else "PNG"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene = bpy.context.scene
    st = scene.render.image_settings
    st.file_format = img.file_format
    st.quality = quality
    st.compression = 90
    st.color_mode = "RGB" if jpg else "RGBA"
    st.color_depth = "8"
    img.save_render(path, scene=scene)
    bpy.data.images.remove(img)
    return path


def blur(a, r):
    """Separable box blur (radius r px, edge padding), twice (~gaussian)."""
    for _ in range(2):
        for axis in (0, 1):
            pad = [(0, 0)] * a.ndim
            pad[axis] = (r + 1, r)
            c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
            a = (hi - lo) / (2 * r + 1)
    return a


def lum(lin):
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


# ---- individual textures ---------------------------------------------------------------------------

def splat(uv, vals, size=512, radius=5):
    """Per-loop values -> smooth UV-space masks. uv (n, 2) loop UVs, vals (n, k) values per loop.
    Normalised splat + blur, so each texel gets the local mean of the loop values (0 where no geometry)."""
    vals = np.asarray(vals, np.float64).reshape(len(uv), -1)
    px = np.clip((np.asarray(uv) * size).astype(np.int64), 0, size - 1)
    acc = np.zeros((size, size, vals.shape[1]))
    w = np.zeros((size, size))
    np.add.at(acc, (px[:, 1], px[:, 0]), vals)
    np.add.at(w, (px[:, 1], px[:, 0]), 1.0)
    acc, w = blur(acc, radius), blur(w, radius)
    return np.where(w[..., None] > 1e-3, acc / np.maximum(w, 1e-6)[..., None], 0.0)


def raster(tri_uv, tri_vals, size=512, radius=2):
    """Rasterise UV triangles with barycentric interpolation of per-corner values -> (size, size, k) masks.
    tri_uv (t, 3, 2), tri_vals (t, 3, k). Covered texels get the interpolated value; a normalised blur
    (radius px) smooths it and bleeds it a few texels past island borders (0 far from any geometry).
    Unlike splat() it has no gaps inside large triangles."""
    tri_uv = np.asarray(tri_uv, np.float64) * size - 0.5          # texel centres at integer coordinates
    tri_vals = np.asarray(tri_vals, np.float64)
    k = tri_vals.shape[2]
    acc = np.zeros((size, size, k))
    w = np.zeros((size, size))
    for t in range(len(tri_uv)):
        (x0, y0), (x1, y1), (x2, y2) = tri_uv[t]
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(den) < 1e-12:
            continue
        xa, xb = max(int(np.floor(min(x0, x1, x2))), 0), min(int(np.ceil(max(x0, x1, x2))), size - 1)
        ya, yb = max(int(np.floor(min(y0, y1, y2))), 0), min(int(np.ceil(max(y0, y1, y2))), size - 1)
        if xa > xb or ya > yb:
            continue
        X, Y = np.meshgrid(np.arange(xa, xb + 1), np.arange(ya, yb + 1))
        l0 = ((y1 - y2) * (X - x2) + (x2 - x1) * (Y - y2)) / den
        l1 = ((y2 - y0) * (X - x2) + (x0 - x2) * (Y - y2)) / den
        l2 = 1 - l0 - l1
        inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
        if not inside.any():
            continue
        v = l0[inside, None] * tri_vals[t, 0] + l1[inside, None] * tri_vals[t, 1] + l2[inside, None] * tri_vals[t, 2]
        yy, xx = Y[inside], X[inside]
        acc[yy, xx] = v
        w[yy, xx] = 1.0
    acc, w = blur(acc * w[..., None], radius), blur(w, radius)
    return np.where(w[..., None] > 1e-3, acc / np.maximum(w, 1e-6)[..., None], 0.0)


def upsample(m, size):
    f = size // m.shape[0]
    return blur(np.repeat(np.repeat(m, f, 0), f, 1), max(1, f // 2))


def skin_fixes(lin, masks, ref_forehead):
    """Region corrections of the (linear) skin albedo, masks (H, W) in 0..1 at the albedo size:
    'redfix' (knees, elbows, eye surround): the low-frequency colour is replaced by that of the surrounding
    skin (ref = blur of the unmasked neighbourhood) while the fine detail stays: lin * (ref / low)^m;
    'scalp': the painted stubble becomes forehead-coloured skin with a quarter of the original fine detail;
    'flush': a subtle red boost on cheeks, nose and ears."""
    low = blur(lin, 12)
    m = masks["redfix"][..., None]
    wgt = 1.0 - np.clip(m * 3, 0, 1)
    ref = blur(lin * wgt, 48) / np.maximum(blur(wgt, 48), 1e-4)
    out = lin * (np.maximum(ref, 1e-4) / np.maximum(low, 1e-4)) ** m
    s = masks["scalp"][..., None]
    det = (lin / np.maximum(low, 1e-4)) ** 0.25
    out = out * (1 - s) + (np.asarray(ref_forehead) * det) * s
    f = masks["flush"][..., None]
    out = out * (1.0 + f * np.array([0.10, -0.035, -0.02]))
    return out


def skin_albedo(src, out, size=2048, k_max=0.72, k_min=0.62, fix=None):
    """Per-channel mean-normalised skin albedo (JPEG). Returns gain.
    fix: optional (uv-space masks at any power-of-two size, forehead UV points) -> skin_fixes()."""
    a = load(src, size)
    lin = s2l(a[..., :3])
    if fix is not None:
        masks, forehead_uv = fix
        H = lin.shape[0]
        px = np.clip((np.asarray(forehead_uv) * H).astype(int), 0, H - 1)
        ref = np.median(blur(lin, 6)[px[:, 1], px[:, 0]], axis=0)
        lin = skin_fixes(lin, {k: upsample(v, H) for k, v in masks.items()}, ref)
    mean = lin.reshape(-1, 3).mean(0)
    ratio = lin / mean
    # k as high as the brightest texels allow, but not below k_min (a few near-white texels may clip) so
    # that the default tint * gain stays <= 1 in the glTF baseColorFactor
    k = max(k_min, min(k_max, 0.98 / float(np.percentile(ratio.max(-1), 99.5))))
    save(l2s(ratio * k), out, quality=90)
    return 1.0 / k, mean


def skin_normal(src, out, size=1024, seed=7, detail=2.2, pores=0.9):
    """Tangent-space normal map (OpenGL / glTF +Y) from the albedo's fine luminance detail plus seeded
    pore noise. Kept subtle: the MakeHuman textures carry no real height data."""
    a = load(src, size)
    L = lum(s2l(a[..., :3]))
    hp = L - blur(L, 3)                                  # fine detail (wrinkles, pores painted in the albedo)
    hp = np.clip(hp / (np.std(hp) * 4 + 1e-6), -1, 1)
    rng = np.random.default_rng(seed)
    n = rng.standard_normal(L.shape).astype(np.float32)
    n = blur(n, 1) - blur(n, 4)                          # band-passed noise ~ pores
    n = n / (np.std(n) * 3 + 1e-6)
    hgt = detail * hp + pores * n
    gy, gx = np.gradient(hgt)                            # rows = +v, cols = +u
    s = 0.12
    nx, ny, nz = -gx * s, -gy * s, np.ones_like(gx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
    save(rgb, out, quality=90)


def eye_centres(a):
    """Iris centres (u, v) of the two eyes in a MakeHuman eye texture: centroid of the dark pixels per half."""
    rgb = a[..., :3]
    L = rgb.mean(-1)
    H, W = L.shape
    yy, xx = np.mgrid[0:H, 0:W]
    dark = (L < 0.35) & (a[..., 3] > 0.5)
    out = []
    for half in (xx < W / 2, xx >= W / 2):
        m = dark & half
        out.append((float(xx[m].mean()) / W, float(yy[m].mean()) / H))
    return out


def bilinear(a, x, y):
    """Sample a (H, W, C) at float pixel coordinates x (cols), y (rows), clamped."""
    H, W = a.shape[:2]
    x = np.clip(x, 0, W - 1.001)
    y = np.clip(y, 0, H - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy)
            + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy)


def scale_iris(a, centres, ring_r, s, blend=40 / 1024):
    """Radially enlarge the iris + limbal ring by s around each centre; the sclera band just outside is
    compressed so the texture stays continuous (r_src = r / s inside, linear ramp back to identity)."""
    H, W = a.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    u, v = xx / W, yy / H
    d = [np.hypot(u - cu, v - cv) for cu, cv in centres]
    k = np.argmin(d, axis=0)
    cu = np.choose(k, [c[0] for c in centres])
    cv = np.choose(k, [c[1] for c in centres])
    r = np.min(d, axis=0)
    r1, r2 = ring_r * s, ring_r * s + blend
    rs = np.where(r < r1, r / s, np.where(r < r2, ring_r + (r - r1) * (r2 - ring_r) / (r2 - r1), r))
    f = np.where(r > 1e-9, rs / np.maximum(r, 1e-9), 1 / s)
    return bilinear(a, (cu + (u - cu) * f) * W, (cv + (v - cv) * f) * H)


def eye(src, out, size=1024, iris_r=100 / 1024, ring_r=124 / 1024, k=0.45, iris_scale=1.0, sclera_redfix=0.0):
    """Eye texture with a grey (tintable) iris, dark neutral limbal ring and the original sclera.
    iris_scale > 1 enlarges iris + ring in the texture (MakeHuman irises read small at viewing distance);
    sclera_redfix 0..1 pulls the sclera's reddish corners toward its median colour.
    Returns (gain, centres, iris_r, ring_r) in UV units (radii after scaling)."""
    a = load(src, size)
    centres = eye_centres(a)
    if iris_scale != 1.0:
        a = scale_iris(a, centres, ring_r, iris_scale)
        iris_r, ring_r = iris_r * iris_scale, ring_r * iris_scale
    if sclera_redfix > 0:
        H, W = a.shape[:2]
        yy, xx = np.mgrid[0:H, 0:W]
        r = np.min([np.hypot(xx / W - cu, yy / H - cv) for cu, cv in centres], axis=0)
        scl = (r > ring_r + 6 / 1024) & (r < ring_r + 260 / 1024) & (a[..., 3] > 0.5)
        lin0 = s2l(a[..., :3])
        med = np.median(lin0[scl], axis=0)
        # redness = how much red exceeds the median sclera's red/green ratio
        red = np.clip((lin0[..., 0] / np.maximum(lin0[..., 1], 1e-4)) / (med[0] / med[1]) - 1.0, 0, 1)
        w = (np.clip(red * 3, 0, 1) * scl * sclera_redfix)[..., None]
        L = lum(lin0)[..., None]
        fixed = med * (L / max(float(lum(med[None])[0]), 1e-4))
        a = np.concatenate([l2s(lin0 * (1 - w) + fixed * w), a[..., 3:]], -1)
    lin = s2l(a[..., :3])
    L = lum(lin)
    H, W = L.shape
    yy, xx = np.mgrid[0:H, 0:W]
    r = np.min([np.hypot(xx / W - cu, yy / H - cv) for cu, cv in centres], axis=0)
    iris = (r > 30 / 1024) & (r < iris_r)
    scale = k / float(L[iris].mean())
    t_in = np.clip((r - (iris_r - 6 / 1024)) / (12 / 1024), 0, 1)       # iris -> limbal ring
    grey = L * (scale * (1 - t_in) + 1.0 * t_in)
    t_out = np.clip((r - (ring_r - 4 / 1024)) / (8 / 1024), 0, 1)      # ring -> sclera colour
    res = grey[..., None] * (1 - t_out[..., None]) + lin * t_out[..., None]
    save(l2s(res), out, quality=92)
    return 1.0 / k, centres, iris_r, ring_r


def tintable_alpha(src, out, size, k=0.6, alpha_gamma=1.0, flatten=0.0):
    """Luminance-only RGBA texture (hair, eyebrows, eyelashes). Mean over the opaque pixels -> k. Returns gain.
    flatten 0..1 divides out that fraction of the low-frequency luminance (painted-in highlights / shading,
    e.g. the glossy band on braid01's cap), keeping the strand detail."""
    a = load(src, size)
    lin = s2l(a[..., :3])
    alpha = a[..., 3]
    L = lum(lin)
    if flatten > 0:
        r = max(4, size // 48)
        wa = np.clip(alpha, 0.05, 1)
        lowL = blur(L * wa, r) / np.maximum(blur(wa, r), 1e-4)
        opaque = alpha > 0.5
        med = float(np.median(lowL[opaque])) if opaque.any() else float(np.median(lowL))
        L = L / np.maximum(lowL / max(med, 1e-4), 0.05) ** flatten
    m = float(L[alpha > 0.5].mean()) if (alpha > 0.5).any() else float(L.mean())
    g = np.clip(L * (k / m), 0, 1)
    # colour-bleed the opaque texels into the transparent area so mip-mapping does not pull in dark fringes
    wsum = blur(alpha, 4)
    fill = blur(g * alpha, 4) / np.maximum(wsum, 1e-4)
    g = np.where(alpha > 0.02, g, np.clip(fill, 0, 1))
    s = l2s(g)
    rgba = np.stack([s, s, s, alpha ** alpha_gamma], -1)
    save(rgba, out)
    return 1.0 / k


def regions(channels, out, size=256):
    """Small linear (non-colour) RGB mask texture from three (N, N) masks, N a multiple of size."""
    m = np.stack(channels, -1)
    f = m.shape[0] // size
    m = m.reshape(size, f, size, f, 3).mean((1, 3))
    save(np.clip(m, 0, 1), out, quality=92)
    return out


def plain(src, out, size, quality=88):
    a = load(src, size)
    save(a[..., :3], out, quality=quality)
