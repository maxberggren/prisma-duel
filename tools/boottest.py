#!/usr/bin/env python3
"""Fail if the shipped page does not boot cleanly.

This exists because index.html is assembled from several sources and edited by
several hands: twice during development a declaration was moved or deleted and
the page died on load with a ReferenceError, which no other test noticed.

usage: boottest.py [file.html]
"""
import subprocess, sys, re

src = sys.argv[1] if len(sys.argv) > 1 else '/home/max/Code/lazer/index.html'
r = subprocess.run(
    ['chromium', '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
     '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars',
     '--window-size=900,520', '--virtual-time-budget=4500', '--dump-dom',
     'file://' + src + '?solo=1'],
    capture_output=True, text=True, timeout=180)

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
]
ok = True
for name, passed in checks:
    print(('  ok   ' if passed else '  FAIL ') + name)
    ok = ok and passed
for f in fails[:5]:
    print('       ' + f)
print('\nboot: ' + ('clean' if ok else 'BROKEN'))
sys.exit(0 if ok else 1)
