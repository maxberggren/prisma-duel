#!/usr/bin/env node
/* Check the layout at real phone viewports.
 *
 * Headless Chromium refuses a window narrower than 500px, so --window-size
 * cannot reproduce an iPhone at all -- which is exactly how an orders panel
 * that does not fit a 390px screen got shipped. This drives the DevTools
 * protocol instead and sets the device metrics directly, so 390x844 means
 * 390x844.
 *
 * usage: node tools/mobilecheck.js [file.html]
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const PORT = 9333;

const DEVICES = [
  { name: 'iPhone 13',      w: 390, h: 844, dpr: 3 },
  { name: 'iPhone SE',      w: 375, h: 667, dpr: 2 },
  { name: 'Pixel 7',        w: 412, h: 915, dpr: 2.6 },
  { name: 'iPhone landscape', w: 844, h: 390, dpr: 3 },
  { name: 'iPad mini',      w: 744, h: 1133, dpr: 2 },
  { name: 'laptop',         w: 1440, h: 900, dpr: 2 },
  { name: 'desktop',        w: 1920, h: 1080, dpr: 1 },
];

/* Runs in the page. Returns everything we want to assert about the layout. */
const PROBE = `(() => {
  /* Force the longest labels the game can show, so the check is about the
     worst case rather than whatever this match happens to be doing. */
  const fl = document.getElementById('fireLbl'), cl = document.getElementById('commitLbl');
  if (fl) fl.textContent = 'ARM LASER';
  if (cl) cl.textContent = 'ORDERS SENT';
  const b = id => { const e = document.getElementById(id); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top),
             r: Math.round(r.right), b: Math.round(r.bottom),
             w: Math.round(r.width), h: Math.round(r.height) }; };
  const fits = x => !!x && x.l >= -0.5 && x.t >= -0.5 &&
                    x.r <= innerWidth + 0.5 && x.b <= innerHeight + 0.5;
  const orders = b('orders'), roster = b('roster');
  const oc = document.getElementById('oCommit'), of = document.getElementById('oFire');
  const lines = el => el ? Math.round(el.getBoundingClientRect().height) : 0;
  return {
    viewport: innerWidth + 'x' + innerHeight,
    ordersFits: fits(orders), rosterFits: fits(roster),
    orders, roster,
    buttonsSideBySide: !!(oc && of) &&
      Math.abs(oc.getBoundingClientRect().top - of.getBoundingClientRect().top) < 2,
    commitH: lines(oc), armH: lines(of),
    commitOverflow: oc ? oc.scrollWidth - oc.clientWidth : -1,
    armOverflow: of ? of.scrollWidth - of.clientWidth : -1,
    /* Spare width inside each button with its longest label: the margin the
       layout has before text starts crushing again. */
    slack: (() => {
      if (!oc || !of) return null;
      const span = el => { const t = el.querySelector('span'); return t ? t.getBoundingClientRect().width : 0; };
      return [Math.round(of.clientWidth - span(of) - 16), Math.round(oc.clientWidth - span(oc) - 16)];
    })(),
    canvasFreePx: orders && roster ? Math.round(orders.t - roster.b) : null,
    docScrolls: document.documentElement.scrollHeight > innerHeight + 1,
  };
})()`;

function cdp(ws, id, method, params) {
  return new Promise((res, rej) => {
    const onMsg = raw => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', onMsg);
      m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function targets() {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const chrome = spawn('chromium', [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--window-size=900,900',
    '--disable-extensions', '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60 && !list; i++) {
    await sleep(250);
    try { list = await targets(); } catch (_) {}
  }
  /* Pick the tab, not whatever else is attachable. The first target can be an
     extension background page, and navigating that to file:// is refused --
     which surfaced as "the page never loaded" rather than as a wrong target. */
  const tab = (list || []).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!tab) { chrome.kill(); console.error('no page target to attach to'); process.exit(1); }

  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));

  let id = 1, ok = true;
  for (const d of DEVICES) {
    await cdp(ws, id++, 'Emulation.setDeviceMetricsOverride',
      { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true });
    await cdp(ws, id++, 'Page.enable');
    await cdp(ws, id++, 'Runtime.enable');
    await cdp(ws, id++, 'Page.navigate', { url: 'file://' + FILE + '?solo=1' });
    /* Wait for the page to actually be there. Without this the probe ran
       against about:blank, which has no viewport meta -- so it reported a
       980px "phone" and every element missing, and looked like a layout bug. */
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(250);
      const q = await cdp(ws, id++, 'Runtime.evaluate', {
        expression: "document.readyState === 'complete' && !!document.getElementById('oCommit')",
        returnByValue: true });
      ready = q.result.value === true;
    }
    if (!ready) { console.log('  FAIL ' + d.name + ' never loaded'); ok = false; continue; }
    await sleep(900);            // let the match start and lay out
    const r = await cdp(ws, id++, 'Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const v = r.result.value || {};
    const problems = [];
    if (!v.ordersFits) problems.push('orders panel does not fit: ' + JSON.stringify(v.orders) +
                                     ' in ' + v.viewport);
    if (!v.rosterFits) problems.push('roster does not fit: ' + JSON.stringify(v.roster));
    /* Stacking is the designed fallback when a panel is too narrow for two
       labels, so it is reported, not failed. What matters is that neither
       label overflows or wraps. */
    if (v.commitOverflow > 0 || v.armOverflow > 0) problems.push('a button label overflows');
    if (v.commitH > 60 || v.armH > 60) problems.push('a button label is wrapping (h=' +
                                                     v.commitH + '/' + v.armH + ')');
    if (v.docScrolls) problems.push('the document scrolls');
    ok = ok && !problems.length;
    console.log((problems.length ? '  FAIL ' : '  ok   ') +
      d.name.padEnd(18) + v.viewport.padEnd(10) +
      'panel ' + (v.orders ? v.orders.h + 'px' : '?').padEnd(7) +
      'buttons ' + (v.buttonsSideBySide ? 'side by side' : 'stacked').padEnd(13) +
      'spare ' + (v.slack ? v.slack.join('/') + 'px' : '?'));
    for (const p of problems) console.log('         ' + p);
  }

  ws.close(); chrome.kill();
  console.log('\nmobile: ' + (ok ? 'clean' : 'BROKEN'));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
