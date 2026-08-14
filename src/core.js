/* ============================================================================
   PRISMA DUEL — deterministic simulation core
   ----------------------------------------------------------------------------
   This module is the authority on game rules. It is pure: no DOM, no GL, no
   wall-clock, no Math.random. Given the same state and the same move set it
   MUST produce byte-identical results on every peer, because the netcode is
   lockstep peer-to-peer with no authoritative server.

   Determinism rules observed here:
     - no Math.random (all variation comes from the seeded PRNG below)
     - no Date.now / performance.now
     - no iteration over object key order that could differ
     - integer substep counts, never wall-clock deltas
   ========================================================================== */

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
/** shortest signed angle from a to b */
const angDelta = (a, b) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/* --------------------------------------------------------------- constants */
const RULES = {
  ARENA_W: 1.60,            // world units (1 unit = viewport height at fit)
  ARENA_H: 0.90,
  SUBSTEPS: 96,             // fixed per turn — the source of determinism
  TURN_SECONDS: 4.0,        // real seconds a resolution animation takes
  PLAN_SECONDS: 25,         // planning window before the arbiter forces the turn

  SPEED_MAX: 0.085,         // world units per turn at full thrust
  SPEED_MIN: 0.010,         // ships are aircraft: they cannot stop
  ACCEL: 0.030,             // max change in commanded speed per turn
  TURN_RATE: 1.15,          // radians per turn at full thrust, low speed
  TURN_RATE_SPEED_PENALTY: 0.55,  // fraction of agility lost at max speed

  SHIELD_MAX: 100,
  HULL_MAX: 100,
  SHIELD_REGEN: 6,          // per turn, only while not firing
  /* Damage is per millisecond of dwell, which is what makes a graze cheap and
     a sustained lock lethal. One turn is TURN_SECONDS*1000 ms of exposure at
     most, so a perfect full-turn lock is fatal and a clip costs a few points. */
  DPS_MS: 0.052,

  CHARGE_MAX: 1,
  CHARGE_RATE: 0.34,        // per turn at zero thrust allocation
  FIRE_COST: 1,

  HULL_R: 0.021,            // collision/hit radius
  COLLIDE_DMG: 26,
};

/* ------------------------------------------------------------ seeded PRNG
   Used only for arena generation, never during simulation. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------------------------------------- the arena */
function makeArena(seed) {
  const rnd = mulberry32(seed);
  const prisms = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    // spread them across the middle so they matter to most sight lines
    const t = (i + 0.5) / n;
    prisms.push({
      x: RULES.ARENA_W * (0.22 + 0.56 * t) + (rnd() - 0.5) * 0.10,
      y: RULES.ARENA_H * (0.30 + 0.40 * rnd()),
      r: 0.115 + rnd() * 0.075,
      wdir: rnd() * TAU,
      whalf: 0.55 + rnd() * 0.55,
      ior: 1.34 + rnd() * 0.10,
      disp: 0.045 + rnd() * 0.030,
      spin: (rnd() - 0.5) * 0.06,     // radians per turn; slow, so plans hold
    });
  }
  return { prisms, w: RULES.ARENA_W, h: RULES.ARENA_H };
}

/* ---------------------------------------------------------------- the ship */
function makeShip(id, name, i, n) {
  // start on a ring facing the centre, so nobody begins with a free shot
  const a = (i / Math.max(1, n)) * TAU + Math.PI * 0.25;
  const cx = RULES.ARENA_W * 0.5, cy = RULES.ARENA_H * 0.5;
  const R = Math.min(RULES.ARENA_W, RULES.ARENA_H) * 0.36;
  return {
    id, name, idx: i,
    x: cx + Math.cos(a) * R * (RULES.ARENA_W / RULES.ARENA_H) * 0.62,
    y: cy + Math.sin(a) * R,
    heading: a + Math.PI,
    speed: RULES.SPEED_MAX * 0.45,
    shield: RULES.SHIELD_MAX,
    hull: RULES.HULL_MAX,
    charge: RULES.CHARGE_MAX,
    alive: true,
    // last committed move, reused when a player times out
    move: { heading: a + Math.PI, speed: RULES.SPEED_MAX * 0.45, fire: false, thrust: 0.5 },
    firedThisTurn: false,
    tookDamage: 0,
    dealtDamage: 0,
  };
}

function makeState(players, seed) {
  const n = players.length;
  return {
    seed,
    turn: 0,
    arena: makeArena(seed),
    ships: players.map((p, i) => makeShip(p.id, p.name, i, n)),
    log: [],
  };
}

/* ------------------------------------------------- per-ship derived limits */
function maxSpeedFor(thrust) {
  return lerp(RULES.SPEED_MAX * 0.42, RULES.SPEED_MAX, clamp(thrust, 0, 1));
}
function turnRateFor(thrust, speed) {
  const sN = clamp(speed / RULES.SPEED_MAX, 0, 1);
  const agility = lerp(0.55, 1.0, clamp(thrust, 0, 1));
  return RULES.TURN_RATE * agility * (1 - RULES.TURN_RATE_SPEED_PENALTY * sN);
}
/** Clamp a raw player intent into what the ship can physically do this turn. */
function legaliseMove(ship, move) {
  const thrust = clamp(move.thrust, 0, 1);
  const maxS = maxSpeedFor(thrust);
  const wantS = clamp(move.speed, RULES.SPEED_MIN, maxS);
  const speed = clamp(wantS, ship.speed - RULES.ACCEL, ship.speed + RULES.ACCEL);
  const rate = turnRateFor(thrust, (ship.speed + speed) * 0.5);
  const d = angDelta(ship.heading, move.heading);
  const heading = ship.heading + clamp(d, -rate, rate);
  const canFire = ship.charge >= RULES.FIRE_COST - 1e-9;
  return { heading, speed, thrust, fire: !!move.fire && canFire };
}

/* ============================================================================
   Turn resolution.

   `traceFn(state, sub)` is injected by the host so the core stays pure: it
   receives the mutated state at substep `sub` and must return an array of
   { shipIdx, power } hits for that substep. The host implements it with the
   spectral ray tracer. Damage is integrated as power x milliseconds, which is
   what makes dwell time the currency of the game.
   ========================================================================== */
function beginTurn(state, movesById) {
  const S = RULES.SUBSTEPS;
  const dt = 1 / S;
  const R = RULES.HULL_R;
  const plan = [];

  for (const ship of state.ships) {
    const raw = movesById[ship.id] || ship.move;   // timeout => hold last course
    const m = ship.alive
      ? legaliseMove(ship, raw)
      : { heading: ship.heading, speed: 0, thrust: 0, fire: false };
    ship.move = { heading: raw.heading, speed: raw.speed, fire: !!raw.fire, thrust: raw.thrust };
    ship.firedThisTurn = m.fire;
    ship.tookDamage = 0;
    ship.dealtDamage = 0;
    if (m.fire) ship.charge -= RULES.FIRE_COST;

    /* Precompute the whole trajectory once. Every peer walks the same fixed
       number of substeps in the same order, so the path is bit-identical
       everywhere; reading it back is then O(1) per substep. Bounces off the
       mirrored arena walls are baked in here. */
    const path = new Array(S + 1);
    let x = ship.x, y = ship.y;
    const dh = angDelta(ship.heading, m.heading);
    for (let k = 0; k <= S; k++) {
      const t = k / S;
      const hk = ship.heading + dh * t;
      const sk = lerp(ship.speed, m.speed, t);
      path[k] = { x, y, heading: hk, speed: sk };
      if (k < S) {
        x += Math.cos(hk) * sk * dt;
        y += Math.sin(hk) * sk * dt;
        if (x < R) { x = R + (R - x); }
        if (x > state.arena.w - R) { x = (state.arena.w - R) - (x - (state.arena.w - R)); }
        if (y < R) { y = R + (R - y); }
        if (y > state.arena.h - R) { y = (state.arena.h - R) - (y - (state.arena.h - R)); }
      }
    }
    plan.push({ ship, path, fire: m.fire, thrust: m.thrust, hEnd: m.heading, sEnd: m.speed });
  }
  return { plan, sub: 0, substeps: S, done: false, collided: new Set() };
}

/** Advance the ships to substep `sub` (0..SUBSTEPS) by reading the plan. */
function applySubstep(state, turnCtx, sub) {
  const S = turnCtx.substeps;
  const k = clamp(sub | 0, 0, S);
  for (const p of turnCtx.plan) {
    const sh = p.ship;
    if (!sh.alive) continue;
    const n = p.path[k];
    sh.x = n.x; sh.y = n.y; sh.heading = n.heading; sh.speed = n.speed;
  }
  for (const pr of state.arena.prisms) pr.wdir += pr.spin / S;
}

/** Apply one substep's worth of laser dwell. */
function applyHits(state, hits, msPerSubstep) {
  for (const h of hits) {
    const sh = state.ships[h.shipIdx];
    if (!sh || !sh.alive) continue;
    let dmg = h.power * msPerSubstep * RULES.DPS_MS;
    if (dmg <= 0) continue;
    const src = state.ships[h.srcIdx];
    if (src) src.dealtDamage += dmg;
    sh.tookDamage += dmg;
    const absorbed = Math.min(sh.shield, dmg);
    sh.shield -= absorbed;
    dmg -= absorbed;
    if (dmg > 0) sh.hull -= dmg;
    if (sh.hull <= 0) { sh.hull = 0; sh.alive = false; }
  }
}

/** Ship-to-ship collision, checked once per substep. */
function applyCollisions(state, turnCtx) {
  const s = state.ships;
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      if (!s[i].alive || !s[j].alive) continue;
      const key = i * 8 + j;
      if (turnCtx.collided.has(key)) continue;      // once per pair per turn
      const dx = s[j].x - s[i].x, dy = s[j].y - s[i].y;
      if (Math.hypot(dx, dy) >= RULES.HULL_R * 2) continue;
      turnCtx.collided.add(key);
      /* Positions are not adjusted: they come from the precomputed path, which
         is what keeps peers bit-identical. The pair simply cannot be hurt by
         the same collision twice. */
      for (const sh of [s[i], s[j]]) {
        let dmg = RULES.COLLIDE_DMG;
        const a = Math.min(sh.shield, dmg); sh.shield -= a; dmg -= a;
        if (dmg > 0) sh.hull -= dmg;
        if (sh.hull <= 0) { sh.hull = 0; sh.alive = false; }
      }
    }
  }
}

/** Close out the turn: regen, charge, win check. */
function endTurn(state) {
  for (const sh of state.ships) {
    if (!sh.alive) continue;
    if (!sh.firedThisTurn) sh.shield = Math.min(RULES.SHIELD_MAX, sh.shield + RULES.SHIELD_REGEN);
    const thrust = clamp(sh.move.thrust, 0, 1);
    sh.charge = Math.min(RULES.CHARGE_MAX, sh.charge + RULES.CHARGE_RATE * (1 - thrust));
  }
  state.turn++;
  const alive = state.ships.filter(s => s.alive);
  return alive.length <= 1 ? { over: true, winner: alive[0] || null } : { over: false };
}

/** A cheap state fingerprint, for detecting peer desync. */
function stateHash(state) {
  let h = 2166136261 >>> 0;
  const push = v => {
    const n = Math.round(v * 1e6) | 0;
    h ^= n & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (n >>> 8) & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (n >>> 16) & 0xff; h = Math.imul(h, 16777619) >>> 0;
  };
  push(state.turn);
  for (const s of state.ships) {
    push(s.x); push(s.y); push(s.heading); push(s.speed);
    push(s.shield); push(s.hull); push(s.charge); push(s.alive ? 1 : 0);
  }
  for (const p of state.arena.prisms) push(p.wdir);
  return h >>> 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RULES, TAU, clamp, lerp, angDelta, mulberry32, makeArena, makeShip,
                     makeState, legaliseMove, maxSpeedFor, turnRateFor, beginTurn,
                     applySubstep, applyHits, applyCollisions, endTurn, stateHash };
}
