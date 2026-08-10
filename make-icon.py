#!/usr/bin/env python3
"""Regenerate the PWA app icons — gold "SD" monogram in Fraunces on the
chamber navy. Deterministic (Pillow + the real Fraunces TTF), so nothing routes
through fragile base64 transcription. Run: python3 make-icon.py

Writes icon-512.png, icon-192.png, apple-touch-icon.png (180). If the shell
changes, also bump CACHE in sw.js so returning users refresh.
"""
import os, urllib.request
from PIL import Image, ImageDraw, ImageFont

NAVY=(16,20,24,255)      # #101418 sidebar navy
GOLD=(203,182,130,255)   # #cbb682 accent gold
FONT="/tmp/Fraunces.ttf"
FONT_URL=("https://raw.githubusercontent.com/google/fonts/main/ofl/fraunces/"
          "Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf")

if not os.path.exists(FONT):
    print("downloading Fraunces…")
    urllib.request.urlretrieve(FONT_URL, FONT)

def load_font(px):
    f=ImageFont.truetype(FONT, px)
    try: f.set_variation_by_axes([0.0, 0.0, 144.0, 500.0])  # SOFT,WONK,opsz,wght
    except Exception: pass
    return f

def draw_icon(size):
    img=Image.new("RGBA",(size,size),NAVY)
    d=ImageDraw.Draw(img)
    f=load_font(int(size*0.46)); text="SD"; tr=int(size*0.02)
    widths=[d.textlength(c,font=f) for c in text]
    total=sum(widths)+tr*(len(text)-1)
    bbox=d.textbbox((0,0),text,font=f)
    x=(size-total)/2; y=size*0.47-(bbox[3]-bbox[1])/2-bbox[1]
    for i,c in enumerate(text):
        d.text((x,y),c,font=f,fill=GOLD); x+=widths[i]+tr
    rw=size*0.30; ry=int(size*0.675); lw=max(1,int(size*0.0085))
    d.line([(size/2-rw/2,ry),(size/2+rw/2,ry)],fill=(203,182,130,225),width=lw)
    return img

big=draw_icon(512)
big.save("icon-512.png")
big.resize((192,192),Image.LANCZOS).save("icon-192.png")
big.resize((180,180),Image.LANCZOS).save("apple-touch-icon.png")
print("wrote icon-512.png, icon-192.png, apple-touch-icon.png")
