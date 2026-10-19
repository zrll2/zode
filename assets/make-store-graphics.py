#!/usr/bin/env python3
"""Render the store graphics that are not screenshots.  python3 assets/make-store-graphics.py [outdir]
Writes the Google Play icon (512x512) and feature graphic (1024x500) in fastlane's layout.
Needs Pillow and numpy, plus the app's node_modules (for the Source Serif 4 font)."""
import os, sys, glob, importlib.util
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ml', os.path.join(HERE, 'make-logo.py')); ml = importlib.util.module_from_spec(spec); spec.loader.exec_module(ml)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'app', 'store', 'play', 'metadata', 'android', 'en-US', 'images')
SHOTS = os.environ.get('ZODE_SHOTS', os.path.join(HERE, '..', 'docs', 'images'))   # chat-dark.png, sessions.png

def font(paths, size):
    for p in paths:
        for f in glob.glob(p):
            try: return ImageFont.truetype(f, size)
            except Exception: pass
    return ImageFont.load_default()

SERIF = [os.path.join(os.environ.get('ZODE_APP_DIR', os.path.join(HERE, '..', 'app')), 'node_modules', '@expo-google-fonts', 'source-serif-4', '500Medium', '*.ttf')]
SANS = ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/SFNS.ttf', '/Library/Fonts/Arial.ttf']

os.makedirs(OUT, exist_ok=True)
# 1. Play icon: full square, the store applies its own mask
ml.render(512, 'icon', z_span=232).convert('RGBA').save(os.path.join(OUT, 'icon.png'), optimize=True)

# 2. feature graphic 1024x500
W, H = 1024, 500
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
t = np.clip((xx / W) * 0.55 + (yy / H) * 0.45, 0, 1)[..., None]
bg = np.array((0x2B, 0x2A, 0x28), np.float32) * (1 - t) + np.array((0x0E, 0x0E, 0x0D), np.float32) * t
img = Image.fromarray(bg.astype(np.uint8), 'RGB').convert('RGBA')
d = ImageDraw.Draw(img)
logo = ml.render(190, 'tile')
img.alpha_composite(logo, (60, 48))
d.text((72, 236), 'Zode', font=font(SERIF, 104), fill=(250, 249, 245, 255))
d.text((76, 402), 'Control ZCode from your phone', font=font(SANS, 28), fill=(168, 165, 155, 255))

def phone(path, height):
    im = Image.open(path).convert('RGBA'); w = int(im.size[0] * height / im.size[1]); im = im.resize((w, height), Image.LANCZOS)
    m = Image.new('L', im.size, 0); ImageDraw.Draw(m).rounded_rectangle((0, 0) + im.size, radius=int(height * 0.085), fill=255)
    out = Image.new('RGBA', im.size, (0, 0, 0, 0)); out.paste(im, (0, 0), m)
    sh = Image.new('RGBA', (w + 80, height + 80), (0, 0, 0, 0)); sh.paste((0, 0, 0, 110), (40, 52), m); sh = sh.filter(ImageFilter.GaussianBlur(18))
    sh.alpha_composite(out, (40, 40)); return sh
for name, x, y in (('sessions.png', 470, 54), ('chat-dark.png', 700, 118)):
    p = os.path.join(SHOTS, name)
    if os.path.exists(p): img.alpha_composite(phone(p, 560), (x, y))
img.convert('RGB').save(os.path.join(OUT, 'featureGraphic.png'), optimize=True)
print('wrote', os.path.join(OUT, 'icon.png'), 'and featureGraphic.png')
