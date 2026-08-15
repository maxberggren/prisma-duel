# Critic brief — PRISMA

You are reviewing `/home/max/Code/lazer/index.html`, a single-file spectral laser
simulator. Your job is **not** to be encouraging. Your job is to find every reason this
is not yet AAA and say so plainly. A vague compliment is a failed review.

## Ground truth

- `reference.png` — the visual target, kept locally and not redistributed.
- Render the current build yourself, don't trust an old screenshot:
  ```
  cd /home/max/Code/lazer
  ./shot.sh /home/max/Code/lazer/shots/crit_<you>.png 1600 900 4000 "/home/max/Code/lazer/index.html?clean=1"
  ./shot.sh /home/max/Code/lazer/shots/crit_<you>_ui.png 1600 900 4000 "/home/max/Code/lazer/index.html"
  python3 tools/crop.py shots/crit_<you>.png shots/crit_<you>_crops --zoom 2
  python3 tools/stats.py shots/crit_<you>.png
  python3 tools/stats.py reference.png
  ```
  `?clean=1` hides the UI panel. `shot.sh <out> [w] [h] [ms] [url]` renders headless via
  SwiftShader — it is slow (~30 s) and it is *not* colour-managed differently from a real
  GPU, so what you see is what users see. Use a 4000 ms budget so the progressive
  accumulator has converged.

## Objective gates

The reference measures (via `tools/stats.py`):
```
p1 0.060   p10 0.094   median 0.151   p90 0.344   p99 0.516   max 0.985   sat 0.282
```
A build whose median is far above ~0.17, or whose p90 is far above ~0.40, is washed out
and fails regardless of how nice it looks to you. Report the actual numbers.

## What to examine, at 1:1 in the crops

1. **Values & colour** — are the blacks real? Is the disc deep and saturated, or pastel?
   Any banding in the wall gradient? Any hue that reads as "default shader blue"?
2. **The disc** — does it read as a physical dichroic film on a physical object, or as a
   procedural texture? Look for tiling, scanlines, high-frequency noise masquerading as
   detail, mushy featureless regions, and edges that don't catch light plausibly.
3. **The beams** — razor-thin and luminous, or fat painted strokes? Do the cores clip to
   flat white blobs? Does the spectral colour survive in the wings? Any stair-stepping,
   any soft rectangles around segments (a quad-windowing bug), any beam that starts or
   ends in mid-air without a reason?
4. **The optics** — trace the light path by eye and check it is *physically coherent*:
   beams should enter the wedge mouth, refract, reflect internally, and exit as a
   dispersed fan. Flag anything that cannot happen: light appearing from nowhere,
   refraction bending the wrong way, a rainbow whose colour order is reversed, TIR that
   should have happened and didn't.
5. **Composition** — does it hold the frame as well as the reference? Weight, balance,
   negative space, where the eye lands first.
6. **The hardware** — do the emitters read as machined metal objects with weight and
   contact shadows, or as flat shapes?
7. **The UI** (in the non-clean shot) — typographic rhythm, alignment, contrast,
   whether it competes with the artwork.

## Output

Return a ranked list. For each item:
- **severity**: `blocker` / `major` / `minor`
- **where**: which crop and roughly where in it
- **what is wrong**: concrete and visual, not "could be improved"
- **the fix**: specific enough to act on — which region owns it
  (`PHYSICS`, `WALL`, `DISC`, `EMITTER`, `BEAM`, `POST`, `STYLE`, `UIHTML`, `INTERACT`)
  and what change to make

End with a single verdict line: `VERDICT: SHIP` only if you would put this in a
portfolio as-is, otherwise `VERDICT: NOT YET` plus the one thing that most holds it back.
Do not soften. Do not edit any files.
