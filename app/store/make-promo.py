#!/usr/bin/env python3
"""Generate promotional store screenshots (1206x2622) from the real app screenshots."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

W, H = 1206, 2622
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "screenshots", "ios")
OUT = os.path.join(HERE, "promo")
os.makedirs(OUT, exist_ok=True)
SERIF = "/System/Library/Fonts/NewYork.ttf"
SANS = "/System/Library/Fonts/SFNS.ttf"


def font(path, size, weight=None):
    f = ImageFont.truetype(path, size)
    try:
        f.set_variation_by_axes([weight] if path == SANS else [28, weight or 500])
    except Exception:
        pass
    return f


def wrap(d, text, f, maxw):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw:
            cur = t
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def base(dark):
    bg = (20, 20, 19) if dark else (250, 249, 245)
    return Image.new("RGB", (W, H), bg), (245, 244, 237) if dark else (20, 20, 19), (168, 165, 155) if dark else (111, 109, 102)


def headline(img, title, sub, ink, mute):
    d = ImageDraw.Draw(img)
    ft, fs = font(SERIF, 118, 500), font(SANS, 46, 400)
    y = 150
    for ln in wrap(d, title, ft, W - 160):
        d.text((80, y), ln, font=ft, fill=ink)
        y += 128
    y += 14
    for ln in wrap(d, sub, fs, W - 200):
        d.text((80, y), ln, font=fs, fill=mute)
        y += 64
    return y


def phone(img, name, top, scale=0.82):
    s = Image.open(os.path.join(SRC, name)).convert("RGB")
    w = int(W * scale)
    h = int(s.height * w / s.width)
    s = s.resize((w, h), Image.LANCZOS)
    r = 90
    pad = 14
    frame = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((0, 0, w + 2 * pad - 1, h + 2 * pad - 1), r + pad, fill=(28, 28, 27, 255))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), r, fill=255)
    frame.paste(s, (pad, pad), mask)
    shadow = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((0, 0, frame.width - 1, frame.height - 1), r + pad, fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    x = (W - frame.width) // 2
    img.paste(shadow, (x, top + 30), shadow)
    img.paste(frame, (x, top), frame)


def save(img, n):
    img.save(os.path.join(OUT, n))


# 1 hero
img, ink, mute = base(False)
y = headline(img, "ZCode, in your pocket", "Follow every coding session on your Mac from your phone.", ink, mute)
phone(img, "1-sessions.png", y + 70)
save(img, "1-hero.png")

# 2 needs you
img, ink, mute = base(False)
y = headline(img, "Know what needs you", "Waiting, running, finished. Sorted at a glance, grouped by day.", ink, mute)
phone(img, "2-chat.png", y + 70)
save(img, "2-read.png")

# 3 how it connects (diagram)
img, ink, mute = base(True)
d = ImageDraw.Draw(img)
y = headline(img, "Your Mac does the work. Your phone follows.", "A small free relay on your Mac connects the two. No servers, no account.", ink, mute)
steps = [("Phone", "Zode app", "Scan a QR code once"), ("Your Mac", "Zode relay", "One command to install"), ("Your Mac", "ZCode", "Keeps running as usual")]
top = y + 140
fh, fb, fs = font(SANS, 62, 600), font(SANS, 44, 400), font(SANS, 38, 400)
for i, (a, b, c) in enumerate(steps):
    box = (110, top, W - 110, top + 330)
    d.rounded_rectangle(box, 48, fill=(43, 42, 40), outline=(58, 57, 53), width=3)
    d.text((170, top + 50), a.upper(), font=fs, fill=(168, 165, 155))
    d.text((170, top + 110), b, font=fh, fill=(245, 244, 237))
    d.text((170, top + 210), c, font=fb, fill=(168, 165, 155))
    top += 330
    if i < 2:
        cx = W // 2
        d.line((cx, top + 20, cx, top + 150), fill=(245, 244, 237), width=8)
        d.polygon([(cx - 28, top + 120), (cx + 28, top + 120), (cx, top + 168)], fill=(245, 244, 237))
        top += 190
d.text((110, H - 280), "Away from home? Add Tailscale.", font=fs, fill=(168, 165, 155))
save(img, "3-connect.png")

# 4 dark chat
img, ink, mute = base(True)
y = headline(img, "Read the work like a document", "Markdown, code and tables. Tool calls fold into one quiet line.", ink, mute)
phone(img, "4-chat-dark.png", y + 70)
save(img, "4-dark.png")

# 5 features / privacy / demo
img, ink, mute = base(False)
d = ImageDraw.Draw(img)
y = headline(img, "Private by design", "Nothing goes through our servers, because there are none.", ink, mute)
items = [("No account", "Pair once with a QR code."), ("No ads, no tracking", "No analytics of any kind."), ("Stop or start sessions", "Reply, stop, or start new."), ("Try the demo", "Sample data, no Mac needed.")]
top = y + 110
fh, fb = font(SANS, 62, 600), font(SANS, 44, 400)
for a, b in items:
    d.rounded_rectangle((110, top, W - 110, top + 280), 48, fill=(255, 255, 255), outline=(232, 229, 218), width=3)
    d.ellipse((160, top + 100, 220, top + 160), fill=(20, 20, 19))
    d.line((177, top + 130, 189, top + 143), fill=(250, 249, 245), width=7)
    d.line((189, top + 143, 207, top + 114), fill=(250, 249, 245), width=7)
    d.text((260, top + 55), a, font=fh, fill=(20, 20, 19))
    d.text((260, top + 150), b, font=fb, fill=(111, 109, 102))
    top += 320
save(img, "5-private.png")
print("ok")
