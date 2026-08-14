#!/usr/bin/env node
/* Assembles the shipped single-file index.html from the sources in src/, so the
   page and the modules that the tests run against never drift apart.
   Usage: node build.js [--check] */
const fs = require('fs');

const PARTS = [
  { file: 'src/core.js',  begin: '/*#CORE-BEGIN*/',      end: '/*#CORE-END*/',      strip: true },
  { file: 'src/hud.css',  begin: '/*#HUDCSS-BEGIN*/',    end: '/*#HUDCSS-END*/' },
  { file: 'src/hud.html', begin: '<!--#HUDHTML-BEGIN-->', end: '<!--#HUDHTML-END-->' },
  { file: 'src/net.js',   begin: '/*#NET-BEGIN*/',       end: '/*#NET-END*/' },
  { file: 'src/game.js',  begin: '/*#GAME-BEGIN*/',      end: '/*#GAME-END*/',      strip: true },
];

let html = fs.readFileSync('index.html', 'utf8');
const before = html;

for (const part of PARTS) {
  if (!fs.existsSync(part.file)) { console.error('missing ' + part.file); process.exit(1); }
  let body = fs.readFileSync(part.file, 'utf8');
  if (part.strip) {
    body = body.split("if (typeof module !== 'undefined'")[0].trimEnd();
    // these helpers already exist in the host page
    for (const dup of ['const TAU = Math.PI * 2;\n',
                       'const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);\n',
                       'const lerp = (a, b, t) => a + (b - a) * t;\n']) body = body.replace(dup, '');
  }
  const i = html.indexOf(part.begin), j = html.indexOf(part.end);
  if (i < 0 || j < 0) { console.error('markers not found for ' + part.file); process.exit(1); }
  html = html.slice(0, i + part.begin.length) + '\n' + body.trimEnd() + '\n' + html.slice(j);
}

if (process.argv.includes('--check')) {
  console.log(html === before ? 'index.html is in sync with src/' : 'OUT OF SYNC - run: node build.js');
  process.exit(html === before ? 0 : 1);
}
fs.writeFileSync('index.html', html);
console.log('built index.html from ' + PARTS.length + ' sources (' + html.split('\n').length + ' lines)');
