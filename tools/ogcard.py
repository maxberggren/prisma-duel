#!/usr/bin/env python3
"""Compose the social card: a rendered battle frame with the wordmark on it.

usage: ogcard.py <shot.png> <out.png> [--size 1200x630] [--tagline "..."]

A link preview is seen at about a third of its real size in a timeline, so the
card is not simply the screenshot: the bottom-left corner is darkened just
enough to carry the lockup, and the type is set large enough to survive that
scale. The picture itself is untouched everywhere else.

The layout is HTML rendered by Chromium rather than ImageMagick draw commands,
because the lockup is the same mark and the same type scale the page uses, and
keeping it in CSS means it can be edited by looking at it.
"""
import argparse, base64, pathlib, shutil, subprocess, sys, tempfile

R = pathlib.Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument('shot')
ap.add_argument('out')
ap.add_argument('--size', default='1200x630')
ap.add_argument('--logo', default=str(R / 'assets' / 'logo.svg'))
ap.add_argument('--title', default='PRISMA')
ap.add_argument('--tagline', default='TURN-BASED LASER DUELS THROUGH REFRACTING CRYSTALS')
a = ap.parse_args()
W, H = (int(v) for v in a.size.split('x'))

CHROME = next((c for c in ('chromium', 'google-chrome-stable', 'google-chrome', 'chromium-browser')
               if shutil.which(c)), None)
if not CHROME: sys.exit('no chromium on PATH')

shot = base64.b64encode(pathlib.Path(a.shot).read_bytes()).decode()
logo = pathlib.Path(a.logo).read_text().split('?>')[-1]
# the mark alone: on a photograph its own backdrop would read as a pasted tile
logo = logo.replace('<rect width="512" height="512" rx="0" fill="url(#vignette)"/>', '')

PAGE = """<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:%(W)dpx;height:%(H)dpx;overflow:hidden;background:#05060a}
  .card{position:relative;width:%(W)dpx;height:%(H)dpx;
        background:url(data:image/png;base64,%(shot)s) center/cover no-repeat}
  /* Only as much shade as the words need, and only under them: a wash across
     the whole left side put the shooter and its muzzle into the dark, which is
     the one part of the picture that explains what the beam is. */
  .scrim{position:absolute;inset:0;
         background:radial-gradient(120%% 85%% at 0%% 118%%,rgba(3,5,10,.92) 0%%,
                                    rgba(3,5,10,.62) 38%%,rgba(3,5,10,0) 70%%),
                    linear-gradient(0deg,rgba(3,5,10,.66) 0%%,rgba(3,5,10,0) 30%%)}
  .lock{position:absolute;left:%(pad)dpx;bottom:%(pad)dpx;display:flex;align-items:flex-end;gap:%(gap)dpx}
  .mark{width:%(mark)dpx;height:%(mark)dpx;flex:none;filter:drop-shadow(0 6px 22px rgba(0,0,0,.7))}
  .mark svg{width:100%%;height:100%%;display:block}
  .txt{font-family:"Adwaita Sans",Inter,"Noto Sans","Liberation Sans",sans-serif;color:#fff}
  h1{margin:0;font-size:%(title)dpx;line-height:.92;font-weight:800;letter-spacing:.11em;
     text-shadow:0 4px 30px rgba(0,0,0,.75)}
  /* The rule is the mark's own idea repeated: white in, spectrum out. */
  .rule{height:5px;width:%(rule)dpx;margin:%(rgap)dpx 0;border-radius:3px;
        background:linear-gradient(90deg,#fff 0 14%%,#ff5347 14%%,#ff9f2e,#ffd93d,#4ee27a,#3aa0ff,#a55cff)}
  p{margin:0;font-size:%(sub)dpx;font-weight:600;letter-spacing:.155em;color:#cbd8ea;
    text-shadow:0 2px 14px rgba(0,0,0,.8)}
</style>
<div class="card"><div class="scrim"></div>
  <div class="lock">
    <div class="mark">%(logo)s</div>
    <div class="txt"><h1>%(title_text)s</h1><div class="rule"></div><p>%(tagline)s</p></div>
  </div>
</div>
""" % {
    'W': W, 'H': H, 'shot': shot, 'logo': logo,
    'pad': round(H * 0.085), 'gap': round(H * 0.036), 'mark': round(H * 0.20),
    'title': round(H * 0.115), 'sub': round(H * 0.029),
    'rule': round(H * 0.30), 'rgap': round(H * 0.026),
    'title_text': a.title, 'tagline': a.tagline,
}

with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False) as f:
    f.write(PAGE); tmp = f.name
subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                '--force-device-scale-factor=1', '--window-size=%d,%d' % (W, H),
                '--screenshot=' + a.out, '--virtual-time-budget=6000', 'file://' + tmp],
               capture_output=True, text=True, timeout=300)
pathlib.Path(tmp).unlink(missing_ok=True)
p = pathlib.Path(a.out)
if not p.exists(): sys.exit('chromium wrote no image')
print('%s  %d bytes' % (a.out, p.stat().st_size))
