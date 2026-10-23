"""Render KATARIA FAMILY icon PNGs (PWA, favicon, Android mipmaps, splash) with Pillow.
Run: python3 scripts/make_icons.py
Draws the same artwork as public/assets/icon.svg (supersampled for smooth edges)."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
SS = 4  # supersample factor


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, stops, diagonal=True):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1)) if diagonal else y / (size - 1)
            for i in range(len(stops) - 1):
                t0, c0 = stops[i]
                t1, c1 = stops[i + 1]
                if t0 <= t <= t1:
                    px[x, y] = lerp(c0, c1, (t - t0) / (t1 - t0))
                    break
    return img


BLUE = [(0, (31, 70, 214)), (0.55, (16, 35, 107)), (1, (5, 6, 13))]
GOLD = [(0, (255, 226, 154)), (0.5, (233, 185, 73)), (1, (184, 134, 27))]


def render_icon(size, rounded=True, safe_scale=1.0, transparent_bg=False):
    """Icon at `size` px. safe_scale<1 shrinks the artwork (Android adaptive foreground)."""
    big = size * SS
    base = 512.0
    k = big / base
    bg = gradient(big, BLUE).convert("RGBA")
    mask = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(mask)
    if rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(112 * k), fill=255)
    else:
        d.rectangle([0, 0, big, big], fill=255)
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    if not transparent_bg:
        canvas.paste(bg, (0, 0), mask)

    # artwork layer drawn as a mask then filled with gold gradient
    art = Image.new("L", (big, big), 0)
    ad = ImageDraw.Draw(art)
    c = base / 2

    def P(x, y):
        x = c + (x - c) * safe_scale
        y = c + (y - c) * safe_scale
        return (x * k, y * k)

    k_poly = [(150, 190), (208, 190), (208, 274), (292, 190), (364, 190), (272, 282),
              (370, 420), (298, 420), (232, 324), (208, 348), (208, 420), (150, 420)]
    ad.polygon([P(x, y) for x, y in k_poly], fill=255)
    for cx, cy, r in [(176, 112, 17), (256, 90, 22), (336, 112, 17)]:
        x, y = P(cx, cy)
        rr = r * k * safe_scale
        ad.ellipse([x - rr, y - rr, x + rr, y + rr], fill=255)
    # unity arc (semi-transparent)
    arc = Image.new("L", (big, big), 0)
    acd = ImageDraw.Draw(arc)
    pts = []
    for i in range(41):
        t = i / 40
        x = (1 - t) ** 2 * 150 + 2 * (1 - t) * t * 256 + t ** 2 * 362
        y = (1 - t) ** 2 * 128 + 2 * (1 - t) * t * 62 + t ** 2 * 128
        pts.append(P(x, y))
    acd.line(pts, fill=140, width=max(2, int(10 * k * safe_scale)), joint="curve")

    gold = gradient(big, GOLD).convert("RGBA")
    canvas.paste(gold, (0, 0), arc)
    canvas.paste(gold, (0, 0), art)
    return canvas.resize((size, size), Image.LANCZOS)


def save(img, rel):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("wrote", rel)


def splash(w, h):
    img = gradient(max(w, h), [(0, (16, 35, 107)), (1, (5, 6, 13))], diagonal=False).crop((0, 0, w, h))
    ic = render_icon(int(min(w, h) * 0.34))
    img = img.convert("RGBA")
    img.paste(ic, ((w - ic.width) // 2, (h - ic.height) // 2 - int(h * 0.04)), ic)
    return img


if __name__ == "__main__":
    # PWA / web
    for s in (192, 512):
        save(render_icon(s), f"public/assets/icon-{s}.png")
    save(render_icon(512, rounded=False, safe_scale=0.78), "public/assets/icon-maskable-512.png")
    save(render_icon(180, rounded=False, safe_scale=0.9), "public/assets/apple-touch-icon.png")
    for s in (16, 32, 48):
        save(render_icon(s), f"public/assets/favicon-{s}.png")
    render_icon(48).save(os.path.join(ROOT, "public/favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    # Splash screens
    save(splash(1080, 1920), "public/assets/splash.png")
