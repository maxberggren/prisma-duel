/* =====================================================================
 * lazer/net.js -- peer-to-peer networking for deterministic lockstep
 * =====================================================================
 * Drop-in, dependency-free, no DOM access. Inline this file verbatim into
 * index.html inside a <script> tag. It defines exactly one global: `Net`.
 *
 * ---------------------------------------------------------------------
 * ARCHITECTURE
 * ---------------------------------------------------------------------
 * The backend is used for matchmaking, WebRTC signalling and -- for pairs
 * that cannot reach each other directly -- as a dumb relay. As soon as a
 * direct link is up, gameplay traffic for that pair travels browser-to-browser
 * over a WebRTC DataChannel. There is no authoritative server and no game
 * state anywhere except in the clients; the relay forwards opaque blobs.
 *
 *   - Full mesh: 4 players => 6 RTCPeerConnections, one per pair.
 *   - One DataChannel per pair, ordered + reliable. A dropped move stalls the
 *     turn, so unreliable/unordered would be strictly worse here.
 *   - Glare avoidance: the peer with the LOWER peerId is always the offerer.
 *     The higher one waits and, if nothing arrives, nudges with NEED_OFFER.
 *   - Two transports per peer, picked per message:
 *       direct  the DataChannel, when it is open;
 *       relay   {t:'RELAY'} over the signalling WebSocket otherwise.
 *     Nothing waits for ICE: from the moment JOINED arrives every peer is
 *     reachable through the relay, and the pair upgrades itself to direct the
 *     instant the channel opens (and falls back if it closes). Symmetric NAT,
 *     UDP-blocked networks and browsers without WebRTC all just play a bit
 *     laggier. The server hands out iceServers (STUN + optional TURN) in
 *     JOINED, so a TURN relay is used before the WebSocket one where deployed.
 *   - If the signalling socket dies the direct links keep running; the socket
 *     is retried in the background with backoff and resumes the SAME peerId
 *     (server-issued resume token), so no roster churn is observed by peers.
 *     Relay-only peers are unreachable for the duration and come back with it.
 *
 * ---------------------------------------------------------------------
 * THE LOCKSTEP CONTRACT  (the game depends on every word of this)
 * ---------------------------------------------------------------------
 * Turns are integers t = 0, 1, 2, ... They must be non-negative and are
 * expected to be consecutive.
 *
 * 1. Each turn t every client calls  Net.sendMove(t, move)  exactly once.
 *    `move` must be JSON-serialisable and small (<= ~8 KB). It is broadcast
 *    to every connected peer. Calling sendMove twice for the same turn is
 *    ignored locally and de-duplicated by receivers (first one wins).
 *
 * 2. Receivers emit 'move' -> cb({turn, peerId, move}) for each peer move
 *    belonging to the CURRENT turn, where
 *        currentTurn = max(lastResolvedTurn + 1, highest turn you sendMove'd)
 *      - moves for a turn already behind currentTurn are DROPPED (replay-safe);
 *      - moves for a FUTURE turn are BUFFERED and delivered later, in order,
 *        as soon as the local turn catches up;
 *      - a duplicate (same turn, same peer) is DROPPED. First value wins.
 *    Because sendMove(t) advances currentTurn, a game that resolves turns
 *    locally never stalls waiting for a resolve it will not get.
 *
 * 3. A client may resolve turn t locally once it holds a move from itself and
 *    from every connected peer. This is an optimisation; it is NOT the
 *    authority (see 4). The game decides this -- Net only feeds it moves.
 *    RECOMMENDED: don't. Wait for 'resolve' on every turn and have the arbiter
 *    fire sendResolve as soon as it holds every move (not only on timeout).
 *    That gives one code path, one ordering, and zero divergence risk.
 *
 * 4. THE ARBITER is the lowest peerId in the roster that is still considered
 *    alive (see below). When the arbiter's local turn timer expires it fills
 *    in every missing player's move with the game's "hold last course"
 *    default and calls  Net.sendResolve(t, moves)  where `moves` is an object
 *    keyed by peerId: {"1": moveA, "2": moveB, ...}.
 *
 *    'resolve' -> cb({turn, moves}) is AUTHORITATIVE. Every client, INCLUDING
 *    the arbiter itself, must simulate turn t from exactly that move set --
 *    even a client that had already received all the moves, and even if its
 *    own move is not in the set (the arbiter did not hear it in time; you were
 *    held on your last course; that is the price of not stalling everyone).
 *    Net.sendResolve() therefore also emits 'resolve' locally, so the arbiter
 *    runs the exact same code path as everyone else. Do not simulate directly
 *    from your own sendResolve argument -- wait for the event.
 *
 *    Only the FIRST resolve seen for a turn is honoured; later ones (a second
 *    arbiter during a handover race, or a replay) are dropped. Resolves that
 *    arrive for a future turn are buffered and applied in order, so a client
 *    that fell behind catches up turn by turn rather than skipping. A resolve
 *    for a turn the game already advanced past locally is still delivered,
 *    flagged {late:true} -- if you resolve locally you must be able to accept
 *    or ignore that correction knowingly (see the recommendation in 3).
 *
 * 5. ALIVENESS / ARBITER HANDOVER. A peer counts as alive if the signalling
 *    roster still lists it AND we have not written its P2P link off as failed
 *    (failed = the connection could not be (re)established after retries, or
 *    it has been down for longer than PEER_DEAD_MS). Since the roster comes
 *    from the server, all clients agree on the candidate set, so all clients
 *    elect the same arbiter. When the arbiter leaves or dies, the next-lowest
 *    peer becomes arbiter automatically; 'roster' and 'status' both fire, and
 *    Net.isArbiter() flips. The game must therefore re-check Net.isArbiter()
 *    every turn (cheap) rather than caching it once -- otherwise a handover
 *    mid-turn deadlocks, because nobody would send the resolve.
 *
 *    Caveat worth knowing: if a client is roster-visible to others but has no
 *    working P2P link to us, we mark it failed only for OUR arbiter election.
 *    That is the one situation where two clients can briefly disagree about
 *    who the arbiter is; both may send a resolve for the same turn and the
 *    "first resolve wins" rule can, in principle, diverge. It requires a
 *    half-broken mesh and is reported loudly via 'status'.
 *
 * 6. Turn 0 handshake: the mesh is not necessarily complete when connect()
 *    resolves. Wait for a 'status' event / Net.peers() showing the expected
 *    peers connected, or just start and let the arbiter's timer carry you --
 *    late peers will be filled with the default move.
 *
 * ---------------------------------------------------------------------
 * PUBLIC API
 * ---------------------------------------------------------------------
 *   Net.connect({url, room, name}) -> Promise<{selfId, roster}>
 *   Net.on('roster'|'move'|'resolve'|'status'|'chat', cb) -> off()
 *   Net.sendMove(turn, move)
 *   Net.sendResolve(turn, moves)      // arbiter only
 *   Net.sendChat(text)                // extra, trivial
 *   Net.selfId() -> number|null
 *   Net.isArbiter() -> boolean
 *   Net.peers() -> [{peerId,name,rtt,connected,via}]   // excludes self; via: 'direct'|'relay'|null
 *   Net.disconnect()
 *   Net.room                       // PROPERTY (string|null): the room code
 *   Net.arbiterId() -> number|null // extra: who the arbiter currently is
 *   Net.stats() -> diagnostics blob (extra, for the HUD)
 * ===================================================================== */

var Net = (function () {
  'use strict';

  // ------------------------------------------------------------- tunables
  var CFG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ],
    pingMs: 2000,          // RTT probe interval per peer
    needOfferMs: 3500,     // answerer nudges the offerer if no offer arrived
    connectTimeoutMs: 20000, // per attempt before we call it a failure
    maxIceRestarts: 3,     // ICE restarts before a peer is written off
    peerDeadMs: 12000,     // link down this long => not an arbiter candidate
    relayStaleMs: 7000,    // nothing heard via any path this long => peer presumed unreachable
    directRetryMs: 45000,  // after giving up on ICE, try a direct link again this often
    wsRetryMs: 1000,       // signalling reconnect backoff base
    wsRetryMaxMs: 15000,
    maxBufferedTurns: 64,  // future-turn buffer depth
    seenCap: 4096
  };

  // --------------------------------------------------------------- state
  var ws = null;
  var wsUrl = null, wantRoom = null, myName = null, roomCode = null;
  var resumeToken = null;
  var selfId = null;
  var rosterMap = new Map();          // peerId -> {peerId, name}
  var peers = new Map();              // peerId -> peer record (never includes self)
  var listeners = { roster: [], move: [], resolve: [], status: [], chat: [] };
  var connected = false;              // signalling socket up
  var shuttingDown = false;
  var wsRetry = 0, wsRetryTimer = null;
  var connectResolve = null, connectReject = null, connectSettled = false;
  var lastStatus = '';
  var arbiterCache = null;

  // lockstep bookkeeping
  var lastResolved = -1;              // highest turn for which 'resolve' fired
  var localTurn = 0;                  // highest turn the local game has sent a move for
  var futureMoves = new Map();        // turn -> Map(peerId -> move)
  var futureResolves = new Map();     // turn -> moves
  var deliveredMoves = new Set();     // "turn:peerId" already emitted
  var resolvedTurns = new Set();      // turns already emitted as 'resolve'
  var sentMoveTurns = new Set();      // turns we already broadcast a move for

  // ------------------------------------------------------------- helpers
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function emit(kind, arg) {
    var ls = listeners[kind];
    if (!ls) return;
    for (var i = 0; i < ls.length; i++) {
      try { ls[i](arg); } catch (e) { logErr('listener ' + kind, e); }
    }
  }
  function logErr(where, e) {
    if (typeof console !== 'undefined' && console.warn) console.warn('[net] ' + where, e);
  }
  function status(msg) {
    lastStatus = msg;
    emit('status', msg);
  }
  function capSet(s) {
    if (s.size <= CFG.seenCap) return;
    var drop = s.size - CFG.seenCap, it = s.values();
    for (var i = 0; i < drop; i++) { var v = it.next(); if (v.done) break; s.delete(v.value); }
  }
  function rosterArray() {
    var out = [];
    rosterMap.forEach(function (r) { out.push({ peerId: r.peerId, name: r.name }); });
    out.sort(function (a, b) { return a.peerId - b.peerId; });
    return out;
  }
  function emitRoster() { arbiterCache = null; emit('roster', rosterArray()); }

  // ------------------------------------------------------- peer records
  function peerRec(peerId, name) {
    var p = peers.get(peerId);
    if (p) { if (name) p.name = name; return p; }
    p = {
      peerId: peerId, name: name || ('P' + peerId),
      pc: null, dc: null,
      state: 'new',        // direct link: new | connecting | connected | retrying | failed
      direct: false,       // DataChannel open
      connected: false,    // reachable by SOME transport (direct or relay)
      via: null,           // 'direct' | 'relay' | null
      rtt: null,
      lastSeen: 0,
      downSince: now(),
      iceRestarts: 0,
      pendingIce: [],      // candidates that arrived before the remote description
      haveRemote: false,
      makingOffer: false,
      needOfferTimer: null,
      connectTimer: null,
      directRetryTimer: null,
      outQueue: []         // messages queued while no transport is available
    };
    peers.set(peerId, p);
    return p;
  }

  function isOfferer(peerId) { return selfId !== null && selfId < peerId; }

  function alive(p) {
    // arbiter candidacy: reachable by some path, or only briefly out of touch.
    // A failed DIRECT link is not disqualifying -- the relay may carry them.
    if (!p.connected && p.downSince && (now() - p.downSince) > CFG.peerDeadMs) return false;
    return true;
  }

  // Reachability by any transport: a path exists (open DataChannel, or the
  // signalling socket for the relay) AND the peer has been heard from lately.
  // Pings go out every pingMs to every roster peer over whichever path, and
  // replies come from message handlers (not timers), so a backgrounded tab
  // still answers promptly. Making the direct link obey the same freshness
  // rule catches a channel that looks open but whose owner is gone, well
  // before ICE gets round to saying so.
  function reachable(p) {
    if (!p.direct && !connected) return false;
    return p.lastSeen > 0 && (now() - p.lastSeen) < CFG.relayStaleMs;
  }
  function updateReach(p, quiet) {
    var r = reachable(p);
    var via = p.direct ? 'direct' : (r ? 'relay' : null);
    if (r === p.connected && via === p.via) return;
    p.via = via;
    if (r && !p.connected) p.downSince = 0;
    if (!r && p.connected) p.downSince = now();
    p.connected = r;
    if (!quiet) {
      if (via === 'direct') status('direct link to ' + p.name + ' (peer ' + p.peerId + ')');
      else if (via === 'relay') status('reaching ' + p.name + ' via server relay');
      else status('lost contact with ' + p.name);
    }
    refreshArbiter();
    emitRoster();
  }

  function computeArbiter() {
    if (selfId === null) return null;
    var best = selfId;
    rosterMap.forEach(function (r) {
      if (r.peerId === selfId) return;
      var p = peers.get(r.peerId);
      if (p && !alive(p)) return;
      if (r.peerId < best) best = r.peerId;
    });
    return best;
  }

  var announcedArbiter = null;
  function refreshArbiter() {
    var a = computeArbiter();
    arbiterCache = a;
    if (a !== announcedArbiter) {
      announcedArbiter = a;
      status(a === selfId ? 'you are the arbiter (peer ' + selfId + ')'
                          : 'arbiter is peer ' + a);
    }
    return a;
  }

  // ------------------------------------------------------ signalling I/O
  function wsSend(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }
  function signal(to, data) { wsSend({ t: 'SIGNAL', to: to, data: data }); }

  function openSocket() {
    if (shuttingDown) return;
    var sock;
    try { sock = new WebSocket(wsUrl); } catch (e) { scheduleReconnect(); return; }
    ws = sock;

    sock.onopen = function () {
      if (sock !== ws) return;
      wsRetry = 0;
      var join = { t: 'JOIN', name: myName };
      if (roomCode) join.room = roomCode;         // reconnect: same room
      else if (wantRoom) join.room = wantRoom;
      if (roomCode && selfId !== null && resumeToken) join.resume = { peerId: selfId, token: resumeToken };
      wsSend(join);
    };

    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      try { onServerMessage(m); } catch (e) { logErr('server msg', e); }
    };

    sock.onerror = function () { /* onclose follows */ };

    sock.onclose = function () {
      if (sock !== ws) return;
      ws = null;
      connected = false;
      if (shuttingDown) return;
      if (!connectSettled) {
        // never got as far as JOINED
        status('signalling connection failed');
        scheduleReconnect();
        return;
      }
      status('signalling lost -- direct links still live, retrying in background');
      peers.forEach(function (p) { updateReach(p, true); });
      refreshArbiter(); emitRoster();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (shuttingDown || wsRetryTimer) return;
    var delay = Math.min(CFG.wsRetryMaxMs, CFG.wsRetryMs * Math.pow(2, wsRetry)) * (0.7 + Math.random() * 0.6);
    wsRetry++;
    wsRetryTimer = setTimeout(function () { wsRetryTimer = null; openSocket(); }, delay);
  }

  function onServerMessage(m) {
    switch (m.t) {
      case 'JOINED': {
        connected = true;
        roomCode = m.room;
        resumeToken = m.token || resumeToken;
        var firstTime = (selfId === null);
        if (m.selfId !== selfId && !firstTime) {
          // server could not resume us -> we came back as a new player.
          // Tear the stale mesh down; peers see us as a fresh peerId.
          status('rejoined with a new id (' + selfId + ' -> ' + m.selfId + ')');
          closeAllPeers('id changed');
        }
        selfId = m.selfId;
        rosterMap.clear();
        (m.roster || []).forEach(function (r) { rosterMap.set(r.peerId, { peerId: r.peerId, name: r.name }); });
        emitRoster();
        status(m.resumed ? 'signalling restored (room ' + roomCode + ')'
                         : 'joined room ' + roomCode + ' as peer ' + selfId);
        if (Array.isArray(m.ice) && m.ice.length) CFG.iceServers = m.ice;
        // establish / repair links to everyone in the roster; the relay path is
        // live right now, so say hello and flush anything that queued up
        rosterMap.forEach(function (r) {
          if (r.peerId === selfId) return;
          var p = peerRec(r.peerId, r.name);
          p.iceRestarts = 0;
          ensureLink(r.peerId, r.name);
          greet(p);
        });
        refreshArbiter();
        if (!connectSettled) {
          connectSettled = true;
          var res = connectResolve; connectResolve = connectReject = null;
          if (res) res({ selfId: selfId, roster: rosterArray() });
        }
        break;
      }
      case 'PEER_JOIN': {
        rosterMap.set(m.peerId, { peerId: m.peerId, name: m.name });
        if (m.roster) { rosterMap.clear(); m.roster.forEach(function (r) { rosterMap.set(r.peerId, { peerId: r.peerId, name: r.name }); }); }
        emitRoster();
        status(m.name + ' joined (peer ' + m.peerId + ')');
        if (m.peerId !== selfId) { ensureLink(m.peerId, m.name); greet(peers.get(m.peerId)); }
        refreshArbiter();
        break;
      }
      case 'PEER_LEAVE': {
        rosterMap.delete(m.peerId);
        if (m.roster) { rosterMap.clear(); m.roster.forEach(function (r) { rosterMap.set(r.peerId, { peerId: r.peerId, name: r.name }); }); }
        var p = peers.get(m.peerId);
        var nm = p ? p.name : ('peer ' + m.peerId);
        destroyPeer(m.peerId, 'left');
        emitRoster();
        status(nm + ' left');
        refreshArbiter();
        break;
      }
      case 'SIGNAL':
        if (Number.isInteger(m.from) && m.from !== selfId) onSignalData(m.from, m.data);
        break;
      case 'RELAY':
        if (Number.isInteger(m.from) && m.from !== selfId && rosterMap.has(m.from)) {
          onPeerMessage(peerRec(m.from, (rosterMap.get(m.from) || {}).name), m.data);
        }
        break;
      case 'PONG': break;
      case 'ERROR':
        status('server error: ' + (m.code || '?') + ' ' + (m.message || ''));
        if (!connectSettled && (m.code === 'ROOM_FULL' || m.code === 'BAD_ROOM' || m.code === 'RATE_LIMIT')) {
          connectSettled = true;
          shuttingDown = true;                 // stop retry storms on a hard no
          var rej = connectReject; connectResolve = connectReject = null;
          try { if (ws) ws.close(); } catch (e) {}
          if (rej) rej(new Error(m.code + ': ' + (m.message || '')));
        }
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------ WebRTC
  function ensureLink(peerId, name) {
    var p = peerRec(peerId, name);
    if (p.state === 'connected' || p.state === 'connecting') return p;
    clearTimeout(p.directRetryTimer); p.directRetryTimer = null;
    startLink(p, false);
    return p;
  }

  // Say hello over whatever path is up so the peer learns our name and marks
  // us reachable at once, instead of waiting a ping interval.
  function greet(p) {
    if (!p) return;
    send(p, { t: 'hello', name: myName, id: selfId });
    var q = p.outQueue; p.outQueue = [];
    for (var i = 0; i < q.length; i++) send(p, q[i]);
    pingPeer(p);
  }

  function startLink(p, iceRestart) {
    if (shuttingDown) return;
    if (!p.pc) createPc(p);
    if (!p.pc) return;          // no WebRTC here: the relay is all there is
    p.state = 'connecting';
    if (isOfferer(p.peerId)) {
      makeOffer(p, iceRestart);
    } else {
      // wait for their offer; nudge if it never shows up
      clearTimeout(p.needOfferTimer);
      p.needOfferTimer = setTimeout(function () {
        if (p.state !== 'connected') { signal(p.peerId, { kind: 'need-offer' }); startNeedOfferTimer(p); }
      }, CFG.needOfferMs);
    }
    armConnectTimeout(p);
  }

  function startNeedOfferTimer(p) {
    clearTimeout(p.needOfferTimer);
    p.needOfferTimer = setTimeout(function () {
      if (p.state !== 'connected') { signal(p.peerId, { kind: 'need-offer' }); startNeedOfferTimer(p); }
    }, CFG.needOfferMs);
  }

  function armConnectTimeout(p) {
    clearTimeout(p.connectTimer);
    p.connectTimer = setTimeout(function () {
      if (p.state === 'connected') return;
      handleLinkFailure(p, 'timed out');
    }, CFG.connectTimeoutMs);
  }

  function createPc(p) {
    var pc;
    try { pc = new RTCPeerConnection({ iceServers: CFG.iceServers, iceCandidatePoolSize: 2 }); }
    catch (e) { logErr('RTCPeerConnection', e); p.state = 'failed'; status('WebRTC unavailable in this browser'); return null; }
    p.pc = pc;
    p.haveRemote = false;
    p.pendingIce = [];

    pc.onicecandidate = function (ev) {
      if (ev.candidate) signal(p.peerId, { kind: 'ice', candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
      else signal(p.peerId, { kind: 'ice-end' });
    };
    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (st === 'failed') handleLinkFailure(p, 'ice failed');
      else if (st === 'disconnected') {
        markDown(p);
        status('link to ' + p.name + ' wobbling');
      }
    };
    pc.oniceconnectionstatechange = function () {
      if (pc.iceConnectionState === 'failed') handleLinkFailure(p, 'ice failed');
    };
    pc.ondatachannel = function (ev) { attachChannel(p, ev.channel); };

    if (isOfferer(p.peerId)) {
      try { attachChannel(p, pc.createDataChannel('lazer', { ordered: true })); }
      catch (e) { logErr('createDataChannel', e); }
    }
    return pc;
  }

  function attachChannel(p, dc) {
    if (p.dc && p.dc.readyState === 'open' && p.dc !== dc) { try { dc.close(); } catch (e) {} return; }
    p.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = function () {
      p.state = 'connected'; p.direct = true; p.iceRestarts = 0;
      p.lastSeen = now();   // the channel opening is proof of life
      clearTimeout(p.needOfferTimer); clearTimeout(p.connectTimer);
      clearTimeout(p.directRetryTimer); p.directRetryTimer = null;
      updateReach(p);
      send(p, { t: 'hello', name: myName, id: selfId });
      var q = p.outQueue; p.outQueue = [];
      for (var i = 0; i < q.length; i++) send(p, q[i]);
      pingPeer(p);
    };
    dc.onclose = function () {
      if (p.direct) status('lost direct link to ' + p.name + (connected ? ' -- relaying via server' : ''));
      markDown(p);
      emitRoster();
      // try to bring it back if the peer is still in the roster
      if (!shuttingDown && rosterMap.has(p.peerId) && p.state !== 'failed') {
        p.state = 'retrying';
        setTimeout(function () { if (!shuttingDown && rosterMap.has(p.peerId) && !p.connected) restartLink(p); }, 600);
      }
    };
    dc.onerror = function () { /* onclose follows */ };
    dc.onmessage = function (ev) { onPeerMessage(p, ev.data); };
  }

  function markDown(p) {
    // the DIRECT link went down; whether the peer is still reachable is up to
    // the relay, which updateReach() decides
    p.direct = false;
    p.rtt = null;
    if (!p.downSince && !reachable(p)) p.downSince = now();
    updateReach(p, true);
  }

  function restartLink(p) {
    // Full teardown + a fresh PC is more reliable across browsers than reusing
    // one. Detach the handlers first, otherwise closing the old channel fires
    // our own onclose again and we restart in a loop.
    detach(p);
    p.pc = null; p.dc = null; p.haveRemote = false; p.pendingIce = [];
    startLink(p, false);
  }

  function detach(p) {
    try { if (p.dc) { p.dc.onclose = p.dc.onopen = p.dc.onerror = p.dc.onmessage = null; p.dc.close(); } } catch (e) {}
    try {
      if (p.pc) {
        p.pc.onconnectionstatechange = p.pc.oniceconnectionstatechange = null;
        p.pc.onicecandidate = p.pc.ondatachannel = null;
        p.pc.close();
      }
    } catch (e) {}
  }

  function handleLinkFailure(p, why) {
    if (p.state === 'failed') return;
    markDown(p);
    if (p.iceRestarts < CFG.maxIceRestarts && rosterMap.has(p.peerId) && !shuttingDown) {
      p.iceRestarts++;
      p.state = 'retrying';
      status('retrying link to ' + p.name + ' (' + why + ', attempt ' + p.iceRestarts + ')');
      setTimeout(function () { if (!p.connected && rosterMap.has(p.peerId)) restartLink(p); }, 400 * p.iceRestarts);
    } else {
      p.state = 'failed';
      clearTimeout(p.needOfferTimer); clearTimeout(p.connectTimer);
      status('no direct link to ' + p.name + ' (' + why + ') -- relaying via server');
      refreshArbiter();
      emitRoster();
      // The relay carries the match; keep quietly trying for a direct link in
      // case the network changed (VPN off, moved to wifi, TURN came back...).
      clearTimeout(p.directRetryTimer);
      p.directRetryTimer = setTimeout(function () {
        p.directRetryTimer = null;
        if (shuttingDown || p.direct || !rosterMap.has(p.peerId) || !connected) return;
        p.iceRestarts = 0;
        restartLink(p);
      }, CFG.directRetryMs);
    }
  }

  function makeOffer(p, iceRestart) {
    var pc = p.pc; if (!pc) return;
    if (p.makingOffer) return;
    p.makingOffer = true;
    var opts = iceRestart ? { iceRestart: true } : undefined;
    pc.createOffer(opts).then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      signal(p.peerId, { kind: 'sdp', sdp: pc.localDescription });
    }).catch(function (e) {
      logErr('makeOffer', e);
    }).then(function () { p.makingOffer = false; });
  }

  function onSignalData(from, data) {
    if (!data || typeof data !== 'object') return;
    var p = peerRec(from, (rosterMap.get(from) || {}).name);
    if (data.kind === 'need-offer') {
      if (isOfferer(from)) {
        if (!p.pc) createPc(p);
        if (p.pc && p.state !== 'connected') { p.state = 'connecting'; makeOffer(p, false); armConnectTimeout(p); }
      }
      return;
    }
    if (data.kind === 'ice-end') return;
    if (data.kind === 'ice') {
      if (!data.candidate) return;
      if (!p.pc || !p.haveRemote) { p.pendingIce.push(data.candidate); if (p.pendingIce.length > 256) p.pendingIce.shift(); return; }
      try { p.pc.addIceCandidate(data.candidate).catch(function () {}); } catch (e) {}
      return;
    }
    if (data.kind !== 'sdp' || !data.sdp || !data.sdp.type) return;

    var desc = data.sdp;
    if (desc.type === 'offer') {
      // Glare rule: the peer with the lower peerId owns the offer. If an offer
      // arrives from a HIGHER peerId (we are the offerer for that pair) we drop
      // it -- ours wins, no rollback dance, no glare.
      if (isOfferer(from)) return;
      if (!p.pc) createPc(p);
      var pc = p.pc; if (!pc) return;      // no WebRTC here; the relay carries this pair
      if (p.state !== 'connected') p.state = 'connecting';
      pc.setRemoteDescription(desc).then(function () {
        p.haveRemote = true;
        flushIce(p);
        return pc.createAnswer();
      }).then(function (ans) {
        return pc.setLocalDescription(ans);
      }).then(function () {
        signal(from, { kind: 'sdp', sdp: pc.localDescription });
        armConnectTimeout(p);
      }).catch(function (e) { logErr('answer', e); });
    } else if (desc.type === 'answer') {
      var pc2 = p.pc; if (!pc2) return;
      if (pc2.signalingState !== 'have-local-offer') return; // stale answer
      pc2.setRemoteDescription(desc).then(function () {
        p.haveRemote = true; flushIce(p);
      }).catch(function (e) { logErr('setRemote answer', e); });
    }
  }

  function flushIce(p) {
    var q = p.pendingIce; p.pendingIce = [];
    for (var i = 0; i < q.length; i++) {
      try { p.pc.addIceCandidate(q[i]).catch(function () {}); } catch (e) {}
    }
  }

  function destroyPeer(peerId, why) {
    var p = peers.get(peerId);
    if (!p) return;
    clearTimeout(p.needOfferTimer); clearTimeout(p.connectTimer); clearTimeout(p.directRetryTimer);
    detach(p);
    peers.delete(peerId);
    arbiterCache = null;
  }

  function closeAllPeers(why) {
    var ids = [];
    peers.forEach(function (p, id) { ids.push(id); });
    for (var i = 0; i < ids.length; i++) destroyPeer(ids[i], why);
  }

  // -------------------------------------------------------- peer messages
  // One send() per peer, transport chosen per message: the DataChannel when it
  // is open, else the server relay when the socket is up, else queue (moves and
  // resolves only -- pings/chat are not worth replaying).
  function send(p, obj) {
    if (p.dc && p.dc.readyState === 'open') {
      try { p.dc.send(JSON.stringify(obj)); return true; }
      catch (e) { logErr('dc.send', e); }
    }
    if (connected && rosterMap.has(p.peerId) && wsSend({ t: 'RELAY', to: p.peerId, data: obj })) return true;
    if (obj.t === 'm' || obj.t === 'r') { p.outQueue.push(obj); if (p.outQueue.length > 64) p.outQueue.shift(); }
    return false;
  }
  var dcSend = send;   // old name, kept for the test harness

  function broadcast(obj) {
    peers.forEach(function (p) { send(p, obj); });
  }

  function onPeerMessage(p, raw) {
    var m;
    if (raw && typeof raw === 'object' && !(raw instanceof ArrayBuffer)) m = raw;   // relayed: already parsed
    else { try { m = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; } }
    if (!m || typeof m.t !== 'string') return;
    p.lastSeen = now();
    if (!p.connected) updateReach(p);
    switch (m.t) {
      case 'hello':
        if (typeof m.name === 'string' && m.name) { p.name = m.name.slice(0, 24); emitRoster(); }
        break;
      case 'p': send(p, { t: 'q', ts: m.ts }); break;
      case 'q': {
        if (typeof m.ts === 'number') {
          var sample = now() - m.ts;
          p.rtt = (p.rtt == null) ? Math.round(sample) : Math.round(p.rtt * 0.7 + sample * 0.3);
        }
        break;
      }
      case 'm': acceptMove(p.peerId, m.turn, m.move); break;
      case 'r': acceptResolve(m.turn, m.moves); break;
      case 'c':
        if (typeof m.text === 'string') emit('chat', { peerId: p.peerId, text: m.text.slice(0, 500) });
        break;
      default: break;
    }
  }

  // ------------------------------------------------- lockstep bookkeeping
  //
  // currentTurn() is the turn the local game is working on. It advances by two
  // independent routes, and we take whichever is further ahead:
  //   * an authoritative 'resolve' for turn t  => the game moves to t+1
  //   * the game calling sendMove(t)           => the game is on t
  // The second route exists so a game that resolves a turn locally (because it
  // already holds every peer's move, per contract point 3) does not deadlock:
  // without it, peer moves for the next turn would be buffered forever waiting
  // for a resolve that the arbiter never needed to send.
  function currentTurn() { var t = lastResolved + 1; return localTurn > t ? localTurn : t; }

  function bufferMove(turn, peerId, move) {
    var slot = futureMoves.get(turn);
    if (!slot) {
      if (futureMoves.size >= CFG.maxBufferedTurns) {
        var oldest = Math.min.apply(null, Array.from(futureMoves.keys()));
        futureMoves.delete(oldest);
      }
      slot = new Map(); futureMoves.set(turn, slot);
    }
    if (!slot.has(peerId)) slot.set(peerId, move);   // first value wins
  }

  function acceptMove(peerId, turn, move) {
    if (!Number.isInteger(turn) || turn < 0) return;
    var key = turn + ':' + peerId;
    if (deliveredMoves.has(key)) return;                    // duplicate / replay
    if (turn < currentTurn()) return;                       // turn is history
    if (turn > currentTurn()) { bufferMove(turn, peerId, move); return; }
    deliveredMoves.add(key); capSet(deliveredMoves);
    emit('move', { turn: turn, peerId: peerId, move: move });
  }

  function acceptResolve(turn, moves) {
    if (!Number.isInteger(turn) || turn < 0) return;
    if (resolvedTurns.has(turn)) return;                    // first resolve for a turn wins
    if (!moves || typeof moves !== 'object') return;
    if (turn > currentTurn()) {                             // we are behind: buffer, apply in order
      if (!futureResolves.has(turn)) {
        if (futureResolves.size >= CFG.maxBufferedTurns) {
          var oldest = Math.min.apply(null, Array.from(futureResolves.keys()));
          futureResolves.delete(oldest);
        }
        futureResolves.set(turn, moves);
      }
      return;
    }
    // turn <= currentTurn(): deliver now. Note it may be BELOW currentTurn if
    // the game resolved that turn locally and moved on -- the arbiter is still
    // authoritative, so it is delivered with late:true rather than dropped.
    fireResolve(turn, moves, turn < currentTurn());
    drain();
  }

  function fireResolve(turn, moves, late) {
    resolvedTurns.add(turn); capSet(resolvedTurns);
    if (turn > lastResolved) lastResolved = turn;
    futureMoves.forEach(function (v, k) { if (k < currentTurn()) futureMoves.delete(k); });
    emit('resolve', { turn: turn, moves: moves, late: !!late });
  }

  // Deliver buffered material for the (new) current turn, then chain on any
  // buffered resolve for that turn, repeating while we keep catching up.
  function drain() {
    for (var guard = 0; guard < 512; guard++) {
      var t = currentTurn();
      var slot = futureMoves.get(t);
      if (slot) {
        futureMoves.delete(t);
        slot.forEach(function (mv, pid) {
          var key = t + ':' + pid;
          if (deliveredMoves.has(key)) return;
          deliveredMoves.add(key);
          emit('move', { turn: t, peerId: pid, move: mv });
        });
        capSet(deliveredMoves);
      }
      var r = futureResolves.get(t);
      if (r === undefined) return;
      futureResolves.delete(t);
      if (resolvedTurns.has(t)) continue;
      fireResolve(t, r, false);
      if (currentTurn() === t) return;   // paranoia: never spin
    }
  }

  // ---------------------------------------------------------- RTT pings
  var pingTimer = setInterval(function () {
    // ping everyone in the roster over whichever path exists: on the relay this
    // is also the liveness probe (see reachable()), so it must not wait for a
    // direct link
    peers.forEach(function (p) { if (rosterMap.has(p.peerId)) pingPeer(p); updateReach(p); });
    // aliveness is time-based (peerDeadMs), so the arbiter must be re-elected
    // on a clock, not only on events: if the signalling socket is down AND the
    // arbiter's browser dies, no PEER_LEAVE can ever arrive and this tick is
    // the only thing that hands the crown to the next-lowest peer.
    if (selfId !== null) refreshArbiter();
  }, CFG.pingMs);
  if (pingTimer && pingTimer.unref) pingTimer.unref();

  function pingPeer(p) { send(p, { t: 'p', ts: now() }); }

  // ------------------------------------------------------------- public
  var api = {
    connect: function (opts) {
      opts = opts || {};
      if (shuttingDown) shuttingDown = false;
      if (ws || connectResolve) return Promise.reject(new Error('already connecting/connected'));
      wsUrl = opts.url || defaultUrl();
      wantRoom = opts.room ? String(opts.room).toUpperCase() : null;
      myName = (typeof opts.name === 'string' && opts.name.trim()) ? opts.name.trim().slice(0, 24) : 'player';
      roomCode = null; resumeToken = null; selfId = null;
      connectSettled = false;
      lastResolved = -1; localTurn = 0;
      futureMoves.clear(); futureResolves.clear();
      deliveredMoves.clear(); resolvedTurns.clear(); sentMoveTurns.clear();
      rosterMap.clear(); arbiterCache = null; announcedArbiter = null;
      status('connecting to ' + wsUrl);
      return new Promise(function (res, rej) {
        connectResolve = res; connectReject = rej;
        openSocket();
        setTimeout(function () {
          if (!connectSettled) {
            connectSettled = true;
            var r = connectReject; connectResolve = connectReject = null;
            shuttingDown = true;
            try { if (ws) ws.close(); } catch (e) {}
            if (r) r(new Error('timed out joining ' + wsUrl));
          }
        }, 15000);
      });
    },

    on: function (kind, cb) {
      if (!listeners[kind] || typeof cb !== 'function') return function () {};
      listeners[kind].push(cb);
      return function off() {
        var i = listeners[kind].indexOf(cb);
        if (i >= 0) listeners[kind].splice(i, 1);
      };
    },

    sendMove: function (turn, move) {
      if (!Number.isInteger(turn) || turn < 0) { logErr('sendMove', 'bad turn ' + turn); return false; }
      if (sentMoveTurns.has(turn)) return false;           // one move per turn
      sentMoveTurns.add(turn); capSet(sentMoveTurns);
      // sending a move for turn t means the local game is on turn t
      if (turn > localTurn) { localTurn = turn; drain(); }
      broadcast({ t: 'm', turn: turn, move: move });
      return true;
    },

    sendResolve: function (turn, moves) {
      if (!Number.isInteger(turn) || turn < 0) { logErr('sendResolve', 'bad turn ' + turn); return false; }
      if (!moves || typeof moves !== 'object') { logErr('sendResolve', 'moves must be an object'); return false; }
      broadcast({ t: 'r', turn: turn, moves: moves });
      // the arbiter runs the identical authoritative path as everyone else
      acceptResolve(turn, moves);
      return true;
    },

    sendChat: function (text) {
      if (typeof text !== 'string' || !text) return false;
      var t = text.slice(0, 500);
      broadcast({ t: 'c', text: t });
      if (selfId !== null) emit('chat', { peerId: selfId, text: t });
      return true;
    },

    selfId: function () { return selfId; },

    isArbiter: function () {
      if (selfId === null) return false;
      if (arbiterCache === null) arbiterCache = computeArbiter();
      return arbiterCache === selfId;
    },

    arbiterId: function () {
      if (selfId === null) return null;
      if (arbiterCache === null) arbiterCache = computeArbiter();
      return arbiterCache;
    },

    peers: function () {
      var out = [];
      rosterMap.forEach(function (r) {
        if (r.peerId === selfId) return;
        var p = peers.get(r.peerId);
        out.push({
          peerId: r.peerId,
          name: (p && p.name) || r.name,
          rtt: p ? p.rtt : null,
          connected: !!(p && p.connected),
          via: p ? p.via : null
        });
      });
      out.sort(function (a, b) { return a.peerId - b.peerId; });
      return out;
    },

    disconnect: function () {
      shuttingDown = true;
      clearTimeout(wsRetryTimer); wsRetryTimer = null;
      try { if (ws) { wsSend({ t: 'LEAVE' }); ws.close(); } } catch (e) {}
      ws = null; connected = false;
      closeAllPeers('disconnect');
      rosterMap.clear();
      selfId = null; roomCode = null; resumeToken = null; arbiterCache = null; announcedArbiter = null;
      status('disconnected');
    },

    // ---- extras (diagnostics; the game may ignore all of this)
    stats: function () {
      return {
        selfId: selfId, room: roomCode, signalling: connected,
        arbiter: api.arbiterId(), lastResolved: lastResolved,
        bufferedMoveTurns: futureMoves.size, bufferedResolveTurns: futureResolves.size,
        status: lastStatus,
        peers: Array.from(peers.values()).map(function (p) {
          return { peerId: p.peerId, name: p.name, state: p.state, connected: p.connected, via: p.via, rtt: p.rtt };
        })
      };
    },
    config: CFG,
    _version: '1.1.0',
    // TEST ONLY: feed a raw wire message in as if it had arrived from `peerId`.
    // Used by test-headless.js to exercise replay/dedupe/out-of-order paths
    // that are hard to provoke over a healthy network. Harmless in production.
    _inject: function (peerId, obj) {
      var p = peers.get(peerId) || peerRec(peerId);
      onPeerMessage(p, JSON.stringify(obj));
    }
  };

  // Net.room is a plain string PROPERTY (not a call): the room code, or null
  // before you are in a room. index.html interpolates it straight into the HUD.
  Object.defineProperty(api, 'room', { get: function () { return roomCode; }, enumerable: true });

  function defaultUrl() {
    try {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      return proto + location.host;
    } catch (e) { return 'ws://localhost:8080'; }
  }

  if (typeof window !== 'undefined') window.Net = api;
  return api;
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Net;
