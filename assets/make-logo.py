#!/usr/bin/env python3
"""Render the Zode logo. Needs Pillow and numpy.   python3 assets/make-logo.py
Geometry (512 grid): rounded tile 36..476, radius 108. The Z is three capsules of equal thickness (56):
a top bar and a bottom bar (white, soft shadow) and a diagonal ribbon (white fading to soft grey) whose
ends sit on the centres of the bars' round caps, so the outline is one continuous curve."""
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ASSETS = os.path.join(HERE, '..', 'app', 'assets')
BG0, BG1 = (0x4A, 0x49, 0x46), (0x0E, 0x0E, 0x0D)
SS = 4  # supersampling

def capsule_mask(size, p0, p1, width):
    m = Image.new('L', (size, size), 0); d = ImageDraw.Draw(m)
    d.line([p0, p1], fill=255, width=int(width)); r = width / 2
    for x, y in (p0, p1): d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    return m

def render(size_px, mode='tile', z_span=232):
    """mode: 'tile' = rounded tile on transparent (README, docs); 'icon' = opaque full square (iOS);
    'fg' = Z only on transparent (Android adaptive foreground)."""
    N = size_px * SS
    if mode == 'tile':
        k = N / 512; x0, y0, x1, y1, rad = 36 * k, 36 * k, 476 * k, 476 * k, 108 * k; u = k
    else:
        x0, y0, x1, y1, rad = 0, 0, N, N, 0; u = z_span * N / (440 * 232)
    cx = cy = N / 2
    off = 88 * u                                   # cap centres sit 88 grid units from the middle
    tl, tr, bl, br = (cx - off, cy - off), (cx + off, cy - off), (cx - off, cy + off), (cx + off, cy + off)
    th = 56 * u
    canvas = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    if mode != 'fg':
        ax, ay, bx, by = x0 + 0.1 * (x1 - x0), y0, x0 + 0.9 * (x1 - x0), y1
        t = np.clip(((xx - ax) * (bx - ax) + (yy - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0, 1)[..., None]
        bg = np.array(BG0, np.float32) * (1 - t) + np.array(BG1, np.float32) * t
        gx, gy, gr = x0 + 0.25 * (x1 - x0), y0 + 0.12 * (y1 - y0), 0.7 * (x1 - x0)
        g = np.clip(1 - np.sqrt((xx - gx) ** 2 + (yy - gy) ** 2) / gr, 0, 1)[..., None] * 0.16
        bg = bg * (1 - g) + 255 * g
        tilemask = Image.new('L', (N, N), 255)
        if mode == 'tile':
            tilemask = Image.new('L', (N, N), 0); ImageDraw.Draw(tilemask).rounded_rectangle((x0, y0, x1, y1), radius=rad, fill=255)
            sh = Image.new('RGBA', (N, N), (0, 0, 0, 0)); sh.putalpha(tilemask.point(lambda v: int(v * 0.28)))
            sh = sh.filter(ImageFilter.GaussianBlur(14 * u)); canvas.alpha_composite(sh, (0, int(14 * u)))
        base = Image.fromarray(np.dstack([bg, np.full((N, N), 255, np.float32)]).astype(np.uint8), 'RGBA'); base.putalpha(tilemask)
        canvas.alpha_composite(base)
    # ribbon: capsule between the cap centres, nudged 2 units inwards so no halo peeks out at the joins
    d = np.array([bl[0] - tr[0], bl[1] - tr[1]]); d = d / np.linalg.norm(d); inset = 2 * u
    p0 = (tr[0] + d[0] * inset, tr[1] + d[1] * inset); p1 = (bl[0] - d[0] * inset, bl[1] - d[1] * inset)
    rm = np.array(capsule_mask(N, p0, p1, th), np.float32)
    tt = np.clip(((xx - tr[0]) * (bl[0] - tr[0]) + (yy - tr[1]) * (bl[1] - tr[1])) / ((bl[0] - tr[0]) ** 2 + (bl[1] - tr[1]) ** 2), 0, 1)
    alpha = 0.96 * (1 - tt) + 0.34 * tt
    ribbon = Image.new('RGBA', (N, N), (255, 255, 255, 0)); ribbon.putalpha(Image.fromarray((rm * alpha).astype(np.uint8)))
    canvas.alpha_composite(ribbon)
    for a, b in ((tl, tr), (bl, br)):
        bm = capsule_mask(N, a, b, th)
        sh = Image.new('RGBA', (N, N), (0, 0, 0, 0)); sh.putalpha(bm.point(lambda v: int(v * 0.38)))
        sh = sh.filter(ImageFilter.GaussianBlur(8 * u)); canvas.alpha_composite(sh, (0, int(7 * u)))
        bar = Image.new('RGBA', (N, N), (255, 255, 255, 0)); bar.putalpha(bm); canvas.alpha_composite(bar)
    return canvas.resize((size_px, size_px), Image.LANCZOS)

def svg():
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Zode">
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#4A4946"/><stop offset="1" stop-color="#0E0E0D"/></linearGradient>
    <radialGradient id="gl" cx="0.25" cy="0.12" r="0.7"><stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="rb" gradientUnits="userSpaceOnUse" x1="344" y1="168" x2="168" y2="344"><stop offset="0" stop-color="#fff" stop-opacity="0.96"/><stop offset="1" stop-color="#fff" stop-opacity="0.34"/></linearGradient>
    <filter id="sh" x="-30%" y="-60%" width="160%" height="260%"><feDropShadow dx="0" dy="7" stdDeviation="8" flood-color="#000" flood-opacity="0.38"/></filter>
    <filter id="ds" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/></filter>
  </defs>
  <rect x="36" y="36" width="440" height="440" rx="108" fill="url(#bg)" filter="url(#ds)"/>
  <rect x="36" y="36" width="440" height="440" rx="108" fill="url(#gl)"/>
  <line x1="342" y1="170" x2="170" y2="342" stroke="url(#rb)" stroke-width="56" stroke-linecap="round"/>
  <rect x="140" y="140" width="232" height="56" rx="28" fill="#fff" filter="url(#sh)"/>
  <rect x="140" y="316" width="232" height="56" rx="28" fill="#fff" filter="url(#sh)"/>
</svg>
'''

if __name__ == '__main__':
    open(os.path.join(HERE, 'logo.svg'), 'w').write(svg())
    render(512, 'tile').save(os.path.join(HERE, 'logo.png'), optimize=True)
    os.makedirs(APP_ASSETS, exist_ok=True)
    ic = render(1024, 'icon', z_span=232)               # iOS: opaque full square (the OS rounds it)
    flat = Image.new('RGB', ic.size, BG1); flat.paste(ic, mask=ic.split()[3]); flat.save(os.path.join(APP_ASSETS, 'icon.png'), optimize=True)
    render(1024, 'fg', z_span=232 * 0.87).save(os.path.join(APP_ASSETS, 'adaptive-icon.png'), optimize=True)   # Android adaptive foreground
    render(192, 'tile').resize((48, 48), Image.LANCZOS).save(os.path.join(APP_ASSETS, 'favicon.png'), optimize=True)
    print('logo assets written')
