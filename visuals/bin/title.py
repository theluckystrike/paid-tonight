#!/usr/bin/env python3
"""Paid Tonight cover: raw/hero-t2.png center-cropped to 16:9, resized to 2560x1440, title in the app's navy on the light wall."""
from PIL import Image, ImageDraw, ImageFont
V = "/Users/mike/hackathon-intel-2026-10-17/run6h/builds/paid-tonight/visuals"
W, H = 2560, 1440
NAVY, MUTED, GREEN = (27, 58, 107), (78, 88, 102), (26, 127, 90)
HN = "/System/Library/Fonts/HelveticaNeue.ttc"
im = Image.open(f"{V}/raw/hero-t2.png").convert("RGB")
cw = round(im.height * 16 / 9); cw -= cw % 2; x0 = (im.width - cw) // 2
im = im.crop((x0, 0, x0 + cw, im.height)).resize((W, H), Image.LANCZOS)
im.save(f"{V}/final/hero-16x9.png", optimize=True)
d = ImageDraw.Draw(im)
title_f = ImageFont.truetype(HN, 132, index=1); sub_f = ImageFont.truetype(HN, 50, index=0)
LEFT, TB, SB = 160, 470, 548
cap = title_f.getbbox("P", anchor="ls")[1]
d.rounded_rectangle((LEFT, TB + cap - 56, LEFT + 96, TB + cap - 48), radius=4, fill=GREEN)
d.text((LEFT - 6, TB), "Paid Tonight", font=title_f, fill=NAVY, anchor="ls")
d.text((LEFT, SB), "Describe the job. Get paid before you leave.", font=sub_f, fill=MUTED, anchor="ls")
tw = d.textlength("Paid Tonight", font=title_f); sw = d.textlength("Describe the job. Get paid before you leave.", font=sub_f)
print(f"title right {LEFT-6+tw:.0f}, subtitle right {LEFT+sw:.0f}")
im.save(f"{V}/final/hero-with-title-16x9.png", optimize=True)
def lum(c):
    f = lambda v: (v/255)/12.92 if v/255 <= 0.03928 else (((v/255)+0.055)/1.055)**2.4
    return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2])
base = Image.open(f"{V}/final/hero-16x9.png").convert("RGB")
for name, box, col in (("title", (LEFT, TB-110, int(LEFT+tw), TB+30), NAVY), ("subtitle", (LEFT, SB-45, int(LEFT+sw), SB+14), MUTED)):
    darkest = min(base.crop(box).getdata(), key=lum)
    la, lb = sorted((lum(col), lum(darkest)), reverse=True)
    print(f"{name}: worst-case contrast {(la+0.05)/(lb+0.05):.1f}:1 against {darkest}")
