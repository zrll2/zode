#!/usr/bin/env python3
"""Chinese promotional images (3:4, 1242x1660) for the Xiaohongshu note, from the real app screenshots."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

W, H = 1242, 1660
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "screenshots", "ios-real")
OUT = os.path.join(HERE, "promo-zh")
os.makedirs(OUT, exist_ok=True)
SONG = ("/System/Library/Fonts/Supplemental/Songti.ttc", 1)      # Songti SC Bold, for headlines
HEI = ("/System/Library/Fonts/STHeiti Medium.ttc", 1)            # Heiti SC Medium, for body
LIGHT, DARK = ((250, 249, 245), (20, 20, 19), (111, 109, 102)), ((20, 20, 19), (245, 244, 237), (168, 165, 155))


def font(spec, size):
    return ImageFont.truetype(spec[0], size, index=spec[1])


def wrap(d, text, f, maxw):
    lines, cur = [], ""
    for ch in text:
        if d.textlength(cur + ch, font=f) <= maxw:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def base(dark):
    bg, ink, mute = DARK if dark else LIGHT
    return Image.new("RGB", (W, H), bg), ink, mute


def headline(img, title, sub, ink, mute):
    d = ImageDraw.Draw(img)
    ft, fs = font(SONG, 104), font(HEI, 42)
    y = 110
    for ln in title.split("\n"):
        d.text((80, y), ln, font=ft, fill=ink)
        y += 128
    y += 34
    for part in sub.split("\n"):
        for ln in wrap(d, part, fs, W - 160):
            d.text((80, y), ln, font=fs, fill=mute)
            y += 62
    return y


def phone(img, name, top, scale=0.74):
    s = Image.open(os.path.join(SRC, name)).convert("RGB")
    w = int(W * scale)
    h = int(s.height * w / s.width)
    s = s.resize((w, h), Image.LANCZOS)
    r, pad = 90, 14
    frame = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    ImageDraw.Draw(frame).rounded_rectangle((0, 0, w + 2 * pad - 1, h + 2 * pad - 1), r + pad, fill=(28, 28, 27, 255))
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


# 1 cover
img, ink, mute = base(False)
y = headline(img, "GLM 没有手机 App\n我手搓了一个", "Zode：用手机遥控 Mac 上的 ZCode（GLM）", ink, mute)
phone(img, "1-sessions.png", y + 50)
save(img, "1-cover.png")

# 2 who needs you
img, ink, mute = base(False)
y = headline(img, "谁在等你\n一眼看清", "等你回复的、正在运行的、已经完成的，按日期分好组。", ink, mute)
phone(img, "2-chat.png", y + 50)
save(img, "2-read.png")

# 3 how it connects
img, ink, mute = base(True)
d = ImageDraw.Draw(img)
y = headline(img, "Mac 干活\n手机盯着", "免费小中继，连起手机和 ZCode\n没有服务器，不用账号", ink, mute)
steps = [("手机", "Zode 应用", "扫一次二维码配对"), ("你的 Mac", "Zode 中继", "一条命令安装"), ("你的 Mac", "ZCode", "照常运行，什么都不用改")]
top = y + 50
fh, fb, fs = font(HEI, 56), font(HEI, 40), font(HEI, 34)
for i, (a, b, c) in enumerate(steps):
    d.rounded_rectangle((100, top, W - 100, top + 230), 44, fill=(43, 42, 40), outline=(58, 57, 53), width=3)
    d.text((156, top + 28), a, font=fs, fill=(168, 165, 155))
    d.text((156, top + 78), b, font=fh, fill=(245, 244, 237))
    d.text((156, top + 156), c, font=fb, fill=(168, 165, 155))
    top += 230
    if i < 2:
        cx = W // 2
        d.line((cx, top + 14, cx, top + 90), fill=(245, 244, 237), width=8)
        d.polygon([(cx - 26, top + 70), (cx + 26, top + 70), (cx, top + 112)], fill=(245, 244, 237))
        top += 118
d.text((100, H - 130), "需要一台一直开着的 Mac 当中继。", font=fs, fill=(245, 244, 237))
d.text((100, H - 80), "不在家？配上 Tailscale 就行。", font=fs, fill=(168, 165, 155))
save(img, "3-connect.png")

# 4 token saving: Claude manages, GLM does the work
img, ink, mute = base(False)
d = ImageDraw.Draw(img)
y = headline(img, "极限省 token\nClaude 派活 GLM 干", "贵的模型只做决策和验收\n便宜的 GLM-5.3 干各种粗活累活", ink, mute)
steps = [("经理", "Claude", "拆任务、写工单、调度指挥"), ("干活", "GLM-5.3（ZCode）", "写代码、改文件，出力气"), ("验收", "Claude", "跑测试、看 diff，不合格打回")]
top = y + 50
fh, fb, fs2 = font(HEI, 56), font(HEI, 40), font(HEI, 34)
for i, (a, b, c) in enumerate(steps):
    d.rounded_rectangle((100, top, W - 100, top + 230), 44, fill=(255, 255, 255), outline=(232, 229, 218), width=3)
    d.text((156, top + 28), a, font=fs2, fill=(111, 109, 102))
    d.text((156, top + 78), b, font=fh, fill=(20, 20, 19))
    d.text((156, top + 156), c, font=fb, fill=(111, 109, 102))
    top += 230
    if i < 2:
        cx = W // 2
        d.line((cx, top + 14, cx, top + 90), fill=(20, 20, 19), width=8)
        d.polygon([(cx - 26, top + 70), (cx + 26, top + 70), (cx, top + 112)], fill=(20, 20, 19))
        top += 118
save(img, "4-token.png")

# 4 read like a document
img, ink, mute = base(True)
y = headline(img, "像读文档\n一样读成果", "代码、表格清爽易读，工具调用折叠成一行。", ink, mute)
phone(img, "4-chat-dark.png", y + 50)
save(img, "5-read.png")

# 5 private by design
img, ink, mute = base(False)
d = ImageDraw.Draw(img)
y = headline(img, "隐私优先", "没有我们的服务器，消息只在你的手机和 Mac 之间走。", ink, mute)
items = [("无需账号", "扫一次码就配对好"), ("没有广告，没有追踪", "不做任何统计"), ("回复、停止、新建", "回消息，叫停跑偏的任务"), ("先试试演示", "示例数据，没有 Mac 也能体验")]
top = y + 60
fh, fb = font(HEI, 54), font(HEI, 38)
for a, b in items:
    d.rounded_rectangle((100, top, W - 100, top + 240), 44, fill=(255, 255, 255), outline=(232, 229, 218), width=3)
    d.ellipse((150, top + 90, 210, top + 150), fill=(20, 20, 19))
    d.line((167, top + 120, 179, top + 133), fill=(250, 249, 245), width=7)
    d.line((179, top + 133, 197, top + 104), fill=(250, 249, 245), width=7)
    d.text((250, top + 40), a, font=fh, fill=(20, 20, 19))
    d.text((250, top + 134), b, font=fb, fill=(111, 109, 102))
    top += 280
save(img, "6-private.png")
print("ok")
