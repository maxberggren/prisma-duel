#!/usr/bin/env python3
"""Print a region's current body.  usage: extract.py <file.html> NAME"""
import sys, re, pathlib
s = pathlib.Path(sys.argv[1]).read_text()
m = re.search(r'#REGION ' + re.escape(sys.argv[2]) + r'(?:\*/|-->)?\n(.*?)\n[^\n]*#ENDREGION', s, re.S)
print(m.group(1) if m else 'NOT FOUND')
