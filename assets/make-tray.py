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
    # ribbon: from the top bar's right half down to the bottom bar's left half
    rd.polygon([(s * 10.5, s * 6.0), (s * 19.0, s * 6.0), (s * 11.5, s * 16.0), (s * 3.0, s * 16.0)], fill=(0, 0, 0, 140))
    im.alpha_composite(ribbon)
    d = ImageDraw.Draw(im)
    h = 4.0                                                     # bar height in grid units
    for y in (3.2, 22 - 3.2 - h):
        d.rounded_rectangle([s * 2.0, s * y, s * 20.0, s * (y + h)], radius=s * h / 2, fill=(0, 0, 0, 255))
    return im.resize((px, px), Image.LANCZOS)

for px, name in ((22, 'trayTemplate.png'), (44, 'trayTemplate@2x.png'), (66, 'trayTemplate@3x.png')):
    glyph(px).save(os.path.join(OUT, name))
print('wrote', OUT)
