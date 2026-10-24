#!/usr/bin/env python3
"""Menu bar glyph (template image): the app icon's Z as two capsules and a half-strength ribbon.
Writes macapp/assets/trayTemplate.png (22), @2x (44), @3x (66). Black on transparent: macOS tints it.
Usage: python3 assets/make-tray.py"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'macapp', 'assets')
SS = 16                      # supersampling

def glyph(px):
    s = px * SS / 22.0       # design grid is 22 units
    im = Image.new('RGBA', (px * SS, px * SS), (0, 0, 0, 0))
    ribbon = Image.new('RGBA', im.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(ribbon)
    # ribbon: a capsule between the bars' inner cap centres, like the app icon (not an angular polygon)
    top_y, bot_y = 3.2 + 2.0, 22 - 3.2 - 2.0
    x0, y0, x1, y1 = s * 18.0, s * top_y, s * 4.0, s * bot_y
    w = s * 4.0
    rd.line([(x0, y0), (x1, y1)], fill=(0, 0, 0, 140), width=int(w))
    for cx, cy in ((x0, y0), (x1, y1)):
        rd.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=(0, 0, 0, 140))
    im.alpha_composite(ribbon)
    d = ImageDraw.Draw(im)
    h = 4.0                                                     # bar height in grid units
    for y in (3.2, 22 - 3.2 - h):
        d.rounded_rectangle([s * 2.0, s * y, s * 20.0, s * (y + h)], radius=s * h / 2, fill=(0, 0, 0, 255))
    return im.resize((px, px), Image.LANCZOS)

for px, name in ((22, 'trayTemplate.png'), (44, 'trayTemplate@2x.png'), (66, 'trayTemplate@3x.png')):
    glyph(px).save(os.path.join(OUT, name))
print('wrote', OUT)

# Badged variants for the menu bar icon (colored dot = not a template image, so one per bar appearance):
# macapp/assets/trayWorking{Light,Dark}[@2x|@3x].png (green dot), trayNeeds{Light,Dark}[...] (amber dot).
# "Light" is for a light menu bar (dark glyph), "Dark" for a dark menu bar (white glyph).
DOTS = {'Working': (47, 157, 98), 'Needs': (217, 146, 27)}
for px, suffix in ((22, ''), (44, '@2x'), (66, '@3x')):
    base = glyph(px)
    for bar, fg in (('Light', (0, 0, 0)), ('Dark', (255, 255, 255))):
        tinted = Image.new('RGBA', base.size, fg + (0,))
        tinted.putalpha(base.getchannel('A'))
        if bar == 'Dark':
            from PIL import ImageFilter
            rim = base.getchannel('A').filter(ImageFilter.MaxFilter(3)).point(lambda v: int(v * 0.38))
            under = Image.new('RGBA', base.size, (0, 0, 0, 0)); under.putalpha(rim)
            under.alpha_composite(tinted); tinted = under
        for name, rgb in DOTS.items():
            k = px / 22
            hi = Image.new('L', (px * SS, px * SS), 0)
            hd = ImageDraw.Draw(hi)
            cx, cy, r = 18.0 * k * SS, 4.0 * k * SS, 3.3 * k * SS
            hd.ellipse([cx - r - 1.5 * k * SS, cy - r - 1.5 * k * SS, cx + r + 1.5 * k * SS, cy + r + 1.5 * k * SS], fill=255)   # clear halo around the dot
            halo = hi.resize((px, px), Image.LANCZOS)
            im = tinted.copy()
            keep = Image.eval(halo, lambda v: 255 - v)
            im.putalpha(Image.composite(im.getchannel('A'), Image.new('L', im.size, 0), keep))
            dd = Image.new('RGBA', (px * SS, px * SS), (0, 0, 0, 0))
            ImageDraw.Draw(dd).ellipse([cx - r, cy - r, cx + r, cy + r], fill=rgb + (255,))
            im.alpha_composite(dd.resize((px, px), Image.LANCZOS))
            im.save(os.path.join(OUT, f'tray{name}{bar}{suffix}.png'))
print('wrote badged tray icons')
