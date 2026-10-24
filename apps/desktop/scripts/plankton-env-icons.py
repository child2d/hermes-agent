#!/usr/bin/env python3
"""Plankton environment icons — the badged variants of the shipped artwork.

WHY
---
The three environments are three independent apps, but they shared ONE icon, so
the Dock could not tell you which one you were looking at. The strongest signal
an app has is its icon, and for the UNPACKAGED dev run it is the only one: a dev
run is Electron's own bundle, so its Dock icon comes from the runtime override
(electron/app-icon.ts), never from packaging.

WHAT IT PRODUCES
----------------
`assets/plankton/icon-<env>.{png,icns,ico}` for every non-shipped environment:
the shipped artwork (icon.png) with a coloured band across the bottom of the
card and the environment's uppercase label in it. The band is clipped to the
artwork's own alpha, so the card's rounded corners stay clean and the badge can
never paint outside the icon.

The shipped environment keeps `assets/plankton/icon.*` untouched — its bytes are
what every existing install already carries.

The environment list, its labels and its colours live in ONE place:
apps/desktop/plankton-envs.cjs (JS) mirrored here (Python cannot require a .cjs).
apps/desktop/scripts/plankton-envs.test.mjs asserts the two agree and that every
declared icon variant exists on disk.

USAGE
-----
    python3 apps/desktop/scripts/plankton-env-icons.py            # all envs
    python3 apps/desktop/scripts/plankton-env-icons.py dev        # one env

Requires Pillow (both this machine's interpreters have it) and, for the .icns,
macOS `iconutil` (Posix-only step; skipped with a warning elsewhere).
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "plankton"
BASE = ASSETS / "icon.png"

# Mirror of plankton-envs.cjs. `band` is the label colour; the shipped
# environment has no entry because it carries no badge.
ENVS = {
    "dev": {"label": "DEV", "band": (234, 88, 12), "text": (255, 255, 255)},
    "test": {"label": "TEST", "band": (124, 58, 237), "text": (255, 255, 255)},
}

# Pillow needs a real font file; try the usual macOS/Posix suspects in order.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    # Pillow >= 10 can size the built-in bitmap font; last resort only.
    return ImageFont.load_default(size=size)


def mark_bottom(image: Image.Image, card: tuple[int, int, int, int]) -> int:
    """Bottom of the COLOURED artwork inside the card.

    Measured, not guessed: the artwork's own margins are the only authority on
    where a band can start without covering it. Saturation separates the mark
    from the card's hairline border and its shadow (both greyscale), which a
    brightness threshold cannot."""
    left, top, right, bottom = card
    inset = 24  # skip the card's own border/shadow ring
    pixels = image.load()
    if pixels is None:  # Pillow's stub types this Optional; a loaded image always has pixels
        raise RuntimeError(f"no pixel access for {image}")
    lowest = top
    for y in range(top + inset, bottom - inset):
        for x in range(left + inset, right - inset):
            red, green, blue, alpha = pixels[x, y]
            if alpha > 200 and (max(red, green, blue) - min(red, green, blue)) > 40:
                lowest = max(lowest, y)
                break
    return lowest


def band_geometry(card: tuple[int, int, int, int], art_bottom: int) -> tuple[int, int, int, int]:
    """The band fills the free space below the artwork, flush with the card's
    bottom edge (so the rounded corners are the card's own).

    A clearance above the artwork keeps the mark from being cut — the first
    attempt placed the band at a fixed fraction of the card height and covered
    the teal tip by 43px on the 1024 canvas."""
    left, top, right, bottom = card
    height = bottom - top
    clearance = int(height * 0.04)
    band_top = art_bottom + clearance
    # Never let the band eat the artwork: keep at least a twelfth of the card.
    band_top = min(band_top, bottom - int(height * 0.083))
    return (left, band_top, right, bottom)


def render(env: str) -> Image.Image:
    spec = ENVS[env]
    base = Image.open(BASE).convert("RGBA")
    card = base.getbbox() or (0, 0, *base.size)
    band = band_geometry(card, mark_bottom(base, card))
    canvas = base.copy()

    # 1. the band, painted on a transparent layer so the artwork's alpha decides
    #    the final shape (rounded bottom corners included).
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rectangle(band, fill=spec["band"] + (255,))
    canvas = Image.alpha_composite(canvas, Image.composite(layer, Image.new("RGBA", canvas.size, (0, 0, 0, 0)), base.getchannel("A")))

    # 2. the label, centred in the band.
    left, top, right, bottom = band
    font = load_font(int((bottom - top) * 0.72))
    draw = ImageDraw.Draw(canvas)
    text = spec["label"]
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(
        ((left + right - (box[2] - box[0])) / 2 - box[0], (top + bottom - (box[3] - box[1])) / 2 - box[1]),
        text,
        font=font,
        fill=spec["text"] + (255,),
    )
    return canvas


def write_png(image: Image.Image, env: str) -> Path:
    out = ASSETS / f"icon-{env}.png"
    image.save(out, format="PNG")
    return out


def write_ico(image: Image.Image, env: str) -> Path:
    out = ASSETS / f"icon-{env}.ico"
    image.save(out, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return out


def write_icns(image: Image.Image, env: str) -> Path | None:
    """iconutil needs an .iconset of exact names/sizes; it is macOS-only."""
    if sys.platform != "darwin":
        print(f"  [icon-{env}] skipping .icns (iconutil is macOS-only)")
        return None
    out = ASSETS / f"icon-{env}.icns"
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / f"icon-{env}.iconset"
        iconset.mkdir()
        for size in ICNS_SIZES:
            if size <= 512:
                image.resize((size, size), Image.Resampling.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            if size >= 32:
                half = size // 2
                image.resize((size, size), Image.Resampling.LANCZOS).save(iconset / f"icon_{half}x{half}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)
    return out


def main(argv: list[str]) -> int:
    wanted = argv[1:] or list(ENVS)
    unknown = [env for env in wanted if env not in ENVS]
    if unknown:
        print(f"unknown environment(s): {', '.join(unknown)} (known: {', '.join(ENVS)})")
        return 2
    if not BASE.exists():
        print(f"missing base artwork: {BASE}")
        return 1

    for env in wanted:
        image = render(env)
        png = write_png(image, env)
        ico = write_ico(image, env)
        icns = write_icns(image, env)
        print(f"{env}: {png.name} ({png.stat().st_size}B), {ico.name} ({ico.stat().st_size}B)"
              + (f", {icns.name} ({icns.stat().st_size}B)" if icns else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
