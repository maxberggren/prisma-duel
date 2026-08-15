#!/usr/bin/env python3
"""Render the destruction effect at a given moment after the kill.

usage: vfxshot.py <out.png> <t-seconds> [w] [h] [source.html]

Builds a throwaway page from the source, blows up two ships, advances the
particle system and the wreckage physics by t seconds, then screenshots. Use a
spread of t to judge the whole arc: 0.05 flash, 0.3 fireball, 1.5 cooling,
6 settled smoke.
"""
import pathlib, subprocess, sys, tempfile, os

out = sys.argv[1]
t   = float(sys.argv[2])
w   = sys.argv[3] if len(sys.argv) > 3 else '1300'
h   = sys.argv[4] if len(sys.argv) > 4 else '740'
src = sys.argv[5] if len(sys.argv) > 5 else '/home/max/Code/lazer/index.html'

probe = """
<script>
addEventListener('load', () => setTimeout(() => {
  const P = window.__prisma;
  document.getElementById('bSolo').click();
  const S = P.G.state.ships;
  explode(P.G.state, S[1], 't'); S[1].vfxDone = true; spawnDestruction(S[1]);
  explode(P.G.state, S[3], 't'); S[3].vfxDone = true; spawnDestruction(S[3]);
  const T = %f, dt = 1/120;
  for (let k = 0; k < Math.max(1, Math.round(T/dt)); k++) { stepVfx(dt); stepDebris(P.G.state); }
  dirty = true;
  for (let k = 0; k < 40; k++) P.render(0.016);
  document.title = JSON.stringify({ t:T, puffs:vfx.puffs.length, sparks:vfx.sparks.length });
}, 400));
</script>
""" % t

page = pathlib.Path(src).read_text().replace('</body>', probe + '</body>')
tmp = pathlib.Path(tempfile.gettempdir()) / ('vfx_%s.html' % os.getpid())
tmp.write_text(page)
pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)

r = subprocess.run(['chromium', '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
                    '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars',
                    '--force-device-scale-factor=1', '--window-size=%s,%s' % (w, h),
                    '--screenshot=' + out, '--virtual-time-budget=6000', '--dump-dom',
                    'file://' + str(tmp)], capture_output=True, text=True, timeout=180)
for line in (r.stderr or '').splitlines():
    if 'Uncaught' in line or 'compil' in line.lower():
        print(line)
title = ''
for part in (r.stdout or '').split('<title>')[1:]:
    title = part.split('<')[0]
print(out, title)
tmp.unlink(missing_ok=True)
