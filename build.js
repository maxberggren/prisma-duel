#!/usr/bin/env node
/* Assembles the shipped single-file index.html from the sources in src/, so the
   page and the modules that the tests run against never drift apart.
   Usage: node build.js [--check] */
const fs = require('fs');
const path = require('path');

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

/* The GPU draws prisms from a fixed-size uniform array while the CPU tracer
   walks the whole list, so a shader that is one slot short leaves an invisible
   disc that still refracts the laser and still kills anything that touches it.
   That shipped once. It does not get to ship twice. */
{
  const cap = /uniform vec4\s+uPrism\[(\d+)\]/.exec(html);
  const made = /const n = (\d+);\s*\/\/?.*|const n = (\d+);/.exec(
    fs.readFileSync('src/core.js', 'utf8').split('makeArena')[1] || '');
  const need = made ? parseInt(made[1] || made[2], 10) : null;
  if (!cap) { console.error('cannot find the uPrism uniform array'); process.exit(1); }
  if (need === null) { console.error('cannot find the prism count in makeArena'); process.exit(1); }
  if (parseInt(cap[1], 10) < need) {
    console.error('SHADER TOO SMALL: makeArena builds ' + need + ' prisms but uPrism[] holds '
                  + cap[1] + '. Widen uPrism/uPrism2, MAX_PRISM_DRAW and the GLSL loops.');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ pages ---
   The site's other URLs -- the manual as a page, the Critical Mass article,
   the ray-tracer write-up -- are documents, and a crawler has to be able to
   read them without running the game. Each is written as a body in pages/src/
   with a JSON header, and wrapped here in the one head, breadcrumb and footer
   they all share, so five pages cannot drift into five slightly different
   sites. They wear the game's own stylesheet (src/hud.css) plus pages/site.css,
   which turns the in-game manual's card into a page that scrolls. */
const ORIGIN = 'https://prismaduel.com';
const PAGE_DIR = 'pages', PAGE_SRC = 'pages/src';
const NAV = [
  { slug: 'how-it-works',             label: 'How it works' },
  { slug: 'critical-mass',            label: 'Critical Mass' },
  { slug: 'games-like-critical-mass', label: 'Games like it' },
  { slug: 'spectral-ray-tracing',     label: 'The ray tracer' },
  { slug: 'multiplayer',              label: 'Multiplayer' },
];
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function wrapPage(slug, meta, body) {
  const url = ORIGIN + '/' + slug;
  const title = meta.title + ' — Prisma Duel';
  const ld = Object.assign({
    '@context': 'https://schema.org',
    '@type': meta.type || 'Article',
    headline: meta.title,
    description: meta.description,
    url,
    inLanguage: 'en',
    image: ORIGIN + '/assets/og.png',
    author: { '@type': 'Person', name: 'Max Berggren' },
    publisher: { '@type': 'Organization', name: 'Prisma Duel', url: ORIGIN + '/' },
    isPartOf: { '@type': 'WebSite', name: 'Prisma Duel', url: ORIGIN + '/' },
    about: { '@type': 'VideoGame', name: 'Prisma Duel', url: ORIGIN + '/' },
  }, meta.ld || {});
  const crumbs = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Prisma Duel', item: ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: meta.crumb || meta.title, item: url },
    ],
  };
  const others = NAV.filter(n => n.slug !== slug)
    .map(n => `<a href="/${n.slug}">${esc(n.label)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#05060a">
<meta name="color-scheme" content="dark">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="icon" href="/assets/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Prisma Duel">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${ORIGIN}/assets/og.png">
<script type="application/ld+json">${JSON.stringify(ld, null, 1)}</script>
<script type="application/ld+json">${JSON.stringify(crumbs, null, 1)}</script>
<link rel="stylesheet" href="/src/hud.css">
<link rel="stylesheet" href="/pages/site.css">
</head>
<body>
<nav class="crumbs" aria-label="Breadcrumb">
  <a href="/">Prisma Duel</a><span class="sep">/</span><span>${esc(meta.crumb || meta.title)}</span>
  <a class="play" href="/">Play the game &rarr;</a>
</nav>
<main class="page">
  <article class="modal guide">
    <header class="ghead">
      <h1>${meta.heading || esc(meta.title)}</h1>
      <p class="sub">${esc(meta.sub || '')}</p>
    </header>
    <div class="gbody">
${body.trim()}
    </div>
  </article>
</main>
<footer class="more">${others}<a href="https://github.com/maxberggren/prisma-duel" rel="noopener">Source</a></footer>
${meta.script ? '<script>\n' + meta.script + '\n</script>' : ''}
</body>
</html>
`;
}

const pageOut = {};
if (fs.existsSync(PAGE_SRC)) {
  for (const f of fs.readdirSync(PAGE_SRC).filter(f => f.endsWith('.html')).sort()) {
    const raw = fs.readFileSync(path.join(PAGE_SRC, f), 'utf8');
    const m = /^<!--meta\s*([\s\S]*?)-->/.exec(raw);
    if (!m) { console.error(f + ': missing <!--meta {...}--> header'); process.exit(1); }
    let meta;
    try { meta = JSON.parse(m[1]); } catch (e) { console.error(f + ': bad meta JSON: ' + e.message); process.exit(1); }
    const slug = f.replace(/\.html$/, '');
    let body = raw.slice(m[0].length);
    /* An inline script for the live figures lives beside its page as
       pages/src/<slug>.js, so the write-up's demos are ordinary JS with syntax
       highlighting rather than a string inside a string. */
    const js = path.join(PAGE_SRC, slug + '.js');
    if (fs.existsSync(js)) meta.script = fs.readFileSync(js, 'utf8').trim();
    pageOut[path.join(PAGE_DIR, slug + '.html')] = wrapPage(slug, meta, body);
  }
}

if (process.argv.includes('--check')) {
  let ok = html === before;
  for (const [f, out] of Object.entries(pageOut)) {
    if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== out) { ok = false; console.log('stale: ' + f); }
  }
  console.log(ok ? 'index.html and pages/ are in sync with their sources' : 'OUT OF SYNC - run: node build.js');
  process.exit(ok ? 0 : 1);
}
fs.writeFileSync('index.html', html);
for (const [f, out] of Object.entries(pageOut)) fs.writeFileSync(f, out);
console.log('built index.html from ' + PARTS.length + ' sources (' + html.split('\n').length + ' lines)'
            + (Object.keys(pageOut).length ? ' and ' + Object.keys(pageOut).length + ' pages' : ''));
