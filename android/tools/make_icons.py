#!/usr/bin/env python3
"""Make the app icons and the start-screen logo from the website's own logo files.
usage: make_icons.py <repo>/public/assets <android>/res"""
import sys, os
from PIL import Image

assets, res = sys.argv[1:3]
full = Image.open(os.path.join(assets, 'icon-512.png')).convert('RGBA')
mask = Image.open(os.path.join(assets, 'icon-maskable-512.png')).convert('RGBA')

# old-style square launcher icons (Android 7.x)
for d, px in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
    os.makedirs(f'{res}/mipmap-{d}', exist_ok=True)
    bg = Image.new('RGBA', (px, px), (0, 0, 0, 255))
    bg.alpha_composite(full.resize((px, px), Image.LANCZOS))
    bg.convert('RGB').save(f'{res}/mipmap-{d}/ic_launcher.png', optimize=True)

# adaptive icon foreground: 108dp canvas (432px). The logo's safe circle (80% of the image) must sit inside the
# 66dp always-visible zone, so the image is drawn 66/0.8 = 82.5dp (330px) wide in the middle of a black canvas.
os.makedirs(f'{res}/drawable-nodpi', exist_ok=True)
canvas = Image.new('RGBA', (432, 432), (0, 0, 0, 255))
sz = round(82.5 * 4)
canvas.alpha_composite(mask.resize((sz, sz), Image.LANCZOS), ((432 - sz) // 2, (432 - sz) // 2))
canvas.convert('RGB').save(f'{res}/drawable-nodpi/ic_launcher_foreground.png', optimize=True)

# logo on the start screen
bg = Image.new('RGBA', (384, 384), (0, 0, 0, 255))
bg.alpha_composite(full.resize((384, 384), Image.LANCZOS))
bg.convert('RGB').save(f'{res}/drawable-nodpi/splash_logo.png', optimize=True)
print('icons written to', res)
