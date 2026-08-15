/* ============================================================================
   PRISMA DUEL — client: turn loop, orders, preview, netcode glue
   ==========================================================================*/
const $ = id => document.getElementById(id);
const ui = $('ui'), gizEl = $('giz'), lobbyEl = $('lobby');

/* ------------------------------------------------------------ world <-> screen */
function w2s(x, y) {
  return { x: (x * viewScale + viewOffX) / DPR, y: (y * viewScale + viewOffY) / DPR };
}
function s2w(cx, cy) {
  const r = canvas.getBoundingClientRect();
  const s = viewScale / DPR;
  return { x: (cx - r.left - viewOffX / DPR) / s, y: (cy - r.top - viewOffY / DPR) / s };
}
const selfShip = () => G.state ? G.state.ships[G.selfIdx] : null;
const deg = a => Math.round(((a * 180 / Math.PI) % 360 + 360) % 360);

/* ============================================================== the gizmo layer
   The course handle and the predicted track. The track drawn here is produced
   by the same `integratePath` the simulation uses, so what you are shown is
   exactly what you will fly. */
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(SVGNS, 'svg');
gizEl.appendChild(svg);
function mk(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  svg.appendChild(e);
  return e;
}
/* The reachable envelope: how far you can turn and how fast you can be going
   by the end of this turn. It is the only visualisation of what the power
   split actually buys you, which is why it stays. */
const gEnvelope = mk('path', { fill: 'rgba(127,216,255,.055)', stroke: 'rgba(127,216,255,.20)', 'stroke-width': 1 });
const gTrackBk = mk('path', { fill: 'none', stroke: 'rgba(0,0,0,.55)', 'stroke-width': 4.5, 'stroke-linecap': 'round' });
const gTrack = mk('path', { fill: 'none', stroke: '#7fd8ff', 'stroke-width': 2, 'stroke-linecap': 'round' });
const handle = document.createElement('button');
handle.className = 'hnd';
handle.type = 'button';
handle.setAttribute('role', 'slider');
handle.setAttribute('aria-label', 'Course and throttle');
handle.innerHTML = '<i></i>';
gizEl.appendChild(handle);

/* ------------------------------------------------------------- orders state */
const oThr = $('oThr'), oSpd = $('oSpd'), oFire = $('oFire'), oCommit = $('oCommit');
let committed = false;

function legalNow() {
  const sh = selfShip();
  if (!sh) return null;
  return legaliseMove(sh, { heading: G.aim.heading, speed: G.aim.speed, thrust: G.aim.thrust, fire: G.aim.fire });
}

function syncOrderUI() {
  const sh = selfShip();
  if (!sh) return;
  // the rematch screen replaces the orders panel, detaching these controls
  if (!oCommit.isConnected) return;
  if (!sh.alive) {
    // a destroyed player keeps watching; the turn no longer waits on them
    $('commitLbl').textContent = 'DESTROYED — SPECTATING';
    oCommit.disabled = oFire.disabled = oThr.disabled = oSpd.disabled = true;
    oCommit.classList.remove('done');
    return;
  }
  const thr = G.aim.thrust;
  oThr.value = thr; oThr.style.setProperty('--p', thr);
  $('vThr').textContent = `${Math.round((1 - thr) * 100)} / ${Math.round(thr * 100)}`;

  const maxS = maxSpeedFor(thr);
  const f = clamp((G.aim.speed - RULES.SPEED_MIN) / (maxS - RULES.SPEED_MIN), 0, 1);
  oSpd.value = f; oSpd.style.setProperty('--p', f);
  $('vSpd').textContent = Math.round(G.aim.speed / RULES.SPEED_MAX * 100) + '%';

  const charged = sh.charge >= RULES.FIRE_COST - 1e-9;
  oFire.disabled = !charged || committed;
  if (!charged) G.aim.fire = false;
  oFire.setAttribute('aria-pressed', G.aim.fire ? 'true' : 'false');
  $('fireLbl').textContent = !charged
    ? `CHARGING ${Math.round(sh.charge * 100)}%`
    : (G.aim.fire ? 'LASER ARMED' : 'ARM LASER');

  oThr.disabled = oSpd.disabled = committed;
  oCommit.disabled = committed;
  oCommit.classList.toggle('done', committed);
  $('commitLbl').textContent = committed ? 'ORDERS SENT — WAITING' : 'COMMIT ORDERS';
}

/* --------------------------------------------------------------- the roster */
function renderRoster() {
  const el = $('roster');
  if (!G.state) { el.innerHTML = ''; return; }
  el.innerHTML = '';
  for (const sh of G.state.ships) {
    const L = LIVERY[sh.idx % LIVERY.length];
    const c = document.createElement('div');
    c.className = 'card' + (sh.idx === G.selfIdx ? ' self' : '') + (sh.alive ? '' : ' dead');
    c.setAttribute('role', 'listitem');
    c.style.setProperty('--liv', `rgb(${L.rgb.map(v => Math.round(v * 255)).join(',')})`);
    const ready = G.moves[sh.id] !== undefined;
    c.innerHTML =
      `<div class="top"><span class="nm">${esc(sh.name)}</span>` +
      (sh.idx === G.selfIdx ? '<span class="you">YOU</span>' : '') +
      `<span class="st ${ready ? 'rdy' : ''}">${sh.alive ? (G.phase === 'plan' ? (ready ? 'READY' : 'PLANNING') : '') : 'DESTROYED'}</span></div>` +
      `<div class="bar sh"><i style="width:${sh.shield / RULES.SHIELD_MAX * 100}%"></i></div>` +
      `<div class="bar hu"><i style="width:${sh.hull / RULES.HULL_MAX * 100}%"></i></div>` +
      `<div class="bar ch"><i style="width:${sh.charge / RULES.CHARGE_MAX * 100}%"></i></div>` +
      `<div class="lbl"><span>SHLD ${Math.round(sh.shield)}</span><span>HULL ${Math.round(sh.hull)}</span>` +
      `<span>${sh.charge >= 1 ? 'ARMED' : Math.round(sh.charge * 100) + '%'}</span></div>`;
    el.appendChild(c);
  }
}
const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

/* ------------------------------------------------------------ gizmo drawing */
let gizSig = '';
function drawGizmo() {
  const show = G.phase === 'plan' && selfShip() && selfShip().alive;
  svg.style.display = show ? '' : 'none';
  handle.style.display = show ? '' : 'none';
  if (!show) return;
  const sh = selfShip();
  const m = legalNow();

  const sig = [sh.x, sh.y, sh.heading, sh.speed, m.heading, m.speed, m.thrust,
               W, H, viewScale, viewOffX, viewOffY].join(',');
  if (sig === gizSig) return;
  gizSig = sig;

  // the reachable envelope for this power split
  const rate = turnRateFor(m.thrust, sh.speed);
  const sMin = clamp(sh.speed - RULES.ACCEL, RULES.SPEED_MIN, RULES.SPEED_MAX);
  const sMax = clamp(sh.speed + RULES.ACCEL, RULES.SPEED_MIN, maxSpeedFor(m.thrust));
  let d = '';
  for (let k = 0; k <= 24; k++) {
    const a = sh.heading + lerp(-rate, rate, k / 24);
    const p = w2s(sh.x + Math.cos(a) * sMax, sh.y + Math.sin(a) * sMax);
    d += (k ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
  }
  for (let k = 24; k >= 0; k--) {
    const a = sh.heading + lerp(-rate, rate, k / 24);
    const p = w2s(sh.x + Math.cos(a) * sMin, sh.y + Math.sin(a) * sMin);
    d += 'L' + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
  }
  gEnvelope.setAttribute('d', d + 'Z');

  // the predicted track, from the very same integrator the sim uses
  const path = integratePath(sh, m, arena.w, arena.h, arena.prisms, (G.state && G.state.inset) || 0);
  let t = '';
  for (let k = 0; k <= RULES.SUBSTEPS; k += 4) {
    const p = w2s(path[k].x, path[k].y);
    t += (k ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
  }
  gTrackBk.setAttribute('d', t); gTrack.setAttribute('d', t);

  const end = w2s(path[RULES.SUBSTEPS].x, path[RULES.SUBSTEPS].y);
  handle.style.left = end.x + 'px';
  handle.style.top = end.y + 'px';
  handle.setAttribute('aria-valuetext',
    `heading ${deg(m.heading)} degrees, speed ${Math.round(m.speed / RULES.SPEED_MAX * 100)} per cent`);
}

/* -------------------------------------------------- the aiming preview beam
   Appends a ghost of your own shot to the current trace, fired from where you
   will actually be at the end of the turn. This is the whole point of the
   planning phase: you can see the bank shot before you commit to it. */
function addPreviewBeam() {
  if (G.phase !== 'plan') return;
  const sh = selfShip();
  if (!sh || !sh.alive || !G.aim.fire) return;
  const m = legalNow();
  const path = integratePath(sh, m, arena.w, arena.h, arena.prisms, (G.state && G.state.inset) || 0);
  const N = 40;
  const pw = BEAM_POWER * 0.55 * 1.15 / N;
  for (const frac of [0.0, 0.5, 1.0]) {
    const node = path[Math.round(frac * RULES.SUBSTEPS)];
    const dx = Math.cos(node.heading), dy = Math.sin(node.heading);
    const bx = node.x + dx * MUZZLE, by = node.y + dy * MUZZLE;
    for (let k = 0; k < N; k++) {
      const u = (k + (vdc(k + 1) - 0.5) * 0.9) / (N - 1);
      const lam = SPEC_LO + clamp(u, 0, 1) * (SPEC_HI - SPEC_LO);
      castRay(bx, by, dx, dy, waveRGB(lam), pw * (frac === 0.5 ? 0.55 : 0.8), lam, G.selfIdx, false);
    }
  }
}

/* ====================== destruction: explosion & smoke ====================
   Cosmetic only. The *trigger* is deterministic — a ship dies on the same
   substep on every peer — but the particles never enter the state hash or the
   resync payload, so they can run at frame rate and vary harmlessly per client.

   The sequence is authored as one event rather than four systems fired at once:

     0.000  detonation. A white-hot core at ~35x display white, gone in 0.12 s,
            with a shock front that outruns it and dissipates by 0.34 s.
     0.02   the fireball erupts out of the flash, cooling white -> amber ->
            orange -> deep red as it churns, and throws its light onto the
            surrounding air for half a second.
     0.10   secondary detonations inside the wreck, two or three of them, so the
            event rolls instead of ending on one beat.
     0.00   embers leave on ballistic arcs, motion-streaked, flickering, the
            fastest gone in a third of a second and the slowest still burning
            at two.
     0.35+  every fireball puff, as it burns out, *becomes* a smoke puff at the
            same place with the same momentum — the smoke is the fire, cooled,
            not a separate cloud that happens to be there.
     0.4-2  the hottest wreckage sections trail their own smoke while their torn
            edges are still glowing.
     6-30   a soot scorch and the last of the column, thinning.                */
const vfx = { fire: [], puffs: [], sparks: [], glows: [], wrecks: [] };
let vfxSeed = 1;
let fireShake = 0, hitShake = 0;
function vrnd() { vfxSeed = (vfxSeed * 1664525 + 1013904223) >>> 0; return vfxSeed / 4294967296; }
function vrng(a, b) { return a + (b - a) * vrnd(); }
/** Live particle count, so four wrecks on screen at once cost about what one
    does: every group is scaled by the remaining budget when it spawns. */
function vfxLoad() { return vfx.fire.length + vfx.puffs.length + vfx.sparks.length + vfx.glows.length; }

/** A smoke puff. Also the retirement path for a burnt-out fireball puff. */
function pushSmoke(o) {
  vfx.puffs.push({
    x: o.x, y: o.y, vx: o.vx, vy: o.vy,
    r: o.r, r1: o.r1, t: o.t || 0, life: o.life,
    rot: vrnd() * TAU, spin: vrng(-0.5, 0.5), seed: vrnd(),
    warm: o.warm || 0, wx: o.wx || 0, wy: o.wy || 0,
    // how deep in the cloud this puff sits: the interior ones stay dark
    shade: vrng(0.30, 1.05),
    a: 0, peak: o.peak !== undefined ? o.peak : 0.85,
  });
}

function spawnDestruction(sh) {
  const R = RULES.HULL_R;
  const cx = sh.x, cy = sh.y;
  // the wreck keeps the ship's momentum: the fireball and the smoke are dragged
  // downrange, which is most of what makes a kill read as a kill in motion
  const mvx = Math.cos(sh.heading) * sh.speed, mvy = Math.sin(sh.heading) * sh.speed;
  const q = clamp(1 - vfxLoad() / 1100, 0.4, 1);          // shared budget
  // one drift for the whole wreck, so its column leans instead of sitting
  const wa = vrnd() * TAU, ws = vrng(0.010, 0.030);
  const wx = Math.cos(wa) * ws + mvx * 0.10, wy = Math.sin(wa) * ws + mvy * 0.10;

  /* ---- the detonation itself ---------------------------------------------
     Three overlapping lights: the core (blown out, over in 0.12 s), the shock
     front (outruns it, thin, cold-white), and the light the event throws into
     the air around it, which is what stops the flash reading as a decal. */
  vfx.glows.push({ kind: 0, x: cx, y: cy, r: R * 0.85, r0: R * 0.85, r1: R * 3.1, t: 0, life: 0.115,
                   amp: 9.0, a: 0, cr: 1.0, cg: 0.94, cb: 0.84, seed: vrnd() });
  // the ignition itself, bridging the flash into the fireball
  vfx.glows.push({ kind: 0, x: cx, y: cy, r: R * 1.8, r0: R * 1.8, r1: R * 5.0, t: 0, life: 0.26,
                   amp: 1.2, a: 0, cr: 1.0, cg: 0.62, cb: 0.26, seed: vrnd() });
  vfx.glows.push({ kind: 1, x: cx, y: cy, r: R * 1.6, r0: R * 1.6, r1: R * 5.0, t: 0, life: 0.07,
                   amp: 0.25, a: 0, cr: 1.0, cg: 0.90, cb: 0.80, seed: vrnd() });
  vfx.glows.push({ kind: 2, x: cx, y: cy, r: R * 3.0, r0: R * 3.0, r1: R * 8.5, t: 0, life: 0.40,
                   amp: 0.13, a: 0, cr: 1.0, cg: 0.42, cb: 0.11, seed: vrnd() });

  /* ---- the fireball -------------------------------------------------------
     Two scales, because one is never enough: a few big slow masses that
     overlap into a single body, and a ring of small fast ones that tear off
     the front of it and burn out first. */
  const nBig = Math.round(7 * q), nSmall = Math.round(9 * q);
  for (let i = 0; i < nBig; i++) {
    const a = vrnd() * TAU, sp = vrng(0.03, 0.20);
    vfx.fire.push({
      x: cx + Math.cos(a) * R * vrng(0, 0.30), y: cy + Math.sin(a) * R * vrng(0, 0.30),
      vx: Math.cos(a) * sp + mvx * 0.55, vy: Math.sin(a) * sp + mvy * 0.55,
      r: R * vrng(1.10, 1.90), r1: R * vrng(6.0, 9.0),
      t: -vrng(0, 0.035), life: vrng(0.70, 1.25),
      temp: vrng(0.94, 1.0), rot: vrnd() * TAU, spin: vrng(-1.4, 1.4),
      seed: vrnd(), a: 0, kind: 0, wx: wx, wy: wy,
    });
  }
  for (let i = 0; i < nSmall; i++) {
    const a = vrnd() * TAU, sp = vrng(0.14, 0.44);
    vfx.fire.push({
      x: cx + Math.cos(a) * R * vrng(0.2, 0.9), y: cy + Math.sin(a) * R * vrng(0.2, 0.9),
      vx: Math.cos(a) * sp + mvx * 0.6, vy: Math.sin(a) * sp + mvy * 0.6,
      r: R * vrng(0.65, 1.20), r1: R * vrng(2.6, 4.4),
      t: -vrng(0, 0.06), life: vrng(0.26, 0.55),
      temp: vrng(0.52, 0.86), rot: vrnd() * TAU, spin: vrng(-2.6, 2.6),
      seed: vrnd(), a: 0, kind: 0, wx: wx, wy: wy,
    });
  }

  /* ---- secondaries: the wreck goes up in stages ------------------------- */
  const nSec = 2 + (vrnd() < 0.55 ? 1 : 0);
  for (let k = 0; k < nSec; k++) {
    const d = vrng(0.10, 0.40), a = vrnd() * TAU, rr = R * vrng(0.4, 1.2);
    const sx = cx + Math.cos(a) * rr + mvx * d, sy = cy + Math.sin(a) * rr + mvy * d;
    vfx.glows.push({ kind: 0, x: sx, y: sy, r: R * 0.9, r0: R * 0.9, r1: R * 3.4, t: -d, life: 0.13,
                     amp: 2.6, a: 0, cr: 1.0, cg: 0.68, cb: 0.30, seed: vrnd() });
    const n = Math.round(4 * q);
    for (let i = 0; i < n; i++) {
      const b = vrnd() * TAU, sp = vrng(0.06, 0.30);
      vfx.fire.push({
        x: sx, y: sy, vx: Math.cos(b) * sp + mvx * 0.4, vy: Math.sin(b) * sp + mvy * 0.4,
        r: R * vrng(0.40, 0.75), r1: R * vrng(1.8, 3.2),
        t: -d - vrng(0, 0.04), life: vrng(0.34, 0.70),
        temp: vrng(0.80, 0.95), rot: vrnd() * TAU, spin: vrng(-2.6, 2.6),
        seed: vrnd(), a: 0, kind: 0, wx: wx, wy: wy,
      });
    }
    for (let i = 0; i < Math.round(5 * q); i++) {
      const b = vrnd() * TAU, sp = vrng(0.25, 1.0);
      vfx.sparks.push({ x: sx, y: sy, vx: Math.cos(b) * sp, vy: Math.sin(b) * sp,
        r: R * vrng(0.045, 0.10), t: -d, life: vrng(0.25, 1.1), temp: vrng(0.7, 1.0),
        drag: vrng(0.5, 1.4), seed: vrnd(), flick: vrng(26, 60), a: 0 });
    }
  }

  /* ---- embers ------------------------------------------------------------
     A wide speed spread is what sells shrapnel: a few outrun everything and
     die immediately, the slow ones tumble and glow on for two seconds. */
  const nSpark = Math.round(24 * q);
  const nJet = 4 + Math.floor(vrnd() * 3);
  const jets = [];
  for (let k = 0; k < nJet; k++) jets.push({ a: vrnd() * TAU, w: vrng(0.12, 0.6), n: vrng(0.3, 1.0) });
  let jw = 0; for (const j of jets) jw += j.n;
  for (let i = 0; i < nSpark; i++) {
    // shrapnel leaves in jets of uneven strength: a blast has structure, it is
    // not a sprinkler head
    let pick = vrnd() * jw, jt = jets[0];
    for (const j of jets) { pick -= j.n; if (pick <= 0) { jt = j; break; } }
    const a = jt.a + vrng(-jt.w, jt.w);
    const fast = vrnd() < 0.28;
    const sp = fast ? vrng(1.0, 2.1) : vrng(0.18, 0.85);
    vfx.sparks.push({
      x: cx + Math.cos(a) * R * 0.3, y: cy + Math.sin(a) * R * 0.3,
      vx: Math.cos(a) * sp + mvx * 0.5, vy: Math.sin(a) * sp + mvy * 0.5,
      r: R * (fast ? vrng(0.030, 0.065) : vrng(0.045, 0.120)),
      t: 0, life: fast ? vrng(0.28, 0.75) : vrng(0.6, 2.2),
      temp: fast ? vrng(0.80, 1.0) : vrng(0.42, 0.95), drag: vrng(0.35, 1.1),
      seed: vrnd(), flick: vrng(22, 58), a: 0, blur: vrng(0.6, 1.7),
    });
  }

  /* ---- the smoke that is not born of fire --------------------------------
     Only the first breath of it: the bulk of the column arrives later, as the
     fireball puffs burn out and hand themselves over. */
  const nSmoke = Math.round(10 * q);
  for (let i = 0; i < nSmoke; i++) {
    const a = vrnd() * TAU, sp = vrng(0.03, 0.16);
    pushSmoke({
      x: cx + Math.cos(a) * R * vrng(0.1, 0.8), y: cy + Math.sin(a) * R * vrng(0.1, 0.8),
      vx: Math.cos(a) * sp + mvx * 0.35, vy: Math.sin(a) * sp + mvy * 0.35,
      r: R * vrng(1.1, 1.9), r1: R * vrng(4.0, 7.0),
      t: -vrng(0.06, 0.7), life: vrng(5.0, 11.0), warm: 1, peak: vrng(0.70, 1.0),
      wx: wx, wy: wy,
    });
  }

  /* ---- soot on the deck, and the smouldering-wreck bookkeeping ---------- */
  for (let i = 0; i < 2; i++) {
    vfx.fire.push({
      x: cx + vrng(-1, 1) * R * 0.5, y: cy + vrng(-1, 1) * R * 0.5, vx: 0, vy: 0,
      r: R * vrng(1.5, 2.9), r1: R * vrng(1.9, 3.4), t: 0, life: 26 + vrnd() * 8,
      temp: 0, rot: vrnd() * TAU, spin: 0, seed: vrnd(), a: 0, kind: 1,
    });
  }
  vfx.wrecks.push({ idx: sh.idx, x: cx, y: cy, t: 0, next: 0.10 });
}

/* Heat left in a wreck, 1 straight out of the fireball and gone by ~6 s. Kept
   out here, keyed by ship index, because the debris itself is core state and
   must not grow a cosmetic field. */
const wreckAge = {};
function wreckHeat(idx) {
  const t = wreckAge[idx];
  return t === undefined ? 0 : Math.exp(-t * 0.45) * (t < 0.15 ? t / 0.15 : 1);
}

function stepVfx(dt) {
  const R = RULES.HULL_R;

  /* ---- fireball ---------------------------------------------------------- */
  for (let i = vfx.fire.length - 1; i >= 0; i--) {
    const p = vfx.fire[i];
    p.t += dt;
    if (p.t < 0) { p.a = 0; continue; }
    const u = p.t / p.life;
    if (u >= 1) {
      if (p.kind === 0 && p.r > RULES.HULL_R * 2.6) {
        // it does not disappear, it becomes the smoke it turned into
        pushSmoke({ x: p.x, y: p.y, vx: p.vx * 0.55, vy: p.vy * 0.55,
                    r: p.r * 1.05, r1: Math.min(p.r * vrng(1.30, 2.00), RULES.HULL_R * 9.0),
                    life: vrng(4.5, 9.5), warm: 0.30, peak: vrng(0.85, 1.0),
                    wx: p.wx, wy: p.wy });
      }
      vfx.fire.splice(i, 1); continue;
    }
    if (p.kind === 1) {                     // scorch: settles, then just sits
      p.a = Math.min(1, p.t * 5.0) * (1 - smoothstep01(0.55, 1.0, u)) * 0.85;
      p.r += (p.r1 - p.r) * (1 - Math.pow(0.5, dt));
      continue;
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    const drag = Math.pow(0.12, dt);
    p.vx *= drag; p.vy *= drag;
    p.rot += p.spin * dt;
    p.spin *= Math.pow(0.35, dt);
    p.r += (p.r1 - p.r) * (1 - Math.pow(0.02, dt));   // it opens up fast, then stalls
    // temperature: a brief hold at peak, then a steep cool into soot
    p.T = p.temp * Math.pow(1 - u, 1.25) * (u < 0.08 ? 0.55 + u / 0.08 * 0.45 : 1);
    p.a = Math.min(1, p.t * 26) * Math.pow(1 - u, 0.70);
  }

  /* ---- smoke ------------------------------------------------------------- */
  for (let i = vfx.puffs.length - 1; i >= 0; i--) {
    const p = vfx.puffs[i];
    p.t += dt;
    if (p.t < 0) { p.a = 0; continue; }
    const u = p.t / p.life;
    if (u >= 1) { vfx.puffs.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    const drag = Math.pow(0.30, dt);
    p.vx = p.vx*drag + p.wx*dt; p.vy = p.vy*drag + p.wy*dt;   // it drifts on the air
    p.rot += p.spin * dt;
    p.r += (p.r1 - p.r) * (1 - Math.pow(0.55, dt));
    p.warm *= Math.pow(0.004, dt);            // the fire that lit it is going out
    // thin as it expands: dense and opaque while it is young, a veil at the end
    p.a = Math.min(1, p.t * 3.2) * Math.pow(1 - u, 0.75) * p.peak;
    if (u > 0.5 && p.a < 0.035) { vfx.puffs.splice(i, 1); }   // invisible: stop paying for it
  }

  /* ---- flash, shock front, thrown light ---------------------------------- */
  for (let i = vfx.glows.length - 1; i >= 0; i--) {
    const p = vfx.glows[i];
    p.t += dt;
    if (p.t < 0) { p.a = 0; continue; }
    const u = p.t / p.life;
    if (u >= 1) { vfx.glows.splice(i, 1); continue; }
    if (p.kind === 1) {                       // shock front: fast, then coasts
      p.r = p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - u, 2.6));
      p.a = p.amp * Math.pow(1 - u, 2.2) * Math.min(1, u * 14);
    } else if (p.kind === 2) {                // light thrown into the air
      p.r = p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - u, 2.0));
      p.a = p.amp * Math.pow(1 - u, 2.6) * Math.min(1, u * 30);
    } else {                                  // the core
      p.r = p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - u, 1.7));
      p.a = p.amp * Math.pow(1 - u, 2.4) * Math.min(1, u * 55);
    }
  }

  /* ---- embers ------------------------------------------------------------ */
  for (let i = vfx.sparks.length - 1; i >= 0; i--) {
    const p = vfx.sparks[i];
    p.t += dt;
    if (p.t < 0) { p.a = 0; continue; }
    const u = p.t / p.life;
    if (u >= 1) { vfx.sparks.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    const drag = Math.pow(0.02, dt * p.drag);
    p.vx *= drag; p.vy *= drag;
    p.T = p.temp * Math.pow(1 - u, 0.55);     // cools slowly, then falls off a cliff
    // flicker: a hot fragment tumbling, showing you a bright face and a dark one
    const fl = 0.62 + 0.38 * Math.sin(p.t * p.flick + p.seed * 31)
                    * Math.sin(p.t * p.flick * 0.37 + p.seed * 11);
    p.a = Math.pow(1 - u, 1.3) * fl;
  }

  /* ---- smouldering wreckage ---------------------------------------------
     The hottest two sections trail smoke while their torn edges still glow, so
     the wreck stays connected to the event that made it. */
  for (let i = vfx.wrecks.length - 1; i >= 0; i--) {
    const w = vfx.wrecks[i];
    w.t += dt;
    wreckAge[w.idx] = w.t;
    if (w.t > 10.0) { vfx.wrecks.splice(i, 1); continue; }
    w.next -= dt;
    if (w.t > 2.2) continue;                    // it stops smoking long before it cools
    if (w.next > 0 || !G.state || !G.state.debris) continue;
    w.next = 0.22;
    const heat = wreckHeat(w.idx);
    let hot = null, hot2 = null;
    for (const d of G.state.debris) {
      if (d.idx !== w.idx) continue;
      if (!hot || d.burn > hot.burn) { hot2 = hot; hot = d; }
      else if (!hot2 || d.burn > hot2.burn) { hot2 = d; }
    }
    for (const d of [hot, hot2]) {
      if (!d) continue;
      pushSmoke({
        x: d.x + vrng(-1, 1) * R * 0.15, y: d.y + vrng(-1, 1) * R * 0.15,
        vx: d.vx * 0.4 + vrng(-1, 1) * 0.02, vy: d.vy * 0.4 + vrng(-1, 1) * 0.02,
        r: R * vrng(0.16, 0.30), r1: R * vrng(0.8, 1.6),
        life: vrng(1.4, 3.0), warm: 0.06 * heat, peak: vrng(0.34, 0.58) * (0.4 + 0.6 * heat),
      });
      if (vrnd() < 0.35 * heat) {
        const a = vrnd() * TAU, sp = vrng(0.02, 0.10);
        vfx.sparks.push({ x: d.x, y: d.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          r: R * vrng(0.035, 0.07), t: 0, life: vrng(0.3, 0.9), temp: vrng(0.45, 0.75),
          drag: vrng(1.2, 2.4), seed: vrnd(), flick: vrng(30, 70), a: 0 });
      }
    }
  }
}

function smoothstep01(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ---------------------------------------------------------- damage feedback
   Damage accrues continuously as a beam dwells, which is legible in the fiction
   but invisible on screen. Floating numbers and a hull flash make the exchange
   readable: you can see who is being melted, and by how much. */
const fxLayer = document.createElement('div');
fxLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
gizEl.parentNode.appendChild(fxLayer);
const fx = [];
let dmgAccum = [0, 0, 0, 0], dmgSince = [0, 0, 0, 0];

function spawnDamage(idx, amount) {
  const sh = G.state.ships[idx];
  const L = LIVERY[idx % LIVERY.length];
  const p = w2s(sh.x, sh.y);
  // fan successive hits apart so a sustained burn reads as a stream of numbers
  // rather than one illegible pile
  const n = fx.filter(f => f.idx === idx).length;
  p.x += ((n % 3) - 1) * 17;
  p.y -= n * 9;
  const el = document.createElement('div');
  const heavy = amount >= 12;
  el.textContent = '-' + Math.round(amount);
  el.style.cssText =
    `position:absolute;left:${p.x}px;top:${p.y - 22}px;transform:translate(-50%,-50%);` +
    `font:${heavy ? 700 : 600} ${heavy ? 19 : 14.5}px ui-monospace,monospace;letter-spacing:.04em;` +
    `color:rgb(${L.rgb.map(v => Math.round(120 + v * 135)).join(',')});` +
    `text-shadow:0 2px 10px rgba(0,0,0,.95);will-change:transform,opacity`;
  fxLayer.appendChild(el);
  fx.push({ el, idx, t: 0, life: heavy ? 1.5 : 1.1 });
}
function stepFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.t += dt;
    const u = f.t / f.life;
    if (u >= 1) { f.el.remove(); fx.splice(i, 1); continue; }
    f.el.style.opacity = String(1 - u * u);
    f.el.style.marginTop = (-26 * u) + 'px';
  }
}

/* ============================================================== the turn loop */
function commitOrders() {
  if (committed || G.phase !== 'plan') return;
  const sh = selfShip();
  if (!sh || !sh.alive) return;
  committed = true;
  const move = { heading: G.aim.heading, speed: G.aim.speed, thrust: G.aim.thrust,
                 fire: G.aim.fire, h: stateHash(G.state), sig: RULES_SIG };
  G.moves[sh.id] = move;
  if (NET.live) NET.sendMove(G.state.turn, move);
  syncOrderUI(); renderRoster();
  maybeResolve();
}

/** Bots commit as soon as the player does, so solo play never waits.
    They are deliberately not perfect: they lead the target, respect the
    thrust-versus-recharge tradeoff, keep off the closing walls, and only take
    the shot when the geometry is actually there. */
function botOrders(sh) {
  const foes = G.state.ships.filter(s => s.alive && s.idx !== sh.idx);
  if (!foes.length) return { heading: sh.heading, speed: sh.speed, thrust: 0.5, fire: false };

  // pick the softest reachable target, not merely the closest
  let best = foes[0], bestScore = -1e9;
  for (const f of foes) {
    const d = Math.hypot(f.x - sh.x, f.y - sh.y);
    const score = -d * 2.2 - (f.shield + f.hull) * 0.004;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  const dist = Math.hypot(best.x - sh.x, best.y - sh.y);

  // lead it: where will it be when the beam gets there?
  const lead = 0.85;
  let tx = best.x + Math.cos(best.heading) * best.speed * lead;
  let ty = best.y + Math.sin(best.heading) * best.speed * lead;

  // stay off the closing walls — being pinned against one is how bots die
  const IN = (G.state && G.state.inset) || 0;
  const m = RULES.SPEED_MAX * 1.35;      // one turn of travel, plus a little
  const cx = arena.w * 0.5, cy = arena.h * 0.5;
  const nearWall = Math.min(sh.x - IN, arena.w - IN - sh.x, sh.y - IN, arena.h - IN - sh.y);
  if (nearWall < m) {
    const w = (m - nearWall) / m;
    tx = lerp(tx, cx, w * 0.85);
    ty = lerp(ty, cy, w * 0.85);
  }

  const want = Math.atan2(ty - sh.y, tx - sh.x);
  const off = Math.abs(angDelta(sh.heading, want));
  const charged = sh.charge >= RULES.FIRE_COST - 1e-9;

  /* The tradeoff, played honestly: burn thrust to close or to escape a wall,
     throttle back to reload when out of position. */
  let thrust;
  if (nearWall < m) thrust = 0.9;
  else if (!charged) thrust = off > 0.7 ? 0.55 : 0.15;   // reload while lining up
  else if (dist > 0.6) thrust = 0.85;
  else thrust = off > 0.5 ? 0.45 : 0.3;

  let speed = nearWall < m ? RULES.SPEED_MAX
            : dist > 0.5 ? RULES.SPEED_MAX * 0.85
            : RULES.SPEED_MAX * 0.5;

  /* Throttle back near anything solid. Every bot death was a "boxed in" case:
     cornered with too much speed left to turn out of it, because turn rate
     falls as speed rises. Room to manoeuvre is bought with the throttle. */
  let clearance = nearWall;
  for (const pr of arena.prisms) clearance = Math.min(clearance, prismSD(pr, sh.x, sh.y));
  const comfort = RULES.SPEED_MAX * 1.6;
  if (clearance < comfort) {
    speed = Math.min(speed, RULES.SPEED_MIN +
      (RULES.SPEED_MAX - RULES.SPEED_MIN) * clamp(clearance / comfort, 0, 1) ** 1.5);
  }

  // only shoot when the nose will actually be on them
  const fire = charged && off < 0.38 && dist < 1.05;

  /* Flying into a wall or a prism is fatal now, so a bot that only chases is a
     bot that kills itself — measured, 30 of 32 deaths were crashes. Candidate
     courses are tested through the very same integrator the simulation uses,
     so the avoidance is exactly as accurate as the rules are. */
  return avoidObstacles(sh, { heading: want, speed, thrust, fire });
}

function avoidObstacles(sh, move) {
  const inset = (G.state && G.state.inset) || 0;
  const path = m => {
    const legal = legaliseMove(sh, m);
    return integratePath(sh, legal, arena.w, arena.h, arena.prisms, inset);
  };
  /* One turn of lookahead is not enough: a course can be perfectly clear and
     still end with the nose against a prism and no turn rate left to escape.
     Every bot death was one of these. So a candidate only counts as safe if,
     from where it leaves you, some continuation also survives. */
  const survivesNextTurn = p => {
    const end = p[RULES.SUBSTEPS];
    const ghost = { x: end.x, y: end.y, heading: end.heading, speed: end.speed, charge: 0 };
    for (let step = 0; step <= 5; step++) {
      for (const sgn of (step === 0 ? [1] : [1, -1])) {
        for (const slow of [0.45, 1]) {
          const m2 = { heading: end.heading + sgn * step * 0.34,
                       speed: end.speed * slow, thrust: 0.5, fire: false };
          const l2 = legaliseMove(ghost, m2);
          if (integratePath(ghost, l2, arena.w, arena.h, arena.prisms,
                            arenaInset((G.state ? G.state.turn : 0) + 1)).crashAt < 0) return true;
        }
      }
    }
    return false;
  };

  const p0 = path(move);
  if (p0.crashAt < 0 && survivesNextTurn(p0)) return move;

  let firstClear = null, bestAlt = null, bestCrash = -1;
  for (let step = 1; step <= 9; step++) {
    for (const sgn of [1, -1]) {
      for (const slow of [1, 0.55, 0.22]) {     // slowing tightens the turn
        const cand = { ...move, heading: move.heading + sgn * step * 0.28,
                       speed: move.speed * slow, fire: false };
        const pc = path(cand);
        if (pc.crashAt < 0) {
          if (!firstClear) firstClear = cand;            // survives this turn
          if (survivesNextTurn(pc)) return cand;         // ...and the next
        } else if (pc.crashAt > bestCrash) { bestCrash = pc.crashAt; bestAlt = cand; }
      }
    }
  }
  // nothing survives two turns: take one clear turn, else buy the most time
  return firstClear || bestAlt || move;
}

function maybeResolve() {
  if (G.phase !== 'plan') return;
  for (const sh of G.state.ships) {
    if (!sh.alive) continue;
    if (G.bots.has(sh.idx) && G.moves[sh.id] === undefined) G.moves[sh.id] = botOrders(sh);
  }
  const waiting = G.state.ships.filter(s => s.alive && G.moves[s.id] === undefined);
  if (waiting.length) return;
  if (!NET.live) { startResolve(G.moves); return; }
  if (NET.isArbiter()) NET.sendResolve(G.state.turn, G.moves);   // never resolve directly
}

/** Everyone has orders (or the clock ran out): play the turn. */
function startResolve(moves) {
  if (G.phase !== 'plan') return;
  G.phase = 'resolve';
  G.ctx = beginTurn(G.state, moves);
  G.sub = 0;
  dmgAccum = [0, 0, 0, 0]; dmgSince = [0, 0, 0, 0];
  for (const sh of G.state.ships) sh.firing = sh.firedThisTurn;
  committed = false;
  banner('', '');
  syncOrderUI(); renderRoster();
  dirty = true;
}

/** Advance the resolution animation; damage is integrated on fixed substeps. */
function stepResolve(dt) {
  const S = G.ctx.substeps;
  const perSec = S / RULES.TURN_SECONDS;
  const prev = Math.floor(G.sub);
  G.sub = Math.min(S, G.sub + dt * perSec);
  const now = Math.floor(G.sub);

  const msPer = (RULES.TURN_SECONDS * 1000) / S;
  for (let k = prev + 1; k <= now; k++) {
    applySubstep(G.state, G.ctx, k);
    trace(true);                                  // deterministic damage pass
    applyHits(G.state, beamHits, msPer);
    applyCollisions(G.state, G.ctx);
  }
  // a ship that just died throws its explosion here, once
  for (let i = 0; i < G.state.ships.length; i++) {
    const sh = G.state.ships[i];
    if (!sh.alive && !sh.vfxDone) { sh.vfxDone = true; spawnDestruction(sh); }
  }

  // surface the damage that accrued, in readable lumps rather than per-substep
  for (let i = 0; i < G.state.ships.length; i++) {
    const took = G.state.ships[i].tookDamage;
    const delta = took - dmgSince[i];
    if (delta <= 0) continue;
    /* Taking fire rattles your airframe too, but only while the rays are
       actually on you, and far more gently than discharging your own
       capacitor. The impulse is proportional to how hard you are being hit. */
    if (i === G.selfIdx) hitShake = Math.min(0.42, hitShake + delta * 0.055);
    dmgAccum[i] += delta; dmgSince[i] = took;
    if (dmgAccum[i] >= 6) { spawnDamage(i, dmgAccum[i]); dmgAccum[i] = 0; }
  }
  if (now !== prev) renderRoster();
  dirty = true;

  if (G.sub >= S) {
    for (const sh of G.state.ships) sh.firing = false;
    const r = endTurn(G.state);
    renderRoster();
    for (let i = 0; i < G.state.ships.length; i++)
      if (dmgAccum[i] > 0.5) { spawnDamage(i, dmgAccum[i]); dmgAccum[i] = 0; }
    if (r.over) {
      G.phase = 'over';
      G.winner = r.winner;
      banner(r.winner ? (r.winner.idx === G.selfIdx ? 'VICTORY' : 'DEFEATED')
                      : 'MUTUAL DESTRUCTION',
             r.winner ? esc(r.winner.name) + ' HOLDS THE FIELD' : 'NO SURVIVORS');
      showRematch();
    } else {
      beginPlan();
    }
  }
}

function beginPlan() {
  G.phase = 'plan';
  G.moves = {};
  committed = false;
  const sh = selfShip();
  if (sh) { G.aim.heading = sh.heading; G.aim.speed = sh.speed; G.aim.fire = false; }
  G.planEnds = performance.now() + RULES.PLAN_SECONDS * 1000;
  gizSig = '';
  syncOrderUI(); renderRoster();
  flash('TURN ' + (G.state.turn + 1));
  dirty = true;
}

/** A brief, quiet turn announcement. */
let flashT = 0;
function flash(text) {
  const el = $('banner');
  $('bannerT').textContent = text; $('bannerS').textContent = '';
  $('bannerT').style.fontSize = '20px';
  el.style.opacity = 1;
  clearTimeout(flashT);
  flashT = setTimeout(() => { if (G.phase === 'plan') el.style.opacity = 0; }, 900);
}

function banner(t, s) {
  clearTimeout(flashT);
  $('bannerT').textContent = t; $('bannerS').textContent = s;
  $('bannerT').style.fontSize = '';
  $('banner').style.opacity = t ? 1 : 0;
}

/** Offer a rematch once the field is settled. */
function showRematch() {
  const body = document.querySelector('.orders .obody');
  body.innerHTML = '';
  const b = document.createElement('button');
  b.className = 'btn commit'; b.type = 'button'; b.textContent = 'REMATCH';
  b.addEventListener('click', () => location.reload());
  body.appendChild(b);
}

/* ------------------------------------------------------------- the clock */
function tickClock() {
  const el = $('clock');
  if (G.phase !== 'plan') { el.textContent = '--'; el.className = 'clock'; return; }
  const left = Math.max(0, G.planEnds - performance.now()) / 1000;
  el.textContent = left.toFixed(1) + 's';
  el.className = 'clock' + (left < 5 ? ' crit' : left < 10 ? ' urgent' : '');
  if (left <= 0) {
    /* Timeout. In a networked game only the arbiter may declare the turn, so
       every peer resolves the same move set; solo, we declare it ourselves. */
    if (!NET.live) {
      maybeResolve();
      if (G.phase === 'plan') startResolve(G.moves);
    } else if (NET.isArbiter()) {
      // fill the stragglers with "hold last course" and publish the turn;
      // we will start it when our own resolve event comes back
      for (const sh of G.state.ships) if (G.moves[sh.id] === undefined) G.moves[sh.id] = sh.move;
      NET.sendResolve(G.state.turn, G.moves);
      G.planEnds = performance.now() + 3000;      // do not re-fire while it lands
    }
  }
}

/* ================================================================== input */
const COARSE = matchMedia('(hover:none),(pointer:coarse)').matches;
let drag = null;

function startsDrag(ev) { return ev.isPrimary && ev.button === 0 && !drag; }

handle.addEventListener('pointerdown', ev => {
  if (!startsDrag(ev) || committed || G.phase !== 'plan') return;
  ev.preventDefault();
  drag = { pointerId: ev.pointerId };
  handle.setPointerCapture(ev.pointerId);
  wakeGiz();
});
addEventListener('pointermove', ev => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const sh = selfShip(); if (!sh) return;
  const p = s2w(ev.clientX, ev.clientY);
  const dx = p.x - sh.x, dy = p.y - sh.y;
  G.aim.heading = Math.atan2(dy, dx);
  G.aim.speed = clamp(Math.hypot(dx, dy), RULES.SPEED_MIN, maxSpeedFor(G.aim.thrust));
  syncOrderUI(); gizSig = ''; dirty = true;
});
function endDrag(ev) {
  if (!drag || (ev && ev.pointerId !== undefined && ev.pointerId !== drag.pointerId)) return;
  if (ev && handle.hasPointerCapture && handle.hasPointerCapture(drag.pointerId))
    handle.releasePointerCapture(drag.pointerId);
  drag = null;
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);
addEventListener('blur', () => endDrag());
document.addEventListener('visibilitychange', () => endDrag());
canvas.addEventListener('contextmenu', e => { e.preventDefault(); endDrag(); });
gizEl.addEventListener('contextmenu', e => { e.preventDefault(); endDrag(); });

/* ------------------------------------------------------- camera: pan & zoom
   A left-drag on the arena pans; a left *click* (moved under the threshold)
   still points your nose at the spot. Middle button, right button or shift
   always pan. The wheel zooms about the cursor. */
let camDrag = null;
const CLICK_SLOP = 5;                         // css px before a click becomes a drag

function aimAtPoint(clientX, clientY) {
  if (committed || G.phase !== 'plan') return;
  const sh = selfShip(); if (!sh || !sh.alive) return;
  const p = s2w(clientX, clientY);
  G.aim.heading = Math.atan2(p.y - sh.y, p.x - sh.x);
  syncOrderUI(); gizSig = ''; dirty = true; wakeGiz();
}

canvas.addEventListener('pointerdown', ev => {
  if (!ev.isPrimary || camDrag) return;
  const forcePan = ev.button === 1 || ev.button === 2 || ev.shiftKey;
  if (ev.button !== 0 && !forcePan) return;
  camDrag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY,
              lx: ev.clientX, ly: ev.clientY, moved: 0, pan: forcePan };
  canvas.setPointerCapture(ev.pointerId);
  ev.preventDefault();
  wakeGiz();
});
addEventListener('pointermove', ev => {
  if (!camDrag || ev.pointerId !== camDrag.id) return;
  const dx = ev.clientX - camDrag.lx, dy = ev.clientY - camDrag.ly;
  camDrag.lx = ev.clientX; camDrag.ly = ev.clientY;
  camDrag.moved += Math.hypot(dx, dy);
  if (!camDrag.pan && camDrag.moved > CLICK_SLOP) camDrag.pan = true;
  if (camDrag.pan) { panBy(dx, dy); canvas.style.cursor = 'grabbing'; gizSig = ''; }
});
function endCamDrag(ev) {
  if (!camDrag) return;
  if (ev && ev.pointerId !== undefined && ev.pointerId !== camDrag.id) return;
  canvas.style.cursor = '';
  if (canvas.hasPointerCapture && canvas.hasPointerCapture(camDrag.id))
    canvas.releasePointerCapture(camDrag.id);
  if (!camDrag.pan) aimAtPoint(camDrag.x0, camDrag.y0);
  camDrag = null;
}
addEventListener('pointerup', endCamDrag);
addEventListener('pointercancel', endCamDrag);
addEventListener('blur', () => endCamDrag());

canvas.addEventListener('wheel', ev => {
  if (ev.ctrlKey) return;                     // leave browser zoom alone
  ev.preventDefault();
  let d = ev.deltaY;
  if (ev.deltaMode === 1) d *= 16;            // lines
  else if (ev.deltaMode === 2) d *= 380;      // pages
  d = clamp(d, -140, 140);                    // one inertial flick must not slam the limit
  const r = canvas.getBoundingClientRect();
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-d * 0.0022));
  gizSig = '';
  wakeGiz();
}, { passive: false });

/* two-finger pinch on touch */
let pinch = null;
canvas.addEventListener('touchstart', ev => {
  if (ev.touches.length !== 2) { pinch = null; return; }
  const [a, b] = ev.touches;
  pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
}, { passive: true });
canvas.addEventListener('touchmove', ev => {
  if (!pinch || ev.touches.length !== 2) return;
  const [a, b] = ev.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  if (pinch.d > 0) {
    const r = canvas.getBoundingClientRect();
    zoomAt((a.clientX + b.clientX) * 0.5 - r.left, (a.clientY + b.clientY) * 0.5 - r.top, d / pinch.d);
    gizSig = '';
  }
  pinch.d = d;
  ev.preventDefault();
}, { passive: false });
canvas.addEventListener('touchend', () => { pinch = null; }, { passive: true });

/* sliders */
function bindRange(el, get, set) {
  const upd = () => { set(parseFloat(el.value)); syncOrderUI(); gizSig = ''; dirty = true; };
  el.addEventListener('input', upd);
}
bindRange(oThr, () => G.aim.thrust, v => {
  G.aim.thrust = v;
  G.aim.speed = Math.min(G.aim.speed, maxSpeedFor(v));
});
bindRange(oSpd, () => G.aim.speed, v => {
  G.aim.speed = lerp(RULES.SPEED_MIN, maxSpeedFor(G.aim.thrust), v);
});
oFire.addEventListener('click', () => {
  if (oFire.disabled) return;
  G.aim.fire = !G.aim.fire; syncOrderUI(); dirty = true;
});
oCommit.addEventListener('click', commitOrders);

addEventListener('keydown', ev => {
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const k = ev.key.toLowerCase();
  if (k === 'f') { if (!oFire.disabled) { G.aim.fire = !G.aim.fire; syncOrderUI(); dirty = true; } }
  else if (ev.key === 'Enter') commitOrders();
  else if (k === 'h') ui.classList.toggle('hidden');
  else if (k === '0') resetView();
  else return;
  ev.preventDefault();
});

/* the course handle steps aside when you stop touching the scene */
let gizIdle = 0;
function wakeGiz() {
  if (COARSE) return;
  gizEl.classList.remove('idle');
  clearTimeout(gizIdle);
  gizIdle = setTimeout(() => {
    if (!drag && !gizEl.contains(document.activeElement)) gizEl.classList.add('idle');
  }, 7000);
}
['pointermove', 'pointerdown', 'keydown'].forEach(t => addEventListener(t, wakeGiz, { passive: true }));
wakeGiz();

/* ================================================================ netcode */
const NET = {
  live: false,
  isArbiter: () => typeof Net !== 'undefined' && Net.isArbiter(),
  sendMove: (t, m) => { try { Net.sendMove(t, m); } catch (e) { console.warn(e); } },
  sendResolve: (t, m) => { try { Net.sendResolve(t, m); } catch (e) { console.warn(e); } },
};

/* ---------------------------------------------------------------- resync
   A desync in lockstep is normally fatal — there is no authority to fall back
   on. Rather than let the match quietly become two different games, a client
   that notices its fingerprint disagreeing asks the arbiter for the real state
   and adopts it wholesale. It is a visible hiccup instead of a ruined match. */
function serialiseState() {
  const st = G.state;
  return {
    turn: st.turn, inset: st.inset || 0, seed: st.seed,
    prisms: st.arena.prisms.map(p => ({ x: p.x, y: p.y, r: p.r, wdir: p.wdir,
                                        whalf: p.whalf, ior: p.ior, disp: p.disp, spin: p.spin })),
    ships: st.ships.map(s => ({ id: s.id, name: s.name, idx: s.idx, x: s.x, y: s.y,
                                heading: s.heading, speed: s.speed, shield: s.shield,
                                hull: s.hull, charge: s.charge, alive: s.alive, move: s.move })),
  };
}
function adoptState(d) {
  const st = G.state;
  st.turn = d.turn; st.inset = d.inset; st.seed = d.seed;
  st.arena.prisms.length = 0;
  for (const p of d.prisms) st.arena.prisms.push({ ...p });
  for (const sd of d.ships) {
    const sh = st.ships.find(x => x.id === sd.id);
    if (!sh) continue;
    Object.assign(sh, sd, { firing: false, tookDamage: 0, dealtDamage: 0, firedThisTurn: false });
  }
  arena.prisms = st.arena.prisms;
  arena.ships = st.ships;
  desynced = false;
  G.phase = 'resolve';        // beginPlan() will take it from here
  beginPlan();
  banner('', '');
  setStatus('');
  flash('RESYNCED');
}

function reportDesync(why) {
  if (desynced) return;
  desynced = true;
  banner('OUT OF SYNC', why);
  if (!NET.isArbiter()) Net.sendChat(RESYNC_REQ);   // ask the arbiter for the truth
  else banner('OUT OF SYNC', 'A PILOT IS ON A DIFFERENT BUILD');
}

function wireNet() {
  if (typeof Net === 'undefined') return false;

  Net.on('move', ({ turn, peerId, move }) => {
    if (!G.state || turn !== G.state.turn) return;
    const sh = G.state.ships.find(s => s.id === peerId);
    if (!sh) return;

    /* Two cheap consistency checks, riding along with a message we already
       send. `sig` catches a peer on a different build; `h` catches every other
       cause of divergence at the earliest moment it can be observed. */
    if (move.sig && move.sig !== RULES_SIG) {
      reportDesync('DIFFERENT BUILD: ' + move.sig + ' vs ' + RULES_SIG);
    } else if (move.h !== undefined && move.h !== stateHash(G.state)) {
      reportDesync('TURN ' + turn + ' STATE MISMATCH');
    }

    G.moves[sh.id] = move;
    renderRoster();
    if (NET.isArbiter()) maybeResolve();
  });

  Net.on('resolve', ({ turn, moves }) => {
    if (!G.state || turn !== G.state.turn || G.phase !== 'plan') return;
    G.moves = moves;
    startResolve(moves);
  });

  Net.on('chat', ({ text }) => {
    if (text.slice(0, RESYNC_REQ.length) === RESYNC_REQ) {
      if (NET.isArbiter() && G.state) Net.sendChat(RESYNC_ST + JSON.stringify(serialiseState()));
      return;
    }
    if (text.slice(0, RESYNC_ST.length) === RESYNC_ST) {
      if (NET.isArbiter() || !G.state) return;
      try { adoptState(JSON.parse(text.slice(RESYNC_ST.length))); }
      catch (e) { console.warn('resync failed', e); }
    }
  });

  Net.on('status', s => setStatus(s));
  return true;
}

/* ================================================================== lobby */
function setStatus(t, bad) {
  const el = $('lStatus');
  el.textContent = t || '';
  el.className = 'status' + (bad ? ' err' : '');
}
function closeLobby() { lobbyEl.style.display = 'none'; }

$('bSolo').addEventListener('click', () => {
  const name = ($('lName').value || 'PILOT').toUpperCase().slice(0, 12);
  const players = [{ id: 0, name }, { id: 1, name: 'VEGA' }, { id: 2, name: 'ORION' }, { id: 3, name: 'LYRA' }];
  newGame(players, 20260815, 0);
  G.bots = new Set([1, 2, 3]);
  NET.live = false;
  closeLobby();
  beginPlan();
});

let lobbyRoster = [];

/* The match is started explicitly by the arbiter rather than auto-starting at
   two players. Auto-starting meant a third pilot joining a second later would
   build a *different* game — different player list, different seed — and desync
   immediately. The arbiter broadcasts the roster and seed it used, and everyone
   builds the identical match from that one message. */
/* Peer-to-peer lockstep has no authority, so two clients running different
   code will silently drift apart rather than fail. These tags carry a build
   signature and a per-turn state fingerprint so that a mismatch is detected
   and reported instead of quietly ruining the match. */
const START_TAG  = '\u0001START';       // slice by .length, never a literal
const RESYNC_REQ = '\u0001RSQ';
const RESYNC_ST  = '\u0001RST';

/** Fingerprint of the rules this build was compiled with. Any balance change
    alters it, which is exactly the class of skew that desyncs a match. */
const RULES_SIG = (() => {
  const src = JSON.stringify(RULES);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36).toUpperCase();
})();
let desynced = false;
function startMatchFrom(payload) {
  if (G.state) return;                                   // already playing
  if (payload.sig && payload.sig !== RULES_SIG) {
    setStatus('Build mismatch — the host is running a different version of the ' +
              'game (' + payload.sig + ' vs yours ' + RULES_SIG + '). Reload the ' +
              'page to pick up the current build, then rejoin.', true);
    return;
  }
  const players = payload.players.map(p => ({ id: p.id, name: p.name }));
  const selfIdx = players.findIndex(p => p.id === Net.selfId());
  if (selfIdx < 0) { setStatus('This match started without you.', true); return; }
  newGame(players, payload.seed, selfIdx);
  NET.live = true;
  closeLobby();
  beginPlan();
}

function refreshLobby() {
  const n = lobbyRoster.length;
  setStatus(`Room ${Net.room || ''} — ${n}/4 pilot${n === 1 ? '' : 's'}: ` +
            lobbyRoster.map(p => p.name).join(', '));
  const btn = $('bStart');
  if (!btn) return;
  const canStart = Net.isArbiter() && n >= 2 && !G.state;
  btn.style.display = n >= 2 && !G.state ? '' : 'none';
  btn.disabled = !canStart;
  btn.textContent = canStart ? `START MATCH — ${n} PILOTS`
                             : 'WAITING FOR HOST TO START';
}

$('bJoin').addEventListener('click', async () => {
  if (typeof Net === 'undefined') { setStatus('Multiplayer build not loaded — use Practice.', true); return; }
  const name = ($('lName').value || 'PILOT').toUpperCase().slice(0, 12);
  const room = ($('lRoom').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  setStatus('Connecting…');
  $('bJoin').disabled = true;
  try {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const { roster } = await Net.connect({ url, room, name });
    lobbyRoster = roster;
    wireNet();
    Net.on('roster', r => { lobbyRoster = r; refreshLobby(); });
    Net.on('chat', ({ text }) => {
      // the start handshake rides the chat channel so the netcode needs no
      // game-specific message type
      if (text.slice(0, START_TAG.length) !== START_TAG) return;
      try { startMatchFrom(JSON.parse(text.slice(START_TAG.length))); } catch (e) { console.warn(e); }
    });
    setStatus('Connected — build ' + RULES_SIG);
    refreshLobby();
  } catch (e) {
    $('bJoin').disabled = false;
    setStatus('Could not reach the matchmaker: ' + e.message, true);
  }
});

$('bStart').addEventListener('click', () => {
  if (!Net.isArbiter() || G.state) return;
  const players = lobbyRoster
    .slice()
    .sort((a, b) => a.peerId - b.peerId)          // one canonical order for all
    .slice(0, 4)
    .map(p => ({ id: p.peerId, name: p.name }));
  const seed = players.reduce((a, p) => (a * 31 + p.id) >>> 0, 20260815);
  const payload = { players, seed, sig: RULES_SIG };
  Net.sendChat(START_TAG + JSON.stringify(payload));
  startMatchFrom(payload);
});

/* ------------------------------------------------------------- per-frame */
function gameFrame(dt) {
  tickClock();
  /* Nothing in the world moves while orders are being given, so the fire and
     smoke hold their pose too — a drifting plume over a frozen battlefield read
     as a bug. It also lets the accumulator converge, so the planning phase is a
     crisp supersampled still rather than a frame that re-renders forever. */
  if (G.phase === 'resolve' && G.ctx) {
    stepResolve(dt);
    stepVfx(dt);
    if (vfxLoad()) dirty = true;
  }

  /* The view shakes while YOUR ship is discharging: it is your airframe, not
     the camera, so an opponent firing across the map does not rattle you.
     It builds over the first moments of the burn and decays after. */
  const me = selfShip();
  const firing = G.phase === 'resolve' && me && me.alive && me.firing;
  const target = firing ? 1 : 0;
  const rate = firing ? 9.0 : 3.2;
  fireShake += (target - fireShake) * Math.min(1, dt * rate);
  // being hit decays fast: it should stop the instant the beam leaves you
  hitShake *= Math.pow(0.008, dt);
  shakeAmp = Math.min(1.15, fireShake + hitShake);
  if (shakeAmp > 0.0005) dirty = true;
  stepFx(dt);
  drawGizmo();
}

renderRoster();
syncOrderUI();

/* ?solo=1 drops straight into a practice match — used by the render harness
   and handy for showing the game without clicking through the lobby. */
if (new URLSearchParams(location.search).has('solo')) {
  requestAnimationFrame(() => $('bSolo').click());
}
