#!/usr/bin/env python3
"""Photograph a composed hero frame: one fighter firing through a crystal, the
beam coming out the far side as a rainbow.

usage: poster.py <out.png> [--seed N] [--size WxH] [--scale S] [--zoom Z]
                 [--samples N] [--src file.html] [--json]

The attract screen already knows what a good shot looks like -- it scores a
heading by how much glass the ray crosses, how far off-axis it enters (Snell
spreads the colours with the sine of the angle of incidence) and how much clear
run the fan has on the far side. This reuses that same scorer, but sweeps every
crystal and a ring of firing positions around it instead of only the headings a
live pilot happens to have, then frames the camera on the result.

Rendering goes through the page's own accumulation buffer and the frame is
pulled off the GL default framebuffer with readPixels, for the reason vfxshot.py
gives: --screenshot photographs whatever the compositor last had, which under
load is a frame from before the scene was posed.

--json prints the chosen composition (seed, crystal, score) instead of nothing,
which is what the seed sweep reads to rank candidates.
"""
import argparse, base64, json, os, pathlib, subprocess, sys, tempfile

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--seed', type=int, default=20260815)
ap.add_argument('--size', default='1200x630')
ap.add_argument('--scale', default='1')          # device pixel ratio; 2 = supersampled
ap.add_argument('--zoom', type=float, default=0)  # 0 = pick one that frames the beam
ap.add_argument('--frame', type=float, default=0.80)   # slack around the beam, lower = wider
ap.add_argument('--samples', type=int, default=64)
ap.add_argument('--wreck', type=float, default=0)   # seconds after a kill; 0 = nobody down
ap.add_argument('--src', default=str(pathlib.Path(__file__).resolve().parent.parent / 'index.html'))
ap.add_argument('--json', action='store_true')
a = ap.parse_args()
W, H = a.size.split('x')

PROBE = r"""
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

/* Where the ray leaves the far face, and how far it can run after that. */
function __exit(x, y, hd) {
  const dx = Math.cos(hd), dy = Math.sin(hd);
  let t = MUZZLE, seen = false;
  for (; t < 4.2; t += 0.012) {
    const inside = prismAt(x + dx * t, y + dy * t) >= 0;
    if (inside) seen = true; else if (seen) break;
  }
  return { t, x: x + dx * t, y: y + dy * t, dx, dy, entered: seen };
}

addEventListener('load', () => setTimeout(() => {
  let info;
  try {
    /* Size the canvas outright rather than trusting the window: headless
       Chrome still reserves the height a tab strip would have taken, so a
       --window-size of 1200x630 renders a canvas some ninety pixels short. */
    canvas.style.width = TW__ + 'px'; canvas.style.height = TH__ + 'px';
    document.documentElement.style.overflow = 'hidden';
    /* The overlay is not in the picture (this reads the GL buffer, not the
       page) but the orders panel still shortens the camera's usable height,
       which would leave a band of nothing below the arena floor. */
    ui.style.display = 'none';
    resize();
    startSolo(SEED__);
    const S = G.state.ships, PR = arena.prisms;
    for (const sh of S) { sh.firing = false; sh.alive = true; }

    /* Sweep: every crystal, a ring of stand-off positions around it, a fan of
       headings from each. The scorer is the attract screen's own. */
    let best = null;
    for (let pi = 0; pi < PR.length; pi++) {
      const P = PR[pi];
      for (let ai = 0; ai < 72; ai++) {
        const A = ai / 72 * Math.PI * 2;
        for (const D of [0.55, 0.75, 0.95]) {
          const x = P.x + Math.cos(A) * (P.r + D), y = P.y + Math.sin(A) * (P.r + D);
          const M = RULES.HULL_R * 2.2;
          if (x < M || y < M || x > arena.w - M || y > arena.h - M) continue;
          if (prismAt(x, y) >= 0) continue;
          for (let hi = -6; hi <= 6; hi++) {
            const hd = A + Math.PI + hi * 0.055;
            const sc = attractShotScore(S[0], hd, x, y);
            if (!isFinite(sc)) continue;
            const e = __exit(x, y, hd);
            if (!e.entered) continue;
            /* The fan has to have somewhere to go and has to stay on camera. */
            const run = Math.min(2.2, (() => {
              const h = sceneHit(e.x + e.dx * 0.02, e.y + e.dy * 0.02, e.dx, e.dy, -1);
              return h ? h.t : 2.2;
            })());
            /* Aim along the frame's long axis. The scorer knows what makes a
               good rainbow but nothing about the picture's shape, and on a
               portrait canvas its favourite shot is a horizontal one that
               leaves the top and bottom thirds empty. */
            const align = H > W ? Math.abs(Math.sin(hd)) : Math.abs(Math.cos(hd));
            const total = sc + run * 1.5 + align * 60;
            if (!best || total > best.total) best = { total, sc, pi, x, y, hd, e, run };
          }
        }
      }
    }
    if (!best) throw new Error('no shot found for this seed');

    /* Pose. The shooter fires; the rest of the field stands in the fan's way
       and downrange of it, because a rainbow that lands on nobody is scenery. */
    const sh0 = S[0];
    sh0.x = best.x; sh0.y = best.y; sh0.heading = best.hd; sh0.firing = true;
    sh0.speed = RULES.SPEED_MAX * 0.62;
    const e = best.e;
    const place = (sh, along, across, head) => {
      const nx = -e.dy, ny = e.dx;
      sh.x = clamp(e.x + e.dx * along + nx * across, 0.14, arena.w - 0.14);
      sh.y = clamp(e.y + e.dy * along + ny * across, 0.14, arena.h - 0.14);
      sh.heading = head; sh.speed = RULES.SPEED_MAX * 0.5;
      /* Never park a hull inside glass: it would be lit from within and read
         as a bug rather than as a fighter. */
      for (let g = 0; g < 40 && prismAt(sh.x, sh.y) >= 0; g++) { sh.x += e.dx * 0.05; sh.y += e.dy * 0.05; }
    };
    place(S[1], best.run * 0.86, 0.10, best.hd + 2.5);
    place(S[2], best.run * 0.62, -0.34, best.hd - 1.9);
    place(S[3], best.run * 1.05, 0.46, best.hd + 0.7);
    S[1].shield = 22; S[1].hull = 61;
    S[2].shield = 68;

    /* Scars, so the frame reads as the middle of a fight rather than turn one.
       A little smoke off one of the far fighters, no wreckage in the way. */
    vfxSeed = 99;
    spawnDamage(1, 34);
    /* Optionally a fourth fighter already gone, burning off to one side: the
       frame then tells a whole story rather than a single shot. It is stepped
       past the flash to the point where the fireball has become a lit smoke
       column, which photographs far better than a white blob. */
    if (WRECK__ > 0) {
      const w = S[3];
      explode(G.state, w, 'poster'); w.vfxDone = true; spawnDestruction(w);
      for (let k = 0; k < Math.round(WRECK__ * 120); k++) { stepVfx(1 / 120); stepDebris(G.state); }
    }
    for (let k = 0; k < 26; k++) stepVfx(1 / 60);

    /* Camera: the muzzle, the glass and the fan, with the fan given the room.
       camTouched keeps the match framing from taking the view back. */
    camTouched = true;
    const throwOut = Math.max(best.run, 0.5) * 1.6;
    const fx = e.x + e.dx * throwOut, fy = e.y + e.dy * throwOut;
    cam.x = (sh0.x + fx) * 0.5; cam.y = (sh0.y + fy) * 0.5;
    const span = Math.hypot(fx - sh0.x, fy - sh0.y) + 1.05;
    cam.zoom = ZOOM__ > 0 ? ZOOM__ : clamp((VIEW_W / span) * FRAME__, 1.0, 5.0);
    /* Never wider than covers the frame. The arena is 16:9; anything taller
       than that -- a phone screenshot above all -- shows a band of nothing
       below the floor at the zoom that frames the beam nicely. This is the
       match camera's own cover rule (see frameArenaForMatch). */
    cam.zoom = 1; updateView();                       // settle fitScale first
    const cover = Math.max(W / VIEW_W, viewAvailH / VIEW_H) / Math.max(1e-6, fitScale);
    cam.zoom = Math.max(ZOOM__ > 0 ? ZOOM__ : clamp((VIEW_W / span) * FRAME__, 1.0, 5.0),
                        cover * 1.02);
    updateView();

    dirty = true;
    for (let k = 0; k < SAMPLES__; k++) render(0.0);
    __grab();
    info = { seed: SEED__, prism: best.pi, score: +best.total.toFixed(3),
             zoom: +cam.zoom.toFixed(3), run: +best.run.toFixed(3), W: W, H: H };
    ctxLost = true;                                   // park the app: nothing may redraw now
  } catch (err) { info = { err: '' + (err && err.stack || err) }; }
  document.title = JSON.stringify(info);
}, 260));
</script>
"""

probe = (PROBE.replace('SEED__', str(a.seed))
              .replace('ZOOM__', str(a.zoom))
              .replace('FRAME__', str(a.frame))
              .replace('WRECK__', str(a.wreck))
              .replace('TW__', W).replace('TH__', H)
              .replace('SAMPLES__', str(a.samples)))
page = pathlib.Path(a.src).read_text().replace('</body>', probe + '</body>')
tmp = pathlib.Path(tempfile.gettempdir()) / ('poster_%d_%d.html' % (os.getpid(), a.seed))
tmp.write_text(page)
pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)

r = subprocess.run(['chromium', '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
                    '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars',
                    '--force-device-scale-factor=' + a.scale,
                    # roomier than the canvas, which the page sizes itself
                    '--window-size=%d,%d' % (int(W) + 40, int(H) + 200),
                    '--virtual-time-budget=600000', '--dump-dom',
                    'file://' + str(tmp)], capture_output=True, text=True, timeout=3600)
for line in (r.stderr or '').splitlines():
    if 'Uncaught' in line or 'ERROR:CONSOLE' in line:
        print(line[:400], file=sys.stderr)
dom = r.stdout or ''
title = ''
for part in dom.split('<title>')[1:]:
    title = part.split('<')[0]
tag = 'data:image/png;base64,'
if tag in dom:
    b64 = dom.split(tag, 1)[1].split('<')[0].strip()
    pathlib.Path(a.out).write_bytes(base64.b64decode(b64))
else:
    print('!! no canvas readback -- the page did not get as far as rendering', file=sys.stderr)
tmp.unlink(missing_ok=True)
print(json.dumps({'out': a.out, 'info': title}) if a.json else (a.out + ' ' + title))
