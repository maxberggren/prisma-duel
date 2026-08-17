# lazer netcode — matchmaking + peer-to-peer lockstep

Two files matter:

| file | what it is |
|---|---|
| `server.js` | Node + `ws`. Matchmaking, WebRTC signalling relay, opaque gameplay relay for pairs with no direct path, static file server. **No game state, ever** — relayed blobs are forwarded, never parsed. |
| `net.js` | Browser module, dependency-free plain JS, no DOM access. Inline it verbatim into `index.html`. Defines one global: `Net`. |

Everything else here is tests (`test-signalling.js`, `test-headless.js`, `test-page.html`).

## Run it

```sh
cd out/net
npm install          # ws, nothing else
node server.js       # -> http://localhost:8080/
```

The server serves the game (it walks up from `out/net/` looking for an
`index.html`, so by default it serves the repo root) and its own files under
`/__net/`. `PORT` and `STATIC_DIR` are read from the environment.

## Architecture, in one paragraph

The backend does matchmaking, relays SDP/ICE blobs, and relays gameplay blobs
(`RELAY`) for pairs whose direct link is not up. Every pair has two transports,
chosen per message: the WebRTC DataChannel when open, else the WebSocket relay.
The relay is usable from the moment `JOINED` arrives, so nothing waits for ICE;
a pair upgrades to direct the instant its channel opens and falls back if it
closes. 4 players means 6 `RTCPeerConnection`s, one per pair, each with one
**ordered, reliable** DataChannel (a lost move stalls the turn, so reliability
beats latency here). Kill the server mid-match and directly-linked pairs keep
playing; the clients retry signalling in the background and rejoin when it
comes back. `JOINED` also carries `ice`, the iceServers list (STUN + optional
TURN with per-seat HMAC credentials — `TURN_URLS`/`TURN_SECRET` env).

## Server protocol (JSON over WebSocket)

```
client -> server   {t:'JOIN', room?, name?, resume?:{peerId,token}}
                   {t:'SIGNAL', to, data}          {t:'RELAY', to, data}
                   {t:'PING', ts}                  {t:'LEAVE'}
server -> client   {t:'JOINED', room, selfId, token, roster, resumed, ice}
                   {t:'RELAY', from, data}
                   {t:'PEER_JOIN', peerId, name, roster}
                   {t:'PEER_LEAVE', peerId, roster}
                   {t:'SIGNAL', from, data}        {t:'PONG', ts}
                   {t:'ERROR', code, message}
```

* Rooms hold **4**. `JOIN` with a room code creates or joins it; without one you
  are matchmade into the oldest room with space, else a new 4-letter room
  (`ABCDEFGHJKLMNPQRSTUVWXYZ` — no `I`, no `O`).
* `peerId` is a small integer from a **monotonic per-room counter**. Ids are
  never reused while the room lives, so "lowest peerId" is a stable arbiter
  election that does not flip when a player leaves and another joins.
* `SIGNAL` payloads are relayed **verbatim**; the server only adds `from`.
* A dead socket keeps its peerId for `RESUME_GRACE_MS` (15 s). Reconnecting with
  `resume:{peerId,token}` restores it with no `PEER_LEAVE`/`PEER_JOIN` churn, so
  a signalling blip never disturbs the mesh. After the grace period the peer is
  dropped for real and `PEER_LEAVE` is broadcast.
* Defences: 32 KB message cap, 400 msg/10 s per socket, 5 joins per socket and
  30 per IP per minute, strict shape validation, ws ping/pong reaping of dead
  sockets, empty-room cleanup, static path-traversal blocking. Malformed input
  gets an `ERROR` reply, never a crash.

## Client API

```js
await Net.connect({ url, room, name })  // -> {selfId, roster:[{peerId,name}]}
Net.on('roster',  r  => …)              // [{peerId,name}] on every membership change
Net.on('move',    ({turn, peerId, move}) => …)
Net.on('resolve', ({turn, moves, late}) => …)   // AUTHORITATIVE
Net.on('status',  s  => …)              // human-readable string for the HUD
Net.on('chat',    ({peerId, text}) => …)
Net.sendMove(turn, move)
Net.sendResolve(turn, moves)            // arbiter only; moves is {peerId: move}
Net.sendChat(text)
Net.selfId()      // number | null
Net.isArbiter()   // lowest connected peerId === selfId
Net.peers()       // [{peerId, name, rtt, connected, via}] — excludes self; via: 'direct'|'relay'|null
Net.disconnect()
Net.room          // PROPERTY, not a call: the room code string
Net.arbiterId()   // extra
Net.stats()       // extra: diagnostics blob for the HUD
```

`Net.on` returns an unsubscribe function.

## The lockstep contract

The full, precise version is the comment block at the top of `net.js` — that is
the normative copy. The short version:

1. Every client calls `Net.sendMove(t, move)` once per turn.
2. Peers' moves arrive as `move` events for the current turn. Duplicates and
   moves for finished turns are dropped; moves for future turns are buffered and
   released in order.
3. The **arbiter is the lowest live peerId**. When its turn timer expires it
   fills missing players with "hold last course" and calls `sendResolve`.
4. `resolve` is authoritative for **everyone, including the arbiter** —
   `sendResolve` also emits the event locally, so there is exactly one
   simulation path. First resolve per turn wins; later ones are ignored.
5. Arbiter handover is automatic. **Re-check `Net.isArbiter()` every turn** —
   caching it across a handover is how you deadlock.

## What is tested, and how

`npm test` runs both suites.

### `test-signalling.js` — 60 assertions, no browser

Real WebSocket clients against a real server process: room creation and
upper-casing, peerId assignment, roster contents and ordering, `PEER_JOIN` /
`PEER_LEAVE`, verbatim signal relay and its error cases, matchmaking into the
open room, `ROOM_FULL` on the 5th player, per-room ids, every malformed-input
path (bad JSON, arrays, missing/unknown type, oversized payload, bad room code,
control chars in names), disconnect grace, resume with a good and a forged
token, id non-reuse, identical rosters across clients after the arbiter leaves,
join rate limiting, room cleanup, static serving and path traversal.

### `test-headless.js` — 54 assertions, six real Chromium processes

Genuinely end-to-end: it starts the server, launches 4 independent headless
Chromium instances loading `net.js` over HTTP, and drives them via CDP. Real
signalling, real `RTCPeerConnection`s, a real 6-link mesh, real DataChannel
traffic between four OS processes. Covered:

* mesh formation, `Net.peers()` shape, measured RTT per peer;
* arbiter election agreed by all four clients;
* a full lockstep turn — 4 moves fan out P2P, arbiter resolves, all four clients
  end up with a byte-identical authoritative move set including the "held" fill-in;
* replay/dedupe/ordering: duplicate move dropped, move for a resolved turn
  dropped, future move and future resolve buffered then released in turn order,
  a second arbiter's resolve for the same turn ignored;
* chat;
* **arbiter leaves mid-game** → survivors re-elect and the next turn resolves;
* **server killed mid-game** → moves and resolves keep flowing peer-to-peer with
  no server process alive at all; then the clients rejoin on their own when it
  comes back and the mesh re-forms;
* **worst case**: the arbiter crashes *while the server is also down*, so no
  `PEER_LEAVE` can ever arrive — the survivors still re-elect on their own timer
  and the next turn resolves. No deadlock.

Also: a **relay-only pair** — one browser with UDP for WebRTC disabled, one with
`RTCPeerConnection` removed — is reachable at once via the server, measures
RTT, elects an arbiter and resolves a full turn with zero P2P connectivity, and
notices when the other side vanishes.

Not covered by any test: NAT traversal through real STUN/TURN (all peers are on
one loopback host here), >4 players, and browsers other than Chromium.

## Things the game side must be careful about

* `Net.isArbiter()` must be consulted **every turn**, never cached.
* Simulate from the `resolve` event, not from the argument you passed to
  `sendResolve` — the arbiter gets its own event and that is deliberate.
* If you resolve a turn locally when all moves are in, be ready for a
  `resolve` event carrying `late:true` for a turn you already simulated: the
  arbiter may have filled someone in with a default and its version is
  authoritative. The safe design is to resolve *only* on the event.
* `peerId` is the identity used for ships. It is stable for the life of a room,
  but if the **server process restarts** mid-match the room is gone and
  reconnecting clients are issued new ids; `net.js` reports this via `status`,
  tears the stale mesh down and rebuilds it. The game should treat that as a new
  match rather than trying to keep playing the old one.
* `connect()` resolves as soon as the room is joined — the mesh may still be
  forming. Watch `Net.peers()` / `status` before assuming a peer can hear you.
* Moves must be JSON-serialisable and small. Anything over ~8 KB per move is a
  design smell for lockstep.
* `Net._inject()` exists for the tests only; production code must not call it.
