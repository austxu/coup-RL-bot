"""
Make web-sized WebP versions of the card art in static/images.

The source cards have slightly different aspect ratios and baked-in rounded
corners; normalise them to a 5:7 crop (keeping the role name + rules text at
the bottom) so CSS can round the corners itself.

    .venv/bin/python tools/optimize_images.py
"""

import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "static/images")
OUT = os.path.join(ROOT, "web/src/assets/cards")
ROLES = ["duke", "assassin", "captain", "ambassador", "contessa"]
ASPECT = 5 / 7
WIDTHS = (320, 720)


def crop_card(im: Image.Image) -> Image.Image:
    w, h = im.size
    inset = round(w * 0.022)  # drop the baked-in rounded corners
    im = im.crop((inset, inset, w - inset, h - inset))
    w, h = im.size
    if w / h < ASPECT:  # too tall: trim from the top so the rules text survives
        new_h = round(w / ASPECT)
        cut = h - new_h
        top = cut
        im = im.crop((0, top, w, top + new_h))
    else:  # too wide: trim the sides evenly
        new_w = round(h * ASPECT)
        left = (w - new_w) // 2
        im = im.crop((left, 0, left + new_w, h))
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    for role in ROLES:
        im = crop_card(Image.open(os.path.join(SRC, f"{role}.png")).convert("RGB"))
        for w in WIDTHS:
            out = im.resize((w, round(w / ASPECT)), Image.LANCZOS)
            path = os.path.join(OUT, f"{role}-{w}.webp")
            out.save(path, "WEBP", quality=82, method=6)
            print(path, os.path.getsize(path))
    bear = Image.open(os.path.join(SRC, "card_back.png")).convert("RGBA")
    bbox = bear.getbbox()
    bear = bear.crop(bbox)
    for w in (160, 320):
        b = bear.resize((w, round(bear.height * w / bear.width)), Image.LANCZOS)
        path = os.path.join(OUT, f"bear-{w}.webp")
        b.save(path, "WEBP", quality=85, method=6)
        print(path, os.path.getsize(path))


if __name__ == "__main__":
    main()
