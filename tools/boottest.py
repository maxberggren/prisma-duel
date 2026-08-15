#!/usr/bin/env python3
"""Fail if the shipped page does not boot cleanly.

This exists because index.html is assembled from several sources and edited by
several hands: twice during development a declaration was moved or deleted and
the page died on load with a ReferenceError, which no other test noticed.

usage: boottest.py [file.html]
"""
import subprocess, sys, re, pathlib, tempfile, os

src = sys.argv[1] if len(sys.argv) > 1 else '/home/max/Code/lazer/index.html'
# Rendering a destroyed ship exercises passes that a quiet frame never touches
# — fire, wreckage and their compositing order. An ordering bug there took the
# whole page down the moment anything blew up, twice, so the boot check blows
# something up on purpose.
probe = """
<script>
addEventListener('load', () => setTimeout(() => {
  try {
    const P = window.__prisma;
    const b = document.getElementById('bSolo'); if (b) b.click();
    const S = P.G.state.ships;
    explode(P.G.state, S[1], 'boottest');
    S[1].vfxDone = true; spawnDestruction(S[1]);
    for (let k = 0; k < 60; k++) { stepVfx(1/60); stepDebris(P.G.state); }
    dirty = true;
    for (let k = 0; k < 8; k++) P.render(0.016);
    document.body.setAttribute('data-boom', 'ok');
  } catch (e) { document.body.setAttribute('data-boom', 'THREW ' + e.message); }
}, 900));
</script>
"""
page = pathlib.Path(src).read_text().replace('</body>', probe + '</body>')
tmp = pathlib.Path(tempfile.gettempdir()) / ('boot_%d.html' % os.getpid())
tmp.write_text(page)

r = subprocess.run(
    ['chromium', '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
     '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars',
     '--window-size=900,520', '--virtual-time-budget=6000', '--dump-dom',
     'file://' + str(tmp) + '?solo=1'],
    capture_output=True, text=True, timeout=200)
tmp.unlink(missing_ok=True)

fails = []
for line in (r.stderr or '').splitlines():
    if re.search(r'Uncaught|ReferenceError|SyntaxError|TypeError', line):
        fails.append(line.split('CONSOLE:')[-1].strip() or line.strip())

dom = r.stdout or ''
checks = [
    ('canvas present',      '<canvas' in dom),
    ('orders panel present', 'id="orders"' in dom),
    ('a match actually started (roster populated)', 'class="card' in dom),
    ('no uncaught errors',  not fails),
    ('a destroyed ship renders', 'data-boom="ok"' in dom),
]
ok = True
for name, passed in checks:
    print(('  ok   ' if passed else '  FAIL ') + name)
    ok = ok and passed
for f in fails[:5]:
    print('       ' + f)
print('\nboot: ' + ('clean' if ok else 'BROKEN'))
sys.exit(0 if ok else 1)
