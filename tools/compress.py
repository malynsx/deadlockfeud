"""Shrink the scraped portraits to WebP and point heroes.js at them."""
import glob, os, re
from PIL import Image

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
for png in glob.glob(os.path.join(SITE, 'heroes', '*', '*.png')):
    im = Image.open(png).convert('RGBA')
    im.thumbnail((220, 300))
    im.save(png[:-4] + '.webp', 'WEBP', quality=80, method=6)
    os.remove(png)
js = os.path.join(SITE, 'heroes.js')
src = open(js, encoding='utf-8').read()
open(js, 'w', encoding='utf-8', newline='\n').write(re.sub(r'(heroes/[^"]+)\.png', r'\1.webp', src))
