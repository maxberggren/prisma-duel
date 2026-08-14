#!/usr/bin/env python3
"""Cut inspection crops out of a render so detail can be judged at 1:1.
usage: crop.py <shot.png> <outdir> [--zoom 2]"""
import sys, pathlib
from PIL import Image
src, outdir = sys.argv[1], sys.argv[2]
zoom = 2
if '--zoom' in sys.argv: zoom = float(sys.argv[sys.argv.index('--zoom')+1])
im = Image.open(src).convert('RGB'); W, H = im.size
# fractional boxes (x0,y0,x1,y1) of the frame
BOXES = {
    'emitters':  (0.05, 0.15, 0.32, 0.75),
    'mouth':     (0.30, 0.10, 0.62, 0.70),
    'discface':  (0.42, 0.35, 0.75, 0.95),
    'discbody':  (0.50, 0.05, 0.80, 0.60),
    'exitfan':   (0.60, 0.60, 1.00, 1.00),
    'wall':      (0.00, 0.75, 0.30, 1.00),
    'panel':     (0.78, 0.00, 1.00, 0.70),
}
out = pathlib.Path(outdir); out.mkdir(parents=True, exist_ok=True)
for name, (x0,y0,x1,y1) in BOXES.items():
    b = im.crop((int(x0*W), int(y0*H), int(x1*W), int(y1*H)))
    b = b.resize((int(b.width*zoom), int(b.height*zoom)), Image.LANCZOS)
    b.save(out / f'{name}.png')
    print(name, b.size)
