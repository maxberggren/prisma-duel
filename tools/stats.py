#!/usr/bin/env python3
"""Objective exposure/contrast readout for a render. usage: stats.py <png>"""
import sys
from PIL import Image
import statistics as st
im = Image.open(sys.argv[1]).convert('RGB')
W,H = im.size
px = list(im.get_flattened_data()) if hasattr(im,"get_flattened_data") else list(im.getdata())
lum = [ (0.2126*r+0.7152*g+0.0722*b)/255 for r,g,b in px ]
lum.sort()
def q(p): return lum[int(p*(len(lum)-1))]
clip = sum(1 for l in lum if l > 0.995)/len(lum)
black = sum(1 for l in lum if l < 0.02)/len(lum)
print(f"size {W}x{H}")
print(f"luma  p1={q(.01):.3f} p10={q(.10):.3f} median={q(.50):.3f} p90={q(.90):.3f} p99={q(.99):.3f} max={lum[-1]:.3f}")
print(f"clipped(>0.995)={clip*100:.2f}%   near-black(<0.02)={black*100:.2f}%")
sat = [ (max(p)-min(p))/max(1,max(p)) for p in px ]
print(f"mean saturation={sum(sat)/len(sat):.3f}")
