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

def skin_albedo(src, out, size=2048, k_max=0.72, k_min=0.62):
    """Per-channel mean-normalised skin albedo (JPEG). Returns gain."""
    a = load(src, size)
    lin = s2l(a[..., :3])
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


def eye(src, out, size=1024, iris_r=100 / 1024, ring_r=124 / 1024, k=0.45):
    """Eye texture with a grey (tintable) iris, dark neutral limbal ring and the original sclera.
    Returns (gain, centres, iris_r, ring_r) in UV units."""
    a = load(src, size)
    centres = eye_centres(a)
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


def tintable_alpha(src, out, size, k=0.6, alpha_gamma=1.0):
    """Luminance-only RGBA texture (hair, eyebrows, eyelashes). Mean over the opaque pixels -> k. Returns gain."""
    a = load(src, size)
    lin = s2l(a[..., :3])
    alpha = a[..., 3]
    L = lum(lin)
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


def plain(src, out, size, quality=88):
    a = load(src, size)
    save(a[..., :3], out, quality=quality)
