# PRISMA DUEL

A top-down, turn-based laser dogfight where the weapon is a real spectral ray
tracer and the terrain is made of dichroic crystals. Every crystal is cut
differently -- five to eight faces, each vertex at its own radius and angle,
generated from the arena seed -- so no two arenas look alike. Fire through one
and your beam refracts, disperses into a rainbow fan, and can strike people who
were never in your line of sight.

It is an homage to Sean O'Connor's **Critical Mass** (Windows, 1996): the
overhead view, the secret orders, the simultaneous resolution, and the course
you drag out of the ship's nose are his. The (?) on the start card, and
[/critical-mass](https://prisma.oooo.ws/critical-mass), tell that story.

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

The server does matchmaking, relays the WebRTC handshake, and — for any pair of
players that cannot reach each other directly — relays the gameplay messages
themselves, unparsed. Where a direct link comes up, **that pair's traffic is
peer-to-peer** and you can kill the server mid-match and play on; where it
cannot (symmetric NAT, UDP blocked, no WebRTC), the pair plays through the
server over the same WebSocket the page loaded from, which works anywhere the
page does. Nothing waits for ICE: the relay is live from the moment you join and
each pair upgrades to direct the instant its channel opens.

### Playing across NATs: STUN, TURN, relay

Out of the box the client uses Google's public STUN servers, so most home
routers connect directly. For the rest, two fallbacks exist, in order:

1. **TURN** (WebRTC's own relay, still a DataChannel, lower latency). Point the
   server at a coturn instance and it hands out per-seat, expiring credentials
   in the join handshake:

   ```bash
   TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349 \
   TURN_SECRET=<the coturn static-auth-secret> \
   node server/server.js
   ```
   (`TURN_USER`/`TURN_PASS` for a fixed credential, or `ICE_SERVERS='[...]'`
   to pass any RTCIceServer list verbatim.) `docker-compose.turn.yml` runs coturn
   next to the game: `TURN_HOST=your.public.hostname docker compose -f
   docker-compose.yml -f docker-compose.turn.yml up -d`.
2. **WebSocket relay through the game server** — always on, no configuration.
   The HUD says `via server relay` for such peers.

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

Direct pairs never touch the deployment after the handshake; relayed pairs
send it a couple of small JSON messages a second. A small instance is plenty.

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
pages/src/      the site's documents -- /how-it-works, /critical-mass,
                /games-like-critical-mass, /spectral-ray-tracing, /multiplayer
                -- as bodies with a JSON header; build.js wraps them into
                pages/*.html, and server.js serves those at the clean URLs
pages/site.css  turns the in-game manual's card into a page that scrolls;
                the pages load src/hud.css first, so there is one type system
server/         matchmaking + signalling, and the static host
build.js        assembles index.html and pages/ from their sources
                (node build.js [--check])
tools/          render/measurement helpers used during development
assets/         icons, and the picture a shared link shows
site.webmanifest, robots.txt, sitemap.xml
```

`index.html` and `pages/*.html` are generated. Edit `src/` and `pages/src/` and run `node build.js`.

## What a shared link looks like

`assets/og.png` is the card X, Slack, iMessage and the rest show. It is not a
hand-made mock-up: it is the game rendering an actual traced frame, posed by
`tools/poster.py`, with the wordmark set on it by `tools/ogcard.py`.

The pose is chosen by the start screen's own shot scorer — how much glass the
ray crosses, how far off-axis it enters (the spread between red and violet goes
with the sine of the angle of incidence) and how much clear run the fan has
afterwards — swept over every crystal and a ring of firing positions, so the
picture is the best rainbow that arena can produce rather than the first one
found.

```bash
python3 tools/poster.py shots/hero.png --seed 20260815 --frame 1.5 --wreck 0.9 \
                        --size 1200x630 --scale 2 --samples 96
python3 tools/ogcard.py shots/hero.png assets/og.png     # adds the lockup
python3 tools/icons.py                                   # logo.svg -> every icon
```

`assets/logo.svg` is the mark those icons come from: white in, crystal, spectrum
out. It is drawn so that the parts carrying the idea are still solid colour at
16 pixels — only the glows go.

**Absolute URLs without a build-time domain.** A crawler does not run scripts,
and X drops a relative `og:image` without saying so, so the tags have to be
absolute in the file. They are written against `https://prismaduel.com`, and
`server.js` swaps that origin for whichever host actually served the request
(`X-Forwarded-Host`/`-Proto` when behind a proxy). The same build is therefore
correct on production, on a Coolify preview URL and on a laptop on the LAN, and
`SITE_ORIGIN=https://…` moves the canonical domain without touching a file.
Icon and manifest hrefs stay relative, because practice mode opens the page
straight off the filesystem.

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
node build.js --check          # index.html and pages/ are in sync with their sources
python3 tools/boottest.py      # the shipped page actually boots and starts a match
python3 tools/attracttest.py   # the start screen's demo hands the arena back cleanly
node tools/mobilecheck.js      # layout at real phone/tablet/desktop viewports
cd server && node test-signalling.js   # 60 assertions over every server path
cd server && node test-headless.js     # 54 assertions, 6 real browsers,
                                       # a real 6-link WebRTC mesh + a relay-only pair
```

Current status: **36/36**, **60/60**, **54/54**. The browser suite spawns four
headless Chromium processes and needs a reasonably idle machine — under heavy
CPU contention its final "mesh re-formed" step can time out.

Balance is measured rather than guessed: 10 consecutive 4-bot matches all
reached a decision, median 14 turns, longest 30, with deaths split 18 laser /
12 collision / 3 wall-collapse. Terrain no longer kills anyone: since a crash
needs the hull itself to touch, flying close to a crystal is a skill rather
than a death sentence.
