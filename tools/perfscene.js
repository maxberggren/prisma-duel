#!/usr/bin/env node
/* Measure what the start scene costs.
 *
 * Launches Chrome headless WITH the real GPU (ANGLE over desktop GL -- plain
 * headless falls back to SwiftShader and would measure the CPU rasteriser),
 * loads the page with ?perf=1, lets the attract screen run, and prints the
 * page's own per-frame accounting: rAF interval, CPU in sim and in issuing
 * the render, GPU time per frame (EXT_disjoint_timer_query), and the scene
 * budget (segments, hot spots, particles, rays).
 *
 *   node tools/perfscene.js                       # local index.html, 1400x800, 20 s
 *   node tools/perfscene.js --secs 30 --size 1920x1080 --dpr 2
 *   node tools/perfscene.js --url http://127.0.0.1:8090/ --q 'rays=256'
 *
 * --q appends extra query params (see the ?perf knobs in index.html), so
 * variants can be A/B'd without editing the source.
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const SECS = parseInt(arg('secs', '20'), 10);
const [SW, SH] = arg('size', '1400x800').split('x').map(Number);
const DPR = arg('dpr', '1');
const Q = arg('q', '');
const URL0 = arg('url', 'file://' + path.resolve(__dirname, '..', 'index.html'));
const URL = URL0 + (URL0.includes('?') ? '&' : '?') + 'perf=1' + (Q ? '&' + Q : '');
const PORT = 9470 + Math.floor(Math.random() * 20);
const bin = ['google-chrome-stable', 'chromium', 'google-chrome', 'chromium-browser']
  .map(b => { try { return require('child_process').execSync('which ' + b, { stdio: 'pipe' }).toString().trim(); } catch (_) { return null; } })
  .find(Boolean);
if (!bin) { console.error('no chrome/chromium found'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej));

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.waiting = new Map(); this.logs = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
      this.ws.on('open', res); this.ws.on('error', rej);
      this.ws.on('message', d => {
        let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
        if (m.id && this.waiting.has(m.id)) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); w(m); }
        else if (m.method === 'Runtime.consoleAPICalled') this.logs.push((m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' '));
      });
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazer-perf-'));
  const proc = spawn(bin, [
    '--headless=new', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--window-size=' + SW + ',' + SH, '--force-device-scale-factor=' + DPR,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--allow-file-access-from-files',
    URL,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => { try { proc.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };
  process.on('exit', kill);

  let target = null;
  for (let t = 0; t < 100 && !target; t++) {
    try { target = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list')).find(x => x.type === 'page' && x.url.includes('perf=1')); } catch (_) {}
    if (!target) await sleep(100);
  }
  if (!target) { console.error('no page target'); kill(); process.exit(1); }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  for (let t = 0; t < 100; t++) { if (await cdp.ev('typeof window.__perf === "object" && !!window.ATT && ATT.on').catch(() => false)) break; await sleep(100); }

  const gpu = await cdp.ev('(() => { const d = gl.getExtension("WEBGL_debug_renderer_info"); return (d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) + (__perf.ext ? "" : "  [no GPU timer]"); })()');
  console.log('renderer : ' + gpu);
  console.log('page     : ' + URL);
  console.log('window   : ' + SW + 'x' + SH + ' @' + DPR + 'x, ' + SECS + ' s');
  // discard the first report (casting, shader warm-up), then collect
  await cdp.ev('__perf.reports.length = 0; __perf.frames = []; __perf.gpu = []; __perf.t0 = performance.now(); 1');
  await sleep(SECS * 1000);
  const reps = await cdp.ev('JSON.stringify(__perf.reports)');
  const R = JSON.parse(reps).slice(1);       // first window is warm-up
  if (!R.length) { console.error('no reports (page too slow to reach the first window?)'); console.error(cdp.logs.slice(-10).join('\n')); kill(); process.exit(1); }
  const mean = k => R.reduce((s, r) => s + k(r), 0) / R.length;
  const max = k => Math.max(...R.map(k));
  const f = n => (Math.round(n * 100) / 100).toFixed(2);
  console.log('');
  console.log('fps          ' + f(mean(r => r.fps)) + '   (drawn ' + R.reduce((s, r) => s + r.drawn, 0) + '/' + R.reduce((s, r) => s + r.frames, 0) + ' frames)');
  console.log('frame ms     mean ' + f(mean(r => r.frameMs.mean)) + '  p95 ' + f(mean(r => r.frameMs.p95)) + '  max ' + f(max(r => r.frameMs.max)) + '   long>20ms ' + R.reduce((s, r) => s + r.long20, 0) + '  >34ms ' + R.reduce((s, r) => s + r.long34, 0));
  console.log('cpu ms       sim ' + f(mean(r => r.cpuMs.game)) + ' (p95 ' + f(mean(r => r.cpuMs.gameP95)) + ')   render-issue ' + f(mean(r => r.cpuMs.render)) + ' (p95 ' + f(mean(r => r.cpuMs.renderP95)) + ')');
  if (R[0].gpuMs) console.log('gpu ms       mean ' + f(mean(r => r.gpuMs.mean)) + '  p95 ' + f(mean(r => r.gpuMs.p95)) + '  max ' + f(max(r => r.gpuMs.max)));
  if (R[0].passMs) {
    const names = Object.keys(R[R.length - 1].passMs);
    console.log('gpu/pass ms  ' + names.map(n => n + ' ' + f(mean(r => (r.passMs && r.passMs[n]) || 0))).join('  '));
  }
  const s = R[R.length - 1].scene;
  console.log('scene        ' + s.W + 'x' + s.H + ' @' + s.DPR + 'x  rays ' + s.rays + '  segs ' + s.segs + '  hot ' + s.hot + '  vfx ' + s.vfx + '  tier ' + s.tier + (s.everyN > 1 ? ' (every ' + s.everyN + ' frames)' : ''));
  console.log('tier/window  ' + R.map(r => r.scene.tier).join(' '));
  console.log('');
  console.log('per-window   ' + R.map(r => r.fps + 'fps/' + (r.gpuMs ? r.gpuMs.mean + 'ms' : '-')).join('  '));
  cdp.close(); kill();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
