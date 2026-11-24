from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import math

ROOT = Path(__file__).resolve().parents[1]
source_path = ROOT / 'assets' / 'logo-original-transparent-1024.png'
source = Image.open(source_path).convert('RGBA')
alpha = source.getchannel('A')
bbox = alpha.getbbox()
mark = alpha.crop(bbox)
# Keep the supplied mark's silhouette exactly; recolor it white for the Union Jack palette.
base_size = 1024

# Deep Union Jack navy with a restrained red/blue glow.
background = Image.new('RGB', (base_size, base_size))
pixels = background.load()
for y in range(base_size):
    for x in range(base_size):
        nx, ny = x / base_size, y / base_size
        top = (5, 31, 88)
        bottom = (1, 12, 38)
        t = min(1, max(0, ny * .78 + nx * .18))
        color = [round(top[i] * (1 - t) + bottom[i] * t) for i in range(3)]
        # Soft red glow near the lower-left edge, balanced by a cool upper-right sheen.
        red_glow = max(0, 1 - math.sqrt(((nx - .13) / .75) ** 2 + ((ny - .88) / .65) ** 2)) ** 2
        blue_glow = max(0, 1 - math.sqrt(((nx - .92) / .75) ** 2 + ((ny - .06) / .6) ** 2)) ** 2
        color[0] = min(255, round(color[0] + 74 * red_glow))
        color[1] = min(255, round(color[1] + 10 * red_glow + 14 * blue_glow))
        color[2] = min(255, round(color[2] + 28 * blue_glow))
        pixels[x, y] = tuple(color)
background = background.convert('RGBA')

# Union Jack geometry on a glassy app-icon tile.
flag = Image.new('RGBA', (base_size, base_size), (0, 0, 0, 0))
d = ImageDraw.Draw(flag)
white = (248, 250, 255, 255)
red = (200, 16, 46, 255)
# Diagonal cross and central straight cross.
d.line((0, 0, base_size, base_size), fill=white, width=154)
d.line((0, base_size, base_size, 0), fill=white, width=154)
d.line((0, 0, base_size, base_size), fill=red, width=62)
d.line((0, base_size, base_size, 0), fill=red, width=62)
d.rectangle((0, 408, base_size, 616), fill=white)
d.rectangle((408, 0, 616, base_size), fill=white)
d.rectangle((0, 456, base_size, 568), fill=red)
d.rectangle((456, 0, 568, base_size), fill=red)
# Slightly translucent flag to let the Liquid Glass navy substrate remain visible.
flag.putalpha(flag.getchannel('A').point(lambda p: round(p * .88)))
art = Image.alpha_composite(background, flag)

# Center the user's original mark within Apple's icon safe area.
mark.thumbnail((610, 610), Image.Resampling.LANCZOS)
mark_layer = Image.new('RGBA', (base_size, base_size), (255, 255, 255, 0))
mark_color = Image.new('RGBA', mark.size, (248, 250, 255, 255))
mark_color.putalpha(mark)
px = (base_size - mark.width) // 2
py = (base_size - mark.height) // 2
# Gentle soft shadow for separation from the diagonal flag stripes.
shadow_mask = Image.new('L', (base_size, base_size), 0)
shadow_mask.paste(mark, (px, py + 9))
shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(14))
shadow = Image.new('RGBA', (base_size, base_size), (0, 0, 14, 105))
shadow.putalpha(shadow_mask.point(lambda p: round(p * .45)))
art = Image.alpha_composite(art, shadow)
mark_layer.alpha_composite(mark_color, (px, py))
art = Image.alpha_composite(art, mark_layer)
maskable_art = art.copy()

# Rounded iOS-style mask, soft specular highlight, and inset glass rim.
mask = Image.new('L', (base_size, base_size), 0)
ImageDraw.Draw(mask).rounded_rectangle((6, 6, base_size - 7, base_size - 7), radius=222, fill=255)
art.putalpha(mask)
sheen = Image.new('RGBA', (base_size, base_size), (255, 255, 255, 0))
sheen_pixels = sheen.load()
for y in range(base_size):
    a = round(24 * max(0, 1 - y / 440) ** 1.6)
    for x in range(base_size):
        sheen_pixels[x, y] = (255, 255, 255, a)
sheen.putalpha(ImageChops.multiply(sheen.getchannel('A'), mask))
art = Image.alpha_composite(art, sheen)
# Draw a delicate inner rim, leaving the icon silhouette intact.
rim = Image.new('RGBA', (base_size, base_size), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle((12, 12, base_size - 13, base_size - 13), radius=216, outline=(255, 255, 255, 70), width=3)
art = Image.alpha_composite(art, rim)

icons = ROOT / 'public' / 'icons'
icons.mkdir(parents=True, exist_ok=True)
maskable_art.resize((512, 512), Image.Resampling.LANCZOS).save(icons / 'icon-maskable-512.png', optimize=True)
for size, filename in [(1024, 'icon-1024.png'), (512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'apple-touch-icon.png')]:
    out = art.resize((size, size), Image.Resampling.LANCZOS)
    out.save(icons / filename, optimize=True)
art.resize((64, 64), Image.Resampling.LANCZOS).save(ROOT / 'public' / 'favicon.png', optimize=True)
art.resize((64, 64), Image.Resampling.LANCZOS).save(ROOT / 'public' / 'favicon.ico', format='ICO', sizes=[(16,16),(32,32),(48,48),(64,64)])

