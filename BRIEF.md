# PRISMA — shared brief

`/home/max/Code/lazer/index.html` is a **single-file** spectral laser simulator: a CPU
spectral ray tracer feeding a WebGL2 HDR pipeline. Goal: photoreal, gallery-grade,
indistinguishable-from-a-render quality. AAA or it doesn't ship.

## The reference

**Read `reference.png` (kept locally; not in the repo) before doing anything.**
It is the visual target. What it shows:

- A near-black charcoal gallery wall, very slightly blue, lit by a soft broad key from
  above-left. Strong but smooth falloff to almost black in the corners. Fine even grain.
- Four small brushed-aluminium laser emitters stacked at the left, each throwing a
  brilliant white star/flare at its aperture.
- Four crisp, thin, white beams travelling right and converging slightly.
- A large "pac-man" dichroic disc: a circle with a wide wedge cut out, mouth facing left.
  It floats a few centimetres off the wall and casts a soft offset drop shadow.
- The disc body is **deep saturated blue → indigo → violet**, dark overall, not pastel.
  Across it run smooth lighter caustic sweeps in cyan/white where light is guided inside.
- Along the lower cut face there is a band of tightly spaced **parallel rainbow stripes**
  (magenta/green/cyan) from repeated internal reflection.
- A broad, smooth **rainbow fan** exits to the lower right and fades out — red on top
  through green to violet, soft and volumetric, not stripey lines.
- The polished cut edges and the rim catch the key light as thin bright lines.

## Architecture

Regions of `index.html` are delimited by `//#REGION NAME` … `//#ENDREGION NAME`.
Regions: `PHYSICS`, `WALL`, `DISC`, `EMITTER`, `BEAM`, `POST`.

- `PHYSICS` — JS: scene defaults, disc geometry, emitter layout/aiming, spectral tracer.
- `WALL`/`DISC`/`EMITTER` — GLSL inside the fullscreen environment shader `FS_ENV`.
  Available there: `P` (world-space position, y-down, unit = viewport height),
  `uv` (0..1 screen), `px` (one pixel in world units), `aspect`, `uRes`, `uH`, `uTime`,
  `uDisc` (cx,cy,R), `uWedge` (dir,half), `uEm[8]` (x,y,angle,glow), `uNE`, `uHover`,
  `uHoverEm`, and helpers `hash21 vnoise fbm rot sdSegment sdBox sdRound sdSector
  sdDisc thinFilm PI`. Write into `vec3 col`. Everything is **linear HDR** — the ACES
  tonemap and gamma happen later, so do not gamma-correct here.
- `BEAM` — GLSL fragment shader for one beam segment (`FS_BEAM`).
- `POST` — GLSL for bright-pass, bloom down/up, anamorphic streak, final composite.

## Working rules

1. Work **only inside your assigned region(s)**. Other agents own the others in parallel.
2. Iterate on your own copy, never on `index.html` directly:
   ```
   cd /home/max/Code/lazer
   mkdir -p out/<you>
   # write your region body to out/<you>/<REGION>.txt   (body only, no #REGION markers)
   python3 tools/apply.py index.html out/<you>/test.html <REGION>=out/<you>/<REGION>.txt
   ./shot.sh out/<you>/s1.png 1600 900 2500 /home/max/Code/lazer/out/<you>/test.html
   ```
   Then **Read the PNG** and judge it. Repeat until it is genuinely excellent.
3. `./shot.sh <out.png> [w] [h] [ms] [srcfile]` renders headless (SwiftShader, so it is
   slow — ~30 s — but pixel-accurate). Always look at the result before claiming success.
4. If a shader fails to compile the page renders black/blank — check with
   `grep -i error` on shot.sh output, and fix.
5. Keep it dependency-free, single file, 60 fps on a laptop GPU.
6. When done, leave your final region body at `out/<you>/<REGION>.txt` and report a short
   summary of what you changed and what the final screenshot looks like.
