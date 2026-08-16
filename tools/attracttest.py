#!/usr/bin/env python3
"""Fail if the start screen's attract match does not hand the arena back cleanly.

The lobby runs a real match behind it. That demo owns the camera, the frame
accumulator, the bot set and the particle store, so starting a real game has to
take all of them back -- a leftover would show up as a zoomed-in camera, smoke
from someone else's fight, or bots injecting moves into a multiplayer game.
None of that is visible in a screenshot, so it is checked here.

usage: attracttest.py [file.html]
"""
import subprocess, sys, re, pathlib, tempfile, os, json

src = sys.argv[1] if len(sys.argv) > 1 else '/home/max/Code/lazer/index.html'

probe = """
<script>
window.__err = [];
addEventListener('error', e => window.__err.push('' + e.message));
addEventListener('load', () => setTimeout(() => {
  const R = {};
  try {
    // let the demo get going and take the camera somewhere non-default
    for (let i = 0; i < 240; i++) attractFrame(1.0);
    R.demoRan       = ATT.on === true && G.state.turn >= 3;
    R.demoMovedCam  = Math.abs(cam.zoom - 1) > 0.2;
    R.chromeHidden  = document.getElementById('ui').classList.contains('lobbyup');
    /* The demo must NOT hold the frame accumulator. Blending the last frames
       is free antialiasing on a still image, but this camera always drifts, so
       every blend laid offset copies of a beam over each other and the laser
       came out striped. */
    R.accumFree     = accHold === 0;
    const fxBefore  = fx.length;
    spawnDamage(0, 9);                             // damage readouts are match HUD
    R.noDamageNumbers = fx.length === fxBefore;
    const camBefore = cam.zoom;

    document.getElementById('bSolo').click();      // start a real practice match

    R.attractOff    = ATT.on === false;
    R.lobbyGone     = document.getElementById('lobby').style.display === 'none';
    R.chromeBack    = !document.getElementById('ui').classList.contains('lobbyup');
    /* A match opens framed to COVER the viewport with a little over, so the
       mirrored border sits outside the picture -- not at the plain fit. */
    R.camFramed     = cam.zoom > 1.0 &&
                      (cam.x - W/(2*viewScale)) > 0 && (cam.x + W/(2*viewScale)) < VIEW_W &&
                      (cam.y - viewAvailH/(2*viewScale)) > 0 &&
                      (cam.y + viewAvailH/(2*viewScale)) < VIEW_H;
    R.camWasMoved   = Math.abs(camBefore - 1) > 0.2;
    R.accumReleased = accHold === 0;
    R.vfxCleared    = vfxLoad() === 0;
    R.freshMatch    = G.state.turn === 0 && G.state.ships.every(s => s.alive);
    R.botsAreThree  = G.bots.size === 3 && !G.bots.has(0);
    R.planPhase     = G.phase === 'plan';
    /* The point of this one is that showRematch() empties .obody, so a demo
       that ran to a finish must not have left the panel gutted. Checks the
       commit button rather than a slider -- the sliders are gone; the only
       control now is the course drag on the arena itself. */
    R.ordersIntact  = !!document.querySelector('.orders .obody #oCommit');

    // and the demo must not keep stepping the real match behind our backs
    const t0 = G.state.turn, s0 = G.sub;
    for (let i = 0; i < 40; i++) attractFrame(1.0);
    R.demoInert     = G.state.turn === t0 && G.sub === s0;

    R.noErrors      = window.__err.length === 0;
  } catch (e) { R.threw = e.message; }
  document.body.setAttribute('data-att', JSON.stringify(R));
}, 500));
</script>
"""

page = pathlib.Path(src).read_text().replace('</body>', probe + '</body>')
tmp = pathlib.Path(tempfile.gettempdir()) / ('atttest_%d.html' % os.getpid())
tmp.write_text(page)

r = subprocess.run(
    ['chromium', '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
     '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars',
     '--window-size=1400,800', '--virtual-time-budget=4000', '--dump-dom',
     'file://' + str(tmp)],
    capture_output=True, text=True, timeout=300)
tmp.unlink(missing_ok=True)

m = re.search(r'data-att="([^"]*)"', r.stdout or '')
if not m:
    print('  FAIL probe never ran'); print('\nattract: BROKEN'); sys.exit(1)
R = json.loads(m.group(1).replace('&quot;', '"'))

LABELS = [
    ('demoRan',       'the lobby runs a demo match'),
    ('demoMovedCam',  'the demo takes the camera somewhere of its own'),
    ('chromeHidden',  'in-match HUD is hidden while the lobby is up'),
    ('accumFree',     'the demo never blends frames (it would stripe the beams)'),
    ('noDamageNumbers', 'no floating damage numbers over the demo'),
    ('camWasMoved',   'the camera really had moved before the handover'),
    ('attractOff',    'starting a match stops the demo'),
    ('lobbyGone',     'the lobby closes'),
    ('chromeBack',    'the in-match HUD comes back'),
    ('camFramed',     'the match opens framed with the arena border off screen'),
    ('accumReleased', 'the accumulator is left free after handover'),
    ('vfxCleared',    "the demo's smoke and fire do not bleed into the match"),
    ('freshMatch',    'the match starts at turn 0 with everyone alive'),
    ('botsAreThree',  'exactly three bots, and the player is not one'),
    ('planPhase',     'the match opens in the planning phase'),
    ('ordersIntact',  'the orders panel is intact'),
    ('demoInert',     'the demo cannot step the real match afterwards'),
    ('noErrors',      'no uncaught errors'),
]
ok = True
if 'threw' in R:
    print('  FAIL probe threw: ' + R['threw']); ok = False
for key, label in LABELS:
    passed = R.get(key) is True
    print(('  ok   ' if passed else '  FAIL ') + label)
    ok = ok and passed
print('\nattract: ' + ('clean' if ok else 'BROKEN'))
sys.exit(0 if ok else 1)
