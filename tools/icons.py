#!/usr/bin/env python3
"""Rasterise assets/logo.svg into every icon the page asks for.

usage: icons.py [--out assets] [--svg assets/logo.svg]

Chromium does the rasterising rather than ImageMagick: the SVG has blurs and
gradients, the browser is what will actually draw the vector copy, and a
delegate that renders it differently would leave the PNG and the SVG looking
like two different logos. ImageMagick only downsamples the result.

Writes:
  favicon.ico            16/32/48, for the tab and for anything old
  icon-192.png           the small PWA / Android icon
  icon-512.png           the large one, and the source for the rest
  icon-maskable-512.png  same mark inside Android's 80% safe circle
  apple-touch-icon.png   180px, opaque, no transparency (iOS composites badly)
"""
import argparse, base64, pathlib, shutil, subprocess, sys, tempfile

R = pathlib.Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument('--svg', default=str(R / 'assets' / 'logo.svg'))
ap.add_argument('--out', default=str(R / 'assets'))
a = ap.parse_args()
out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
svg = pathlib.Path(a.svg).read_text()

CHROME = next((c for c in ('chromium', 'google-chrome-stable', 'google-chrome', 'chromium-browser')
               if shutil.which(c)), None)
if not CHROME: sys.exit('no chromium on PATH')
MAGICK = shutil.which('magick') or shutil.which('convert')
if not MAGICK: sys.exit('no imagemagick on PATH')


def render(markup, w, h, dest):
    """Screenshot a bare page holding `markup` at exactly w x h."""
    page = ('<!doctype html><meta charset=utf-8>'
            '<style>html,body{margin:0;padding:0;background:transparent;'
            'width:%dpx;height:%dpx;overflow:hidden}svg{display:block}</style>%s' % (w, h, markup))
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False) as f:
        f.write(page); tmp = f.name
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    '--force-device-scale-factor=1', '--default-background-color=00000000',
                    '--window-size=%d,%d' % (w, h), '--screenshot=' + str(dest),
                    '--virtual-time-budget=4000', 'file://' + tmp],
                   capture_output=True, text=True, timeout=180)
    pathlib.Path(tmp).unlink(missing_ok=True)
    if not pathlib.Path(dest).exists(): sys.exit('chromium wrote no %s' % dest)


def sized(px):
    return svg.replace('width="512" height="512"', 'width="%d" height="%d"' % (px, px), 1)


big = out / 'icon-512.png'
render(sized(512), 512, 512, big)

# The 192 comes from the 512 rather than from its own render: downsampling a
# supersampled image keeps the thin spectrum bands smooth, which rasterising
# straight to 192 does not.
subprocess.run([MAGICK, str(big), '-filter', 'Lanczos', '-resize', '192x192',
                str(out / 'icon-192.png')], check=True)

# Android crops a maskable icon to a circle of 80% of the canvas, so the mark
# is drawn at 62.5% and centred, with the background bled to the edges.
mask = ('<div style="width:512px;height:512px;background:#05060a;display:flex;'
        'align-items:center;justify-content:center">'
        + sized(360).replace('<rect width="512" height="512" rx="0" fill="url(#vignette)"/>', '')
        + '</div>')
render(mask, 512, 512, out / 'icon-maskable-512.png')

# iOS ignores transparency and rounds the corners itself; a flat opaque square
# is what it wants.
subprocess.run([MAGICK, str(big), '-filter', 'Lanczos', '-resize', '180x180',
                '-background', '#05060a', '-alpha', 'remove', '-alpha', 'off',
                str(out / 'apple-touch-icon.png')], check=True)

# A real multi-size .ico. 16px is where the fan turns to mush, so that layer is
# sharpened after the downsample.
tmpdir = pathlib.Path(tempfile.mkdtemp())
layers = []
for px in (16, 32, 48):
    p = tmpdir / ('ico%d.png' % px)
    subprocess.run([MAGICK, str(big), '-filter', 'Lanczos', '-resize', '%dx%d' % (px, px),
                    '-unsharp', '0x0.6+0.7+0.02', str(p)], check=True)
    layers.append(str(p))
subprocess.run([MAGICK] + layers + [str(out / 'favicon.ico')], check=True)
shutil.rmtree(tmpdir, ignore_errors=True)

for f in ('icon-512.png', 'icon-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon.ico'):
    p = out / f
    print('%-24s %7d bytes' % (f, p.stat().st_size))
