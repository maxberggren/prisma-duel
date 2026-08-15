#!/usr/bin/env python3
"""Render the destruction effect at a given moment after the kill.

usage: vfxshot.py <out.png> <t-seconds> [w] [h] [source.html]

Builds a throwaway page from the source, blows up two ships, advances the
particle system and the wreckage physics by t seconds, then photographs it. Use
a spread of t to judge the whole arc: 0.05 flash, 0.3 fireball, 1.5 cooling,
6 settled smoke.

Two details that matter on a busy machine, both learned the hard way:

  * the spawn, the step and the render all happen inside ONE synchronous task,
    so the app's own rAF loop cannot advance the particles past the moment being
    asked for while the CPU rasteriser grinds;
  * the frame is pulled off the GL default framebuffer with readPixels rather
    than left to --screenshot, which under load photographs a stale compositor
    surface and silently hands back a pre-match frame.

The image is therefore the canvas only, with no HUD overlay on top of it.
"""
import base64, pathlib, subprocess, sys, tempfile, os

out = sys.argv[1]
t   = float(sys.argv[2])
w   = sys.argv[3] if len(sys.argv) > 3 else '1300'
h   = sys.argv[4] if len(sys.argv) > 4 else '740'
src = sys.argv[5] if len(sys.argv) > 5 else '/home/max/Code/lazer/index.html'

probe = """
<script>
function __grab() {
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {                       // GL is bottom-up
    const s = (H - 1 - y) * W * 4, d = y * W * 4;
    for (let x = 0; x < W * 4; x++) img.data[d + x] = px[s + x];
    for (let x = 3; x < W * 4; x += 4) img.data[d + x] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const box = document.createElement('div');
  box.style.display = 'none'; box.textContent = c.toDataURL('image/png');
  document.body.appendChild(box);
}
addEventListener('load', () => setTimeout(() => {
  const P = window.__prisma;
  document.getElementById('bSolo').click();
  setTimeout(() => {
    let info;
    try {
      const S = P.G.state.ships;
      explode(P.G.state, S[1], 't'); S[1].vfxDone = true; spawnDestruction(S[1]);
      explode(P.G.state, S[3], 't'); S[3].vfxDone = true; spawnDestruction(S[3]);
      const T = %f, dt = 1/120;
      for (let k = 0; k < Math.max(1, Math.round(T/dt)); k++) { stepVfx(dt); stepDebris(P.G.state); }
      dirty = true;
      for (let k = 0; k < 24; k++) P.render(0.0);     // converge the supersampler
      __grab();
      info = { t:T, fire:vfx.fire.length, puffs:vfx.puffs.length,
               sparks:vfx.sparks.length, glows:vfx.glows.length, W:W, H:H };
      ctxLost = true;                                 // park the app: nothing may redraw now
    } catch (e) { info = { err: 'Uncaught ' + e }; }
    document.title = JSON.stringify(info);
  }, 250);
}, 250));
</script>
"""% t

page = pathlib.Path(src).read_text().replace('</body>', probe + '</body>')
tmp = pathlib.Path(tempfile.gettempdir()) / ('vfx_%s.html' % os.getpid())
tmp.write_text(page)
pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)

r = subprocess.run(['chromium', '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
                    '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars',
                    '--force-device-scale-factor=1', '--window-size=%s,%s' % (w, h),
                    '--virtual-time-budget=15000', '--dump-dom',
                    'file://' + str(tmp)], capture_output=True, text=True, timeout=1800)
for line in (r.stderr or '').splitlines():
    if 'Uncaught' in line or 'compil' in line.lower() or 'ERROR:CONSOLE' in line:
        print(line[:400])
dom = r.stdout or ''
title = ''
for part in dom.split('<title>')[1:]:
    title = part.split('<')[0]
tag = 'data:image/png;base64,'
if tag in dom:
    b64 = dom.split(tag, 1)[1].split('<')[0].strip()
    pathlib.Path(out).write_bytes(base64.b64decode(b64))
else:
    print('!! no canvas readback -- the page did not get as far as rendering')
print(out, title)
tmp.unlink(missing_ok=True)
