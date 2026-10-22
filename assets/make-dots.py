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
