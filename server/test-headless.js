'use strict';
/*
 * test-headless.js -- REAL end-to-end test.
 *
 * Starts the signalling server, launches 4 independent headless Chromium
 * processes, each loading net.js from that server, and drives them over the
 * Chrome DevTools Protocol. Everything below the driver is genuine: real
 * WebSocket signalling, real RTCPeerConnections, a real 6-link full mesh, real
 * DataChannel traffic between four separate browser processes.
 *
 *   node test-headless.js            # add VERBOSE=1 for browser console output
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');

const PORT = parseInt(process.env.TEST_PORT || '8792', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const WSURL = 'ws://127.0.0.1:' + PORT;
const PAGE = BASE + '/__net/test-page.html';
const N = 4;
const GRACE = 3000;
const VERBOSE = !!process.env.VERBOSE;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ')');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));

function chromiumBin() {
  for (const c of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try { return execSync('command -v ' + c, { encoding: 'utf8' }).trim(); } catch (_) {}
  }
  return null;
}

// ------------------------------------------------------- minimal CDP client
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.waiting = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', d => {
        let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
        if (m.id && this.waiting.has(m.id)) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); w(m); }
        else if (VERBOSE && m.method === 'Runtime.consoleAPICalled') {
          console.log('    [browser]', (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' '));
        }
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
  close() { try { this.ws.close(); } catch (_) {} }
}

// ------------------------------------------------------------ browser peer
async function launchBrowser(i, opts) {
  opts = opts || {};
  const port = 9410 + i;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazer-net-' + i + '-'));
  const bin = chromiumBin();
  const proc = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--remote-allow-origins=*',
    '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    // let peers see each other's real loopback/LAN addresses instead of mDNS
    // .local candidates (there is no mDNS responder in this environment)
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ...(opts.args || []),
    PAGE + (opts.query || ''),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stdout.on('data', d => logs.push(d.toString()));
  proc.stderr.on('data', d => logs.push(d.toString()));

  // wait for the page target
  let target = null;
  for (let t = 0; t < 200 && !target; t++) {
    try {
      const list = JSON.parse((await get('http://127.0.0.1:' + port + '/json/list')).body);
      target = list.find(x => x.type === 'page' && x.url.indexOf('test-page.html') >= 0);
    } catch (_) {}
    if (!target) await sleep(100);
  }
  if (!target) { console.log(logs.join('')); throw new Error('browser ' + i + ' never produced a page target'); }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  const b = {
    i, proc, cdp, dir, logs,
    async ev(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error('browser ' + i + ' eval failed: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) + '\n  expr: ' + expression);
      }
      return r.result.value;
    },
    async until(expr, ms, what) {
      const t0 = Date.now();
      for (;;) {
        if (await b.ev(expr)) return true;
        if (Date.now() - t0 > ms) throw new Error('browser ' + i + ' timeout waiting for ' + (what || expr));
        await sleep(120);
      }
    },
    kill() { try { proc.kill('SIGKILL'); } catch (_) {} cdp.close(); },
  };
  // wait for net.js to have evaluated; on failure do not leave a headless
  // chromium squatting on the debug port for the next run to attach to
  try { await b.until('typeof window.H === "object" && typeof window.Net === "object"', 10000, 'harness'); }
  catch (e) { b.kill(); throw e; }
  return b;
}

// ------------------------------------------------------------------ driver
(async function main() {
  const bin = chromiumBin();
  if (!bin) { console.log('no chromium binary found -- skipping the browser test'); process.exit(0); }
  console.log('using ' + bin);

  let srv = null;
  const startServer = () => {
    const s = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: String(PORT), RESUME_GRACE_MS: String(GRACE), SWEEP_MS: '250' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    s.stdout.on('data', d => { if (VERBOSE) process.stdout.write('    [srv] ' + d); });
    s.stderr.on('data', d => process.stdout.write('    [srv-err] ' + d));
    return s;
  };
  const waitServer = async () => { for (let i = 0; i < 200; i++) { try { await get(BASE + '/healthz'); return; } catch (_) { await sleep(50); } } throw new Error('server did not start'); };

  srv = startServer();
  await waitServer();

  const B = [];
  const cleanup = () => {
    B.forEach(b => { try { b.kill(); } catch (_) {} });
    try { srv.kill('SIGKILL'); } catch (_) {}
  };
  process.on('uncaughtException', e => { console.error(e); cleanup(); process.exit(1); });

  try {
    console.log('\n[launch 4 headless browsers]');
    for (let i = 0; i < N; i++) B.push(await launchBrowser(i));
    ok(B.length === N, N + ' browser processes up with net.js loaded');

    console.log('\n[connect + roster]');
    const joins = [];
    for (let i = 0; i < N; i++) {
      joins.push(await B[i].ev(`H.connect(${JSON.stringify(WSURL)}, "MESH", "p${i + 1}")`));
      await sleep(120);   // deterministic id order for the assertions below
    }
    eq(joins.map(j => j.selfId), [1, 2, 3, 4], 'connect() resolves with ascending peerIds');
    ok(joins[0].roster.length === 1 && joins[3].roster.length === 4, 'connect() resolves with the roster at join time');
    for (let i = 0; i < N; i++) await B[i].until('Net.peers().length === 3', 8000, 'roster of 4');
    ok(true, 'every client sees all 4 players in the roster');
    eq(await B[2].ev('[typeof Net.room, Net.room]'), ['string', 'MESH'], 'Net.room is a plain string property (index.html interpolates it)');
    eq(await B[2].ev('Net.peers().map(p=>p.name)'), ['p1', 'p2', 'p4'], 'peers() carries names, sorted by peerId, excluding self');

    console.log('\n[full mesh over real WebRTC]');
    for (let i = 0; i < N; i++) await B[i].until('H.meshReady()', 30000, 'mesh');
    ok(true, 'all 6 peer connections are up (every client has 3 open data channels)');
    const st0 = await B[0].ev('Net.stats()');
    ok(st0.peers.every(p => p.state === 'connected'), 'client 1 reports every link connected');

    console.log('\n[rtt]');
    await sleep(2500);
    for (let i = 0; i < N; i++) {
      const ps = await B[i].ev('Net.peers()');
      ok(ps.every(p => typeof p.rtt === 'number' && p.rtt >= 0 && p.rtt < 2000),
        'client ' + (i + 1) + ' measured RTT to all peers: ' + ps.map(p => p.peerId + '=' + p.rtt + 'ms').join(' '));
    }

    console.log('\n[arbiter election]');
    eq(await B[0].ev('[Net.selfId(), Net.isArbiter(), Net.arbiterId()]'), [1, true, 1], 'lowest peerId is the arbiter');
    for (let i = 1; i < N; i++) eq(await B[i].ev('[Net.isArbiter(), Net.arbiterId()]'), [false, 1], 'client ' + (i + 1) + ' agrees the arbiter is peer 1');

    console.log('\n[lockstep turn 0: moves fan out peer-to-peer]');
    await Promise.all(B.map((b, i) => b.ev(`Net.sendMove(0, {thrust:${i}, tag:"t0p${i + 1}"})`)));
    for (let i = 0; i < N; i++) await B[i].until('H.events("move").filter(e=>e.a.turn===0).length === 3', 5000, '3 moves for turn 0');
    ok(true, 'each client received a move from each of the other 3 over the data channels');
    const mv1 = await B[1].ev('H.events("move").filter(e=>e.a.turn===0).map(e=>[e.a.peerId, e.a.move.tag])');
    eq(mv1.sort(), [[1, 't0p1'], [3, 't0p3'], [4, 't0p4']], 'moves arrive tagged with the right peerId and payload');

    console.log('\n[arbiter resolve is authoritative for everyone, including itself]');
    await B[0].ev('Net.sendResolve(0, {1:{tag:"t0p1"},2:{tag:"t0p2"},3:{tag:"t0p3"},4:{tag:"HELD"}})');
    for (let i = 0; i < N; i++) await B[i].until('H.events("resolve").filter(e=>e.a.turn===0).length === 1', 5000, 'resolve 0');
    const rs = [];
    for (let i = 0; i < N; i++) rs.push(await B[i].ev('H.events("resolve").find(e=>e.a.turn===0).a.moves'));
    ok(JSON.stringify(rs[0]) === JSON.stringify(rs[1]) && JSON.stringify(rs[1]) === JSON.stringify(rs[2]) && JSON.stringify(rs[2]) === JSON.stringify(rs[3]),
      'all 4 clients hold a byte-identical authoritative move set');
    eq(rs[3][4], { tag: 'HELD' }, 'the arbiter\'s "hold last course" fill-in reached the player it was filled in for');
    ok((await B[0].ev('H.events("resolve").filter(e=>e.a.turn===0).length')) === 1, 'the arbiter emitted resolve locally exactly once (same code path as everyone)');

    console.log('\n[replay / duplicate / out-of-order guards]');
    await B[1].ev('H.clear()');
    // duplicate move for the current turn
    await B[1].ev('Net._inject(3, {t:"m", turn:1, move:{tag:"first"}}); Net._inject(3, {t:"m", turn:1, move:{tag:"replay"}})');
    await sleep(150);
    const dup = await B[1].ev('H.events("move").filter(e=>e.a.turn===1 && e.a.peerId===3).map(e=>e.a.move.tag)');
    eq(dup, ['first'], 'a duplicate move for the same turn+peer is dropped (first value wins)');
    // replay of an already resolved turn
    await B[1].ev('Net._inject(3, {t:"m", turn:0, move:{tag:"stale"}})');
    await sleep(150);
    eq(await B[1].ev('H.events("move").filter(e=>e.a.turn===0).length'), 0, 'a move for an already-resolved turn is dropped');
    // future turn -> buffered, not delivered
    await B[1].ev('Net._inject(4, {t:"m", turn:3, move:{tag:"early"}})');
    await sleep(150);
    eq(await B[1].ev('[H.events("move").filter(e=>e.a.turn===3).length, Net.stats().bufferedMoveTurns]'), [0, 1], 'a move for a future turn is buffered, not delivered');
    // future resolve -> buffered too
    await B[1].ev('Net._inject(1, {t:"r", turn:3, moves:{1:{},2:{},3:{},4:{}}})');
    await sleep(150);
    eq(await B[1].ev('[H.events("resolve").filter(e=>e.a.turn===3).length, Net.stats().bufferedResolveTurns]'), [0, 1], 'a resolve for a future turn is buffered, not applied out of order');
    // now walk the turns forward and watch the buffers drain in order
    await B[1].ev('Net._inject(1, {t:"r", turn:1, moves:{1:{},2:{},3:{},4:{}}})');
    await B[1].ev('Net._inject(1, {t:"r", turn:2, moves:{1:{},2:{},3:{},4:{}}})');
    await sleep(200);
    eq(await B[1].ev('H.events("resolve").map(e=>e.a.turn)'), [1, 2, 3], 'buffered resolves are applied in turn order once the client catches up');
    eq(await B[1].ev('H.events("move").filter(e=>e.a.turn===3).map(e=>e.a.move.tag)'), ['early'], 'the buffered future move is delivered when its turn arrives');
    eq(await B[1].ev('Net.stats().lastResolved'), 3, 'lastResolved tracks the authoritative turn');
    // a second arbiter racing with a resolve for the same turn is ignored
    await B[1].ev('Net._inject(4, {t:"r", turn:3, moves:{1:{tag:"OTHER"}}})');
    await sleep(150);
    eq(await B[1].ev('H.events("resolve").filter(e=>e.a.turn===3).length'), 1, 'a second resolve for the same turn is ignored (first one wins)');

    console.log('\n[chat]');
    await B[2].ev('H.clear()');
    await B[0].ev('Net.sendChat("pew pew")');
    await B[2].until('H.events("chat").length === 1', 4000, 'chat');
    eq(await B[2].ev('H.events("chat")[0].a'), { peerId: 1, text: 'pew pew' }, 'chat is delivered peer-to-peer with the sender id');

    console.log('\n[arbiter leaves mid-game: handover without deadlock]');
    for (let i = 1; i < N; i++) await B[i].ev('H.clear()');
    B[0].kill();
    for (let i = 1; i < N; i++) await B[i].until('Net.peers().length === 2', GRACE + 12000, 'roster shrink');
    ok(true, 'the surviving clients saw PEER_LEAVE for the arbiter');
    for (let i = 1; i < N; i++) eq(await B[i].ev('Net.arbiterId()'), 2, 'client ' + (i + 1) + ' elected peer 2 as the new arbiter');
    eq(await B[1].ev('Net.isArbiter()'), true, 'peer 2 knows it is now the arbiter');
    // and the game keeps running: a fresh turn resolves under the new arbiter
    const T = 10;
    await Promise.all([B[1], B[2], B[3]].map(b => b.ev(`Net.sendMove(${T}, {tag:"post-handover"})`)));
    for (const b of [B[1], B[2], B[3]]) await b.until(`H.events("move").filter(e=>e.a.turn===${T}).length === 2`, 6000, 'moves after handover');
    await B[1].ev(`Net.sendResolve(${T}, {2:{tag:"post-handover"},3:{tag:"post-handover"},4:{tag:"post-handover"}})`);
    for (const b of [B[1], B[2], B[3]]) await b.until(`H.events("resolve").some(e=>e.a.turn===${T})`, 6000, 'resolve after handover');
    ok(true, 'a turn resolves normally under the new arbiter -- no deadlock');

    console.log('\n[signalling server dies: the mesh keeps playing]');
    for (const b of [B[1], B[2], B[3]]) await b.ev('H.clear()');
    srv.kill('SIGKILL');
    await sleep(800);
    for (const b of [B[1], B[2], B[3]]) ok(!(await b.ev('Net.stats().signalling')), 'client ' + b.i + ' noticed signalling is down');
    const T2 = 11;
    await Promise.all([B[1], B[2], B[3]].map(b => b.ev(`Net.sendMove(${T2}, {tag:"offline"})`)));
    for (const b of [B[2], B[3]]) await b.until(`H.events("move").filter(e=>e.a.turn===${T2}).length === 2`, 6000, 'p2p moves while the server is down');
    ok(true, 'moves still flow peer-to-peer with NO server running at all');
    await B[1].ev(`Net.sendResolve(${T2}, {2:{},3:{},4:{}})`);
    for (const b of [B[1], B[2], B[3]]) await b.until(`H.events("resolve").some(e=>e.a.turn===${T2})`, 6000, 'resolve while offline');
    ok(true, 'turns resolve with no server running');

    console.log('\n[signalling comes back: clients rejoin in the background]');
    srv = startServer();
    await waitServer();
    for (const b of [B[1], B[2], B[3]]) await b.until('Net.stats().signalling === true', 45000, 'signalling restored');
    ok(true, 'all clients re-established signalling on their own (background retry)');
    for (const b of [B[1], B[2], B[3]]) await b.until('H.meshReady()', 45000, 'mesh re-formed');
    ok(true, 'the mesh is fully connected again after the outage');

    console.log('\n[worst case: the arbiter crashes WHILE signalling is down]');
    {
      // No server means no PEER_LEAVE can ever arrive, so the survivors have to
      // notice the dead link themselves and re-elect on a timer. If this hangs,
      // the game deadlocks: nobody would ever declare a turn resolved.
      srv.kill('SIGKILL');
      await sleep(800);
      const live = [B[1], B[2], B[3]];
      const ids = [];
      for (const b of live) ids.push(await b.ev('Net.selfId()'));
      const arb = await live[0].ev('Net.arbiterId()');
      const victim = live[ids.indexOf(arb)];
      const rest = live.filter(b => b !== victim);
      victim.kill();
      const expected = Math.min(...ids.filter(x => x !== arb));
      for (const b of rest) await b.until(`Net.arbiterId() === ${expected}`, 40000, 're-election after arbiter crash');
      ok(true, 'survivors re-elected peer ' + expected + ' with no server and no PEER_LEAVE (was ' + arb + ')');
      const T3 = 20;
      await Promise.all(rest.map(b => b.ev(`Net.sendMove(${T3}, {tag:"orphaned"})`)));
      for (const b of rest) {
        if (await b.ev('Net.isArbiter()')) await b.ev(`Net.sendResolve(${T3}, {${expected}:{tag:"orphaned"}})`);
      }
      for (const b of rest) await b.until(`H.events("resolve").some(e=>e.a.turn===${T3})`, 8000, 'resolve after orphaned re-election');
      ok(true, 'the new arbiter declared the next turn -- no deadlock');
    }

    console.log('\n[no direct path at all: the server relay carries the match]');
    {
      // Two fresh clients that can never form a DataChannel: one has UDP for
      // WebRTC switched off (what a corporate firewall / symmetric NAT looks
      // like), the other has no RTCPeerConnection at all. Both must still be
      // reachable at once through the RELAY path and play a full turn.
      srv = startServer();
      await waitServer();
      const R = [
        await launchBrowser(4, { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }),
        await launchBrowser(5, { query: '?nortc=1' }),
      ];
      B.push(...R);
      ok(await R[1].ev('typeof RTCPeerConnection === "undefined"'), 'client 6 really has no WebRTC');
      await R[0].ev(`H.connect(${JSON.stringify(WSURL)}, "RELAY", "r1")`);
      await R[1].ev(`H.connect(${JSON.stringify(WSURL)}, "RELAY", "r2")`);
      for (const b of R) await b.until('Net.peers().length === 1 && Net.peers()[0].connected', 10000, 'relay reachability');
      eq(await R[0].ev('Net.peers()[0].via'), 'relay', 'client 5 reaches its peer via the server relay');
      eq(await R[1].ev('Net.peers()[0].via'), 'relay', 'client 6 reaches its peer via the server relay');
      ok((await R[1].ev('Net.stats().peers[0].state')) !== 'connected', 'no direct link exists on the WebRTC-less client');
      await R[0].until('Net.peers()[0].rtt !== null', 8000, 'relay rtt');
      ok(true, 'RTT is measured over the relay too');
      await Promise.all(R.map((b, i) => b.ev(`Net.sendMove(0, {tag:"relay-p${i + 1}"})`)));
      for (const b of R) await b.until('H.events("move").filter(e=>e.a.turn===0).length === 1', 6000, 'relayed move');
      eq(await R[1].ev('H.events("move").find(e=>e.a.turn===0).a.move.tag'), 'relay-p1', 'move arrived through the server, byte-identical');
      eq(await R[0].ev('[Net.isArbiter(), Net.arbiterId()]'), [true, 1], 'arbiter is elected over relay-only links');
      await R[0].ev('Net.sendResolve(0, {1:{tag:"relay-p1"},2:{tag:"relay-p2"}})');
      for (const b of R) await b.until('H.events("resolve").some(e=>e.a.turn===0)', 6000, 'relayed resolve');
      ok(true, 'a full lockstep turn resolved with zero peer-to-peer connectivity');
      // and a peer that vanishes is noticed through the relay path as well
      R[1].kill();
      await R[0].until('Net.peers().length === 0 || !Net.peers()[0].connected', 20000, 'relay peer loss');
      ok(true, 'losing a relay-only peer is detected');
    }
  } catch (err) {
    fail++;
    console.log('  FAIL exception: ' + (err && err.stack || err));
    for (const b of B) { if (b.logs && b.logs.length) console.log('--- browser ' + b.i + ' log ---\n' + b.logs.join('').slice(-2000)); }
  }

  console.log('\n=== headless e2e: ' + pass + ' passed, ' + fail + ' failed ===');
  cleanup();
  await sleep(200);
  process.exit(fail ? 1 : 0);
})();
