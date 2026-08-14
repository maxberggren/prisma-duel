#!/usr/bin/env python3
"""Splice region bodies into a copy of index.html.
usage: apply.py <base.html> <out.html> NAME=regionfile [NAME=regionfile ...]"""
import sys, re, pathlib
base, out = sys.argv[1], sys.argv[2]
s = pathlib.Path(base).read_text()
for arg in sys.argv[3:]:
    name, path = arg.split('=', 1)
    body = pathlib.Path(path).read_text().rstrip('\n')
    pat = re.compile(r'(#REGION ' + re.escape(name) + r'(?:\*/|-->)?\n).*?(\n[^\n]*#ENDREGION ' + re.escape(name) + r')', re.S)
    if not pat.search(s):
        sys.exit('region not found: ' + name)
    s = pat.sub(lambda m: m.group(1) + body + m.group(2), s, count=1)
pathlib.Path(out).write_text(s)
print('wrote', out)
