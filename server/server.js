'use strict';
/*
 * lazer -- matchmaking + WebRTC signalling server
 * =================================================================
 * This server does EXACTLY two things:
 *   1. matchmaking  : puts up to 4 players into a room and hands out peer ids
 *   2. signalling   : relays SDP / ICE blobs between peers, verbatim
 * It never sees a move, a turn, or any game state. Once the WebRTC mesh is up
 * the clients talk directly to each other and this process is dead weight
 * (it is still kept around so late joiners / reconnects can be signalled).
 *
 * It also serves the static client so `node server.js` + open the URL is
 * enough to play.
 *
 * WIRE PROTOCOL (JSON over WebSocket, field `t` is the type tag)
 *
 * client -> server
 *   {t:'JOIN',   room?:'ABCD', name?:'max', resume?:{peerId,token}}
 *   {t:'SIGNAL', to:<peerId>, data:<opaque>}
 *   {t:'PING',   ts:<number>}
 *   {t:'LEAVE'}
 *
 * server -> client
 *   {t:'JOINED',    room, selfId, token, roster:[{peerId,name}], resumed:bool}
 *   {t:'PEER_JOIN', peerId, name, roster:[...]}
 *   {t:'PEER_LEAVE',peerId, roster:[...]}
 *   {t:'SIGNAL',    from:<peerId>, data:<opaque>}
 *   {t:'PONG',      ts}
 *   {t:'ERROR',     code, message}
 *      codes: BAD_JSON BAD_MESSAGE TOO_BIG ROOM_FULL NOT_IN_ROOM
 *             ALREADY_JOINED NO_SUCH_PEER RATE_LIMIT BAD_ROOM
 *
 * peerId
 *   Small positive integer, unique within the room, handed out from a
 *   monotonically increasing per-room counter. Ids are NEVER reused while the
 *   room lives, so "lowest peerId" is a stable, deterministic arbiter election
 *   that does not flip when someone leaves and someone else joins.
 *
 * reconnect grace
 *   If a socket dies the peer is kept as a "zombie" for RESUME_GRACE_MS. During
 *   that window the client can re-JOIN with {resume:{peerId,token}} and get its
 *   old peerId back with no PEER_LEAVE/PEER_JOIN churn -- this is what lets the
 *   P2P mesh survive a signalling outage. After the grace period the peer is
 *   dropped for real and PEER_LEAVE is broadcast.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------- config ---
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '4', 10);
const MAX_MSG_BYTES = 32 * 1024;        // hard cap on one JSON message
const WS_MAX_PAYLOAD = 64 * 1024;       // backstop enforced by ws itself
const HEARTBEAT_MS = 15000;             // ws ping interval
const HEARTBEAT_MISS = 2;               // missed pongs before the socket is reaped
const RESUME_GRACE_MS = parseInt(process.env.RESUME_GRACE_MS || '15000', 10);
const SWEEP_MS = parseInt(process.env.SWEEP_MS || '2500', 10);
const JOINS_PER_SOCKET = 5;             // a socket may (re)join at most this often
const JOIN_WINDOW_MS = 60000;
const JOINS_PER_IP = 30;                // per JOIN_WINDOW_MS
const MSG_BUDGET = 400;                 // messages ...
const MSG_WINDOW_MS = 10000;            // ... per window, per socket
const ROOM_CODE_LEN = 4;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, no O
const MAX_ROOMS = 5000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------- static fs ---
// Serve whatever directory actually holds the game. Default: walk up from this
// file looking for an index.html, so both `out/net/` (test page) and the repo
// root (the real game) work without configuration.
function pickStaticRoot() {
  if (process.env.STATIC_DIR) return path.resolve(process.env.STATIC_DIR);
  const cands = [__dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '../..')];
  for (const c of cands) {
    try { if (fs.statSync(path.join(c, 'index.html')).isFile()) return c; } catch (_) {}
  }
  return __dirname;
}
const STATIC_ROOT = pickStaticRoot();
const SELF_DIR = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(root, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch (_) { return null; }
  if (rel.indexOf('\0') !== -1) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(root, '.' + path.posix.normalize(rel));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null; // traversal
  return abs;
}

function serveFile(res, abs) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res).on('error', () => res.destroy());
  });
}

const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' }); return res.end('method not allowed');
  }
  const url = req.url || '/';
  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers: totalPeers() }));
  }
  if (url === '/rooms.json') { // debug/observability only, no game state
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(roomsSummary()));
  }
  // /__net/<file> always maps to the directory this server lives in, so net.js
  // and the test page are reachable even when STATIC_ROOT is the repo root.
  if (url.startsWith('/__net/')) {
    const abs = safeJoin(SELF_DIR, url.slice('/__net'.length));
    if (!abs) { res.writeHead(400); return res.end('bad path'); }
    return serveFile(res, abs);
  }
  const abs = safeJoin(STATIC_ROOT, url);
  if (!abs) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('bad path'); }
  serveFile(res, abs);
});

// ----------------------------------------------------------------- rooms ---
/** @type {Map<string, {code:string, peers:Map<number,object>, nextId:number, createdAt:number}>} */
const rooms = new Map();
const joinsByIp = new Map(); // ip -> {n, resetAt}

function totalPeers() { let n = 0; for (const r of rooms.values()) n += r.peers.size; return n; }
function roomsSummary() {
  const out = [];
  for (const r of rooms.values()) {
    out.push({ room: r.code, peers: [...r.peers.values()].map(p => ({ peerId: p.peerId, name: p.name, live: !p.zombieAt })) });
  }
  return out;
}

function newRoomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let c = '';
    const bytes = crypto.randomBytes(ROOM_CODE_LEN);
    for (let i = 0; i < ROOM_CODE_LEN; i++) c += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function getRoom(code, create) {
  let r = rooms.get(code);
  if (!r && create) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { code, peers: new Map(), nextId: 1, createdAt: Date.now() };
    rooms.set(code, r);
    log('room+', code);
  }
  return r || null;
}

function roomCount(r) { return r.peers.size; }           // zombies still hold a slot
function roster(r) {
  return [...r.peers.values()].sort((a, b) => a.peerId - b.peerId)
    .map(p => ({ peerId: p.peerId, name: p.name }));
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  let s;
  try { s = JSON.stringify(obj); } catch (_) { return false; }
  try { ws.send(s); return true; } catch (_) { return false; }
}
function fail(ws, code, message) { send(ws, { t: 'ERROR', code, message: message || code }); }

function broadcast(r, obj, exceptPeerId) {
  for (const p of r.peers.values()) {
    if (p.peerId === exceptPeerId) continue;
    send(p.ws, obj);
  }
}

function findOpenRoom() {
  // oldest room with space wins -> players clump together instead of scattering
  let best = null;
  for (const r of rooms.values()) {
    if (roomCount(r) >= MAX_PLAYERS) continue;
    if (!best || r.createdAt < best.createdAt) best = r;
  }
  return best;
}

function removePeer(r, peer, why) {
  if (!r.peers.has(peer.peerId)) return;
  r.peers.delete(peer.peerId);
  log('leave', r.code, peer.peerId, peer.name, why || '');
  broadcast(r, { t: 'PEER_LEAVE', peerId: peer.peerId, roster: roster(r) });
  if (r.peers.size === 0) { rooms.delete(r.code); log('room-', r.code); }
}

// ------------------------------------------------------------ websockets ---
const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  const c = {
    ip, peer: null, room: null, joins: 0,
    msgs: 0, msgResetAt: Date.now() + MSG_WINDOW_MS,
    missed: 0, alive: true,
  };
  ws._c = c;

  ws.on('pong', () => { c.missed = 0; c.alive = true; });

  ws.on('message', (raw, isBinary) => {
    // ---- cheap defences first
    if (isBinary) return fail(ws, 'BAD_MESSAGE', 'binary frames are not accepted');
    const len = raw.length !== undefined ? raw.length : Buffer.byteLength(String(raw));
    if (len > MAX_MSG_BYTES) return fail(ws, 'TOO_BIG', 'message too large');
    const now = Date.now();
    if (now > c.msgResetAt) { c.msgs = 0; c.msgResetAt = now + MSG_WINDOW_MS; }
    if (++c.msgs > MSG_BUDGET) { fail(ws, 'RATE_LIMIT', 'too many messages'); return ws.close(4008, 'rate limit'); }

    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch (_) { return fail(ws, 'BAD_JSON', 'not JSON'); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') {
      return fail(ws, 'BAD_MESSAGE', 'expected {t:string,...}');
    }

    try {
      switch (m.t) {
        case 'JOIN':   return onJoin(ws, c, m);
        case 'SIGNAL': return onSignal(ws, c, m);
        case 'PING':   return void send(ws, { t: 'PONG', ts: typeof m.ts === 'number' ? m.ts : 0 });
        case 'LEAVE':  { if (c.room && c.peer) removePeer(c.room, c.peer, 'left'); c.room = null; c.peer = null; return; }
        default:       return fail(ws, 'BAD_MESSAGE', 'unknown type ' + m.t.slice(0, 24));
      }
    } catch (err) {
      // never let a malformed payload take the process down
      log('handler error', err && err.stack || err);
      fail(ws, 'BAD_MESSAGE', 'could not handle message');
    }
  });

  ws.on('error', () => { try { ws.terminate(); } catch (_) {} });

  ws.on('close', () => {
    const peer = c.peer, r = c.room;
    c.peer = null; c.room = null;
    if (!peer || !r) return;
    if (!r.peers.has(peer.peerId) || r.peers.get(peer.peerId) !== peer) return;
    // don't evict immediately: give the client a chance to resume so the P2P
    // mesh isn't torn down over a blip in the signalling socket
    peer.ws = null;
    peer.zombieAt = Date.now();
    log('zombie', r.code, peer.peerId, peer.name);
  });
});

function sanitizeName(n, fallbackId) {
  if (typeof n !== 'string') return 'P' + fallbackId;
  let s = '';
  for (let i = 0; i < n.length && s.length < 24; i++) { const cc = n.charCodeAt(i); if (cc >= 32 && cc !== 127) s += n[i]; }
  s = s.trim();
  return s || ('P' + fallbackId);
}

function onJoin(ws, c, m) {
  if (c.peer) return fail(ws, 'ALREADY_JOINED', 'this socket is already in a room');
  if (++c.joins > JOINS_PER_SOCKET) { fail(ws, 'RATE_LIMIT', 'too many joins'); return ws.close(4008, 'rate limit'); }

  const now = Date.now();
  let ipRec = joinsByIp.get(c.ip);
  if (!ipRec || now > ipRec.resetAt) { ipRec = { n: 0, resetAt: now + JOIN_WINDOW_MS }; joinsByIp.set(c.ip, ipRec); }
  if (++ipRec.n > JOINS_PER_IP) return fail(ws, 'RATE_LIMIT', 'too many joins from this address');

  let code = null;
  if (m.room != null) {
    if (typeof m.room !== 'string' || !/^[A-Za-z0-9]{2,8}$/.test(m.room)) {
      return fail(ws, 'BAD_ROOM', 'room must be 2-8 alphanumerics');
    }
    code = m.room.toUpperCase();
  }

  // ---- resume path: same peerId, no roster churn
  if (m.resume && typeof m.resume === 'object' && code) {
    const r = rooms.get(code);
    const pid = m.resume.peerId, tok = m.resume.token;
    const p = r && Number.isInteger(pid) ? r.peers.get(pid) : null;
    if (p && typeof tok === 'string' && tok.length === p.token.length &&
        crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(p.token))) {
      if (p.ws && p.ws !== ws) { try { p.ws.close(4009, 'superseded'); } catch (_) {} }
      p.ws = ws; p.zombieAt = 0;
      if (typeof m.name === 'string') p.name = sanitizeName(m.name, p.peerId);
      c.peer = p; c.room = r;
      log('resume', r.code, p.peerId, p.name);
      return void send(ws, { t: 'JOINED', room: r.code, selfId: p.peerId, token: p.token, roster: roster(r), resumed: true });
    }
    // resume failed -> fall through and join normally with a fresh id
  }

  let r;
  if (code) {
    r = getRoom(code, true);
    if (!r) return fail(ws, 'ROOM_FULL', 'server is at capacity');
    if (roomCount(r) >= MAX_PLAYERS) return fail(ws, 'ROOM_FULL', 'room ' + code + ' is full');
  } else {
    r = findOpenRoom();
    if (!r) {
      const nc = newRoomCode();
      if (!nc) return fail(ws, 'ROOM_FULL', 'server is at capacity');
      r = getRoom(nc, true);
      if (!r) return fail(ws, 'ROOM_FULL', 'server is at capacity');
    }
  }

  const peerId = r.nextId++;
  const peer = {
    peerId, name: sanitizeName(m.name, peerId), ws,
    token: crypto.randomBytes(12).toString('hex'), zombieAt: 0, joinedAt: Date.now(),
  };
  r.peers.set(peerId, peer);
  c.peer = peer; c.room = r;
  log('join', r.code, peerId, peer.name, '(' + r.peers.size + '/' + MAX_PLAYERS + ')');

  send(ws, { t: 'JOINED', room: r.code, selfId: peerId, token: peer.token, roster: roster(r), resumed: false });
  broadcast(r, { t: 'PEER_JOIN', peerId, name: peer.name, roster: roster(r) }, peerId);
}

function onSignal(ws, c, m) {
  if (!c.peer || !c.room) return fail(ws, 'NOT_IN_ROOM', 'JOIN first');
  if (!Number.isInteger(m.to)) return fail(ws, 'BAD_MESSAGE', 'SIGNAL needs integer `to`');
  if (m.to === c.peer.peerId) return fail(ws, 'BAD_MESSAGE', 'cannot signal yourself');
  if (m.data === undefined) return fail(ws, 'BAD_MESSAGE', 'SIGNAL needs `data`');
  const dst = c.room.peers.get(m.to);
  if (!dst || !dst.ws) return fail(ws, 'NO_SUCH_PEER', 'peer ' + m.to + ' is not reachable');
  // verbatim relay, only `from` is added. The server does not read `data`.
  send(dst.ws, { t: 'SIGNAL', from: c.peer.peerId, data: m.data });
}

// ------------------------------------------------------------- heartbeat ---
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    const c = ws._c; if (!c) continue;
    if (++c.missed > HEARTBEAT_MISS) { log('reap dead socket', c.ip); try { ws.terminate(); } catch (_) {} continue; }
    try { ws.ping(); } catch (_) { try { ws.terminate(); } catch (_) {} }
  }
}, HEARTBEAT_MS);
hb.unref && hb.unref();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    for (const p of [...r.peers.values()]) {
      if (p.zombieAt && now - p.zombieAt > RESUME_GRACE_MS) removePeer(r, p, 'grace expired');
    }
    if (r.peers.size === 0) { rooms.delete(r.code); log('room-', r.code); }
  }
  for (const [ip, rec] of joinsByIp) if (now > rec.resetAt) joinsByIp.delete(ip);
}, SWEEP_MS);
sweeper.unref && sweeper.unref();

process.on('uncaughtException', (e) => log('uncaughtException', e && e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack || e));

httpServer.listen(PORT, HOST, () => {
  const a = httpServer.address();
  log('lazer signalling server on http://localhost:' + a.port + '/');
  log('serving static files from', STATIC_ROOT);
  log('module files also at    http://localhost:' + a.port + '/__net/net.js');
});

module.exports = { httpServer, wss, rooms, PORT };
