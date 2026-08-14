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

  const sig = [sh.x, sh.y, sh.heading, sh.speed, m.heading, m.speed, m.thrust, W, H].join(',');
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
  const move = { heading: G.aim.heading, speed: G.aim.speed, thrust: G.aim.thrust, fire: G.aim.fire };
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
  const m = 0.10;
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

  const speed = nearWall < m ? RULES.SPEED_MAX
              : dist > 0.5 ? RULES.SPEED_MAX * 0.85
              : RULES.SPEED_MAX * 0.5;

  // only shoot when the nose will actually be on them
  const fire = charged && off < 0.38 && dist < 1.05;
  return { heading: want, speed, thrust, fire };
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
  // surface the damage that accrued, in readable lumps rather than per-substep
  for (let i = 0; i < G.state.ships.length; i++) {
    const took = G.state.ships[i].tookDamage;
    const delta = took - dmgSince[i];
    if (delta <= 0) continue;
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

/* click the arena to point your nose at a spot */
canvas.addEventListener('pointerdown', ev => {
  if (!startsDrag(ev) || committed || G.phase !== 'plan') return;
  const sh = selfShip(); if (!sh || !sh.alive) return;
  const p = s2w(ev.clientX, ev.clientY);
  G.aim.heading = Math.atan2(p.y - sh.y, p.x - sh.x);
  syncOrderUI(); gizSig = ''; dirty = true; wakeGiz();
});

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

function wireNet() {
  if (typeof Net === 'undefined') return false;
  Net.on('move', ({ turn, peerId, move }) => {
    if (!G.state || turn !== G.state.turn) return;
    const sh = G.state.ships.find(s => s.id === peerId);
    if (!sh) return;
    G.moves[sh.id] = move;
    renderRoster();
    if (NET.isArbiter()) maybeResolve();
  });
  Net.on('resolve', ({ turn, moves }) => {
    if (!G.state || turn !== G.state.turn || G.phase !== 'plan') return;
    G.moves = moves;
    startResolve(moves);
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
const START_TAG = '\u0001START';           // 6 chars; slice by .length, never a literal
function startMatchFrom(payload) {
  if (G.state) return;                                   // already playing
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
  const payload = { players, seed };
  Net.sendChat(START_TAG + JSON.stringify(payload));
  startMatchFrom(payload);
});

/* ------------------------------------------------------------- per-frame */
function gameFrame(dt) {
  tickClock();
  if (G.phase === 'resolve' && G.ctx) stepResolve(dt);
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
