# PRISMA DUEL

A top-down, turn-based laser dogfight where the weapon is a real spectral ray
tracer and the terrain is made of dichroic crystals. Every crystal is cut
differently -- five to eight faces, each vertex at its own radius and angle,
generated from the arena seed -- so no two arenas look alike. Fire through one
and your beam refracts, disperses into a rainbow fan, and can strike people who
were never in your line of sight.

![Prisma](docs/hero.png)

## Run it

**Practice, no server needed** — open `index.html` in a browser and pick
*Practice*. You fly against three bots.

**Multiplayer**

```bash
cd server && npm install      # only dependency is `ws`
node server.js                # PORT=8080 by default
```

Then open the printed URL, enter a room code (or leave it blank to matchmake)
and hit *Join room*. Up to 4 fighters per room.

The server only does matchmaking and relays the WebRTC handshake. Once the mesh
is up, **all gameplay traffic is peer-to-peer** — you can kill the server
mid-match and play on.

## Docker

```bash
docker compose up -d --build      # http://<your LAN IP>:8090/
```

One service, one dependency (`ws`), ~165 MB. The image carries the client as
well as the server, since the server doubles as the static host. It runs as the
unprivileged `node` user on a read-only root filesystem with all capabilities
dropped — nothing is written at runtime, because the client is baked in at build
time and the room table lives in memory.

`PORT` picks the host port (default 8090); the container always listens on 8080.
`docker build --target test .` runs the core and signalling suites inside the
image.

### Deploying to Coolify

Either build pack works and neither needs configuration beyond a domain:

| Build pack | Setting |
|---|---|
| **Dockerfile** | Nothing to set. Coolify reads `EXPOSE 8080` and routes to it. |
| **Docker Compose** | Compose file: `docker-compose.coolify.yml` |

Use `docker-compose.coolify.yml`, not `docker-compose.yml`, for the compose
build pack. The local file publishes a fixed host port and pins a container
name, which fights Coolify's proxy and collides on redeploy; the Coolify file
uses `expose` plus a `SERVICE_FQDN_PRISMA_8080` magic variable instead and lets
Coolify own naming and restart policy.

Three things that usually break a WebSocket app behind a reverse proxy are
already handled:

- The client derives its signalling URL from `location`, so it uses `wss://`
  under HTTPS and follows whatever domain Coolify assigns. No build-time URL.
- The join rate limiter reads `x-forwarded-for`, so players are counted
  individually rather than all appearing as the proxy's address.
- `SIGTERM` closes sockets and exits, so redeploys don't sit out the stop
  timeout. Measured: a full restart cycle takes ~300 ms.

Leave `PORT` unset in Coolify. It has to agree with `EXPOSE`/`Ports Exposes`,
and changing only one silently breaks routing.

Only the handshake goes through the deployment — matches run browser to browser,
so a small instance stays idle while people play.

## How a turn works

Each turn you commit four things, then everyone's orders execute simultaneously
over a ~4 second animation:

| Order | Effect |
|---|---|
| **Course** | Drag the handle, or steer with the arrow keys. How far you drag is how fast you go. |
| **Fire** | Only when charged. Firing consumes the whole charge and suppresses shield regeneration. |

There is one control, and it is out on the arena. Speed is bought from the same
power the capacitor wants, so a long drag is a fast run with no reload, and a
short one is a tight turn that fills the laser. The course line is coloured by
what it costs and the panel shows the split; nothing in the panel is settable.
The course carries over between rounds, so holding a curve is the default.

Damage is **per millisecond of dwell**. A graze costs a few points; holding a
target in the beam for a whole turn is fatal. Because the beam is welded to your
nose, hitting anything means turning to track — which is exactly what your
throttle just made harder.

Shields absorb before hull and regenerate only on turns you do not fire. The
arena walls are mirrors, the crystals are solid cover, and your own bank shot can
come back and hit you.

**The walls close in.** From turn 7 the mirrored box tightens, and once it is as
small as it can go it starts to collapse, damaging everyone by an escalating
amount. Two cautious pilots cannot circle each other forever — verified, with no
shots fired at all, every match still ends by turn 36.

If you do not commit in time, your ship holds its last course.

## Layout

```
index.html      the shipped game — one self-contained file, no dependencies
src/core.js     deterministic simulation core (the rules)
src/core.test.js  36 tests: determinism, rules, and arena invariants
src/net.js      WebRTC mesh + lockstep client
src/game.js     turn loop, orders, preview, netcode glue
src/hud.{css,html}
server/         matchmaking + signalling only
build.js        assembles index.html from src/  (node build.js [--check])
tools/          render/measurement helpers used during development
```

`index.html` is generated. Edit the files in `src/` and run `node build.js`.

## Why it stays in sync without a server

The netcode is peer-to-peer lockstep with no authority, so the simulation must
be bit-identical on every client. `src/core.js` is therefore pure — no DOM, no
wall clock, no `Math.random` — and each turn's trajectory is precomputed once
into a fixed 96-substep path that every peer walks in the same order.

Only the **arbiter** (the lowest-numbered connected peer) declares a turn, and
every client, arbiter included, starts the turn from the resulting `resolve`
event. That single code path is what stops a client who commits last from
resolving a different move set than the one the arbiter filled in on timeout.

Verified between two live browsers: an ordinary turn and a turn where a player
timed out both ended with identical state hashes on both peers.

## Tests

```bash
node src/core.test.js          # 36 assertions: rules, determinism, invariants
node build.js --check          # index.html is in sync with src/
python3 tools/boottest.py      # the shipped page actually boots and starts a match
python3 tools/attracttest.py   # the start screen's demo hands the arena back cleanly
node tools/mobilecheck.js      # layout at real phone/tablet/desktop viewports
cd server && node test-signalling.js   # 52 assertions over every server path
cd server && node test-headless.js     # 45 assertions, 4 real browsers,
                                       # a real 6-link WebRTC mesh
```

Current status: **36/36**, **52/52**, **45/45**. The browser suite spawns four
headless Chromium processes and needs a reasonably idle machine — under heavy
CPU contention its final "mesh re-formed" step can time out.

Balance is measured rather than guessed: 10 consecutive 4-bot matches all
reached a decision, median 14 turns, longest 30, with deaths split 18 laser /
12 collision / 3 wall-collapse. Terrain no longer kills anyone: since a crash
needs the hull itself to touch, flying close to a crystal is a skill rather
than a death sentence.
