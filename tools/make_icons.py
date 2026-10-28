"""Build the Deadlock Feud emblem: an orange stamp with an Occult "F".

Writes logo.svg (emblem, transparent), favicon.svg (emblem on a dark tile) and PNG icons.
Needs the Occult font as a TTF: python tools/make_icons.py path/to/occult.ttf
"""
import os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
INK, ORANGE, PAPER, TILE = '#1b1512', '#dd6638', '#efe2c8', '#100e0e'
TTF = sys.argv[1]

font = TTFont(TTF)
gs = font.getGlyphSet()
gname = font.getBestCmap()[ord('F')]
pen = SVGPathPen(gs); gs[gname].draw(pen)
bp = BoundsPen(gs); gs[gname].draw(bp)
x0, y0, x1, y1 = bp.bounds


def glyph(cx, cy, height, rot):
    """The F as an SVG path, centred on (cx, cy), `height` tall, rotated `rot` degrees."""
    s = height / (y1 - y0)
    gx, gy = (x0 + x1) / 2, (y0 + y1) / 2
    return ('<path fill="%s" transform="rotate(%g %g %g) translate(%g %g) scale(%g %g) translate(%g %g)" d="%s"/>'
            % (INK, rot, cx, cy, cx, cy, s, -s, -gx, -gy, pen.getCommands()))


def emblem(detail=True):
    parts = ['<circle cx="32" cy="32" r="27" fill="%s" stroke="%s" stroke-width="3"/>' % (ORANGE, INK)]
    if detail:  # perforated inner ring, like a ticket punch
        parts.append('<circle cx="32" cy="32" r="22" fill="none" stroke="%s" stroke-width="1.6" stroke-dasharray="3.2 2.4" opacity=".9"/>' % PAPER)
    parts.append(glyph(32.5, 32.5, 30 if detail else 33, -8))
    return '\n  '.join(parts)


svg = lambda body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  %s\n</svg>\n' % body
open(os.path.join(ROOT, 'logo.svg'), 'w', encoding='utf-8').write(svg(emblem(True)))
# favicon: drop the dashes (they'd blur at 16px) and sit the stamp on a dark tile
open(os.path.join(ROOT, 'favicon.svg'), 'w', encoding='utf-8').write(
    svg('<rect width="64" height="64" rx="14" fill="%s"/>\n  %s' % (TILE, emblem(False))))


def png(size, tile, detail, name):
    k = 8  # draw large, then downsample for clean edges
    S = size * k
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = S / 64
    if tile:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=14 * u, fill=TILE)
    d.ellipse([5 * u, 5 * u, 59 * u, 59 * u], fill=ORANGE, outline=INK, width=round(3 * u))
    if detail:
        for i in range(24):  # dashed ring, same rhythm as the SVG's stroke-dasharray
            a = i * 15
            d.arc([10 * u, 10 * u, 54 * u, 54 * u], a, a + 8.6, fill=PAPER, width=round(1.6 * u))
    # F glyph, rotated -8 degrees
    h = (30 if detail else 33) * u
    f = ImageFont.truetype(TTF, size=int(h * 1.45))
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    l, t, r, b = ld.textbbox((0, 0), 'F', font=f)
    ld.text((S / 2 - (l + r) / 2 + .5 * u, S / 2 - (t + b) / 2 + .5 * u), 'F', font=f, fill=INK)
    layer = layer.rotate(8, resample=Image.BICUBIC, center=(S / 2, S / 2))
    im.alpha_composite(layer)
    im.resize((size, size), Image.LANCZOS).save(os.path.join(ROOT, name))


png(32, True, False, 'favicon-32.png')
png(180, True, True, 'apple-touch-icon.png')
png(512, True, True, 'icon-512.png')
print('icons written')
