#!/usr/bin/env python3
"""Status dots for the menu bar menu (colored, not template images): macapp/assets/dot{Green,Amber,Red,Grey}[@2x|@3x].png"""
import os
from PIL import Image, ImageDraw
OUT = os.path.join(os.path.dirname(__file__), '..', 'macapp', 'assets')
COLORS = {'Green': (62, 155, 95), 'Amber': (224, 160, 48), 'Red': (209, 75, 60), 'Grey': (154, 154, 147)}
SS = 16
for name, rgb in COLORS.items():
    for scale, suffix in ((1, ''), (2, '@2x'), (3, '@3x')):
        px = 12 * scale
        im = Image.new('RGBA', (px * SS, px * SS), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        pad = 1.5 * scale * SS
        d.ellipse([pad, pad, px * SS - pad, px * SS - pad], fill=rgb + (255,))
        im.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, f'dot{name}{suffix}.png'))
print('wrote', OUT)

# A green check mark for finished conversations (menu icon), 12 pt at 1x/2x/3x: macapp/assets/tickGreen*.png
for scale, suffix in ((1, ''), (2, '@2x'), (3, '@3x')):
    px = 12 * scale
    im = Image.new('RGBA', (px * SS, px * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = px * SS / 12.0
    w = int(round(1.9 * u))
    pts = [(2.0 * u, 6.4 * u), (4.9 * u, 9.3 * u), (10.2 * u, 3.0 * u)]
    d.line(pts, fill=COLORS['Green'] + (255,), width=w, joint='curve')
    for x, y in (pts[0], pts[-1]):                      # round caps
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=COLORS['Green'] + (255,))
    im.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, f'tickGreen{suffix}.png'))
print('wrote tick')
