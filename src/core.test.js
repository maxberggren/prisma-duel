/* Tests for the deterministic simulation core.  Run: node src/core.test.js
   The netcode has no authoritative server, so "same inputs => same state" is
   not a nicety here, it is the thing that makes the game possible. */
const C = require('./core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `got ${a}, want ${b}`); }

const PLAYERS = [{ id: 0, name: 'A' }, { id: 1, name: 'B' }, { id: 2, name: 'C' }, { id: 3, name: 'D' }];

/** Play `turns` turns with a scripted, deterministic move generator. */
function playout(seed, turns, moveGen, hitGen) {
  const st = C.makeState(PLAYERS, seed);
  /* This test is about the determinism of the simulation, not about terrain.
     Terrain is fatal now, and a chain where everyone is dead by turn two has
     nothing left to diverge, so the ships fly in clear air. */
  st.arena.prisms.length = 0;
  const hashes = [];
  for (let t = 0; t < turns; t++) {
    const moves = {};
    for (const s of st.ships) moves[s.id] = moveGen(t, s);
    const ctx = C.beginTurn(st, moves);
    const msPer = (C.RULES.TURN_SECONDS * 1000) / ctx.substeps;
    for (let sub = 1; sub <= ctx.substeps; sub++) {
      C.applySubstep(st, ctx, sub);
      if (hitGen) C.applyHits(st, hitGen(st, sub), msPer);
      C.applyCollisions(st, ctx);
    }
    C.endTurn(st);
    hashes.push(C.stateHash(st));
  }
  return { st, hashes };
}

/* A scripted "player" — deterministic, no randomness. It steers back toward
   the middle of the arena, because flying into a wall or a prism is now fatal
   and a script that kills everyone by turn 3 has nothing left to diverge. */
const script = (t, s) => {
  /* Orbit the middle rather than steering into it: four ships all converging on
     one point collide, and dead ships have no divergence left to measure. */
  const toMid = Math.atan2(C.RULES.ARENA_H * 0.5 - s.y, C.RULES.ARENA_W * 0.5 - s.x);
  return {
    heading: toMid + Math.PI * 0.5 + Math.sin(t * 0.7 + s.idx) * 0.25,
    speed: C.RULES.SPEED_MAX * (0.18 + 0.08 * Math.sin(t * 0.4 + s.idx * 1.3)),
    thrust: 0.3 + 0.4 * ((t + s.idx) % 3) / 2,
    fire: (t + s.idx) % 4 === 0,
  };
};
// a scripted laser: ship i always dwells on ship (i+1)
const hits = (st, sub) => st.ships.filter(s => s.alive && s.firedThisTurn)
  .map(s => ({ srcIdx: s.idx, shipIdx: (s.idx + 1) % st.ships.length, power: 0.11 }));

console.log('\ndeterminism');
{
  const a = playout(9001, 12, script, hits);
  const b = playout(9001, 12, script, hits);
  ok('identical seed + moves => identical hash chain',
     a.hashes.join(',') === b.hashes.join(','));
  ok('the state actually evolves (hashes are not constant)',
     new Set(a.hashes).size > 6, `${new Set(a.hashes).size} distinct`);

  /* The playouts above fly in cleared air, so the arena seed cannot show up in
     their hashes. Test what the seed actually governs, directly. */
  const arenaA = C.makeState(PLAYERS, 9001).arena, arenaB = C.makeState(PLAYERS, 9002).arena;
  ok('a different arena seed gives a different arena',
     JSON.stringify(arenaA.prisms) !== JSON.stringify(arenaB.prisms));
  ok('...and the same seed gives the same arena',
     JSON.stringify(arenaA.prisms) === JSON.stringify(C.makeState(PLAYERS, 9001).arena.prisms));

  const d = playout(9001, 12, (t, s) => {
    const m = script(t, s);
    if (t === 5 && s.idx === 2) m.heading += 0.01;   // one tiny input change
    return m;
  }, hits);
  ok('a single 0.01 rad input change diverges the chain',
     a.hashes.join(',') !== d.hashes.join(','));
  ok('...and only from the turn it was made', a.hashes[4] === d.hashes[4] && a.hashes[5] !== d.hashes[5]);
}

console.log('\nmove legalisation');
{
  const st = C.makeState(PLAYERS, 1);
  const s = st.ships[0];
  s.heading = 0; s.speed = 0.04; s.charge = 0;
  const m = C.legaliseMove(s, { heading: Math.PI, speed: 99, thrust: 1, fire: true });
  ok('turn rate is clamped', Math.abs(C.angDelta(0, m.heading)) <= C.turnRateFor(1, 0.04) + 1e-9);
  ok('speed is clamped to the thrust envelope', m.speed <= C.maxSpeedFor(1) + 1e-9);
  ok('acceleration is clamped', m.speed <= 0.04 + C.RULES.ACCEL + 1e-9);
  ok('cannot fire without charge', m.fire === false);
  s.charge = 1;
  ok('can fire with charge', C.legaliseMove(s, { heading: 0, speed: 0.04, thrust: 0.5, fire: true }).fire === true);
  const slow = C.legaliseMove(s, { heading: 0, speed: 0, thrust: 0.5, fire: false });
  ok('a ship cannot stop', slow.speed >= C.RULES.SPEED_MIN - 1e-9);
}

console.log('\nagility / thrust tradeoff');
{
  ok('more thrust => more top speed', C.maxSpeedFor(1) > C.maxSpeedFor(0));
  ok('more thrust => tighter turn', C.turnRateFor(1, 0.02) > C.turnRateFor(0, 0.02));
  ok('more speed => wider turn', C.turnRateFor(1, 0.085) < C.turnRateFor(1, 0.01));
}

console.log('\ndamage model');
{
  const st = C.makeState(PLAYERS, 3);
  const ctx = C.beginTurn(st, Object.fromEntries(st.ships.map(s => [s.id, s.move])));
  const msPer = (C.RULES.TURN_SECONDS * 1000) / ctx.substeps;
  const before = st.ships[1].shield;
  C.applyHits(st, [{ srcIdx: 0, shipIdx: 1, power: 1 }], msPer);
  const oneStep = before - st.ships[1].shield;
  ok('a single substep of full-power dwell does modest damage', oneStep > 0 && oneStep < 5, `${oneStep.toFixed(2)}`);

  /* A perfect full-turn lock should strip the shield and bite hull — enough to
     be decisive over two turns, not enough to delete a ship outright. At the
     old rate the opening volley of a four-way fight killed everyone at once. */
  const st2 = C.makeState(PLAYERS, 3);
  for (let i = 0; i < ctx.substeps; i++) C.applyHits(st2, [{ srcIdx: 0, shipIdx: 1, power: 1 }], msPer);
  const total = (C.RULES.SHIELD_MAX - st2.ships[1].shield) + (C.RULES.HULL_MAX - st2.ships[1].hull);
  const cap = C.RULES.SHIELD_MAX + C.RULES.HULL_MAX;
  ok('a full-turn lock strips the shield', total > C.RULES.SHIELD_MAX, `${total.toFixed(0)} damage`);
  ok('but does not delete a ship outright', total < cap * 0.85, `${total.toFixed(0)} of ${cap}`);
  ok('shield absorbs before hull', st2.ships[1].shield === 0 && st2.ships[1].hull < C.RULES.HULL_MAX);

  const st3 = C.makeState(PLAYERS, 3);
  for (let i = 0; i < 400; i++) C.applyHits(st3, [{ srcIdx: 0, shipIdx: 1, power: 1 }], msPer);
  ok('a destroyed ship is marked dead and clamps at zero',
     st3.ships[1].alive === false && st3.ships[1].hull === 0);
}

console.log('\ncharge economy');
{
  const st = C.makeState(PLAYERS, 4);
  const s = st.ships[0];
  s.charge = 0;
  st.ships.forEach(x => { x.move.thrust = 1; x.firedThisTurn = false; });
  C.endTurn(st);
  eq('full thrust => no recharge', +s.charge.toFixed(6), 0);
  st.ships.forEach(x => { x.move.thrust = 0; });
  C.endTurn(st);
  eq('zero thrust => full recharge rate', +s.charge.toFixed(6), +C.RULES.CHARGE_RATE.toFixed(6));
  ok('charge saturates at max', (() => {
    for (let i = 0; i < 20; i++) C.endTurn(st);
    return s.charge === C.RULES.CHARGE_MAX;
  })());
}

console.log('\narena containment');
{
  // fly everyone at the wall at full speed for many turns; nobody may escape
  const st = C.makeState(PLAYERS, 7);
  for (let t = 0; t < 40; t++) {
    const moves = {};
    for (const s of st.ships) {
      const toMid = Math.atan2(C.RULES.ARENA_H * 0.5 - s.y, C.RULES.ARENA_W * 0.5 - s.x);
      moves[s.id] = { heading: toMid, speed: C.RULES.SPEED_MAX * 0.5, thrust: 1, fire: false };
    }
    const ctx = C.beginTurn(st, moves);
    for (let sub = 1; sub <= ctx.substeps; sub++) C.applySubstep(st, ctx, sub);
    C.endTurn(st);
  }
  const inside = st.ships.every(s =>
    s.x >= 0 && s.x <= st.arena.w && s.y >= 0 && s.y <= st.arena.h);
  ok('no ship escapes the arena over 40 turns', inside,
     st.ships.map(s => `(${s.x.toFixed(2)},${s.y.toFixed(2)})`).join(' '));
}

console.log('\ninvariants under the closing arena');
{
  /* Two constraints act on a ship at once — the mirrored walls (which close in
     over the match) and the solid prisms. Settling them in the wrong order used
     to shove a ship squeezed between the two straight through the wall, and a
     ship that ends up inside a prism fires from a muzzle buried in glass. */
  const MUZ = C.RULES.HULL_R * 1.35;
  let outside = 0, muzzleIn = 0, samples = 0, worst = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const st = C.makeState(PLAYERS, seed * 131);
    for (let t = 0; t < 30; t++) {
      const moves = {};
      for (const s of st.ships) {
        // steer toward the middle: flying into the wall is now fatal, and a
        // dead ship stops exercising the invariant
        const toMid = Math.atan2(C.RULES.ARENA_H * 0.5 - s.y, C.RULES.ARENA_W * 0.5 - s.x);
        moves[s.id] = { heading: toMid + 0.5 * Math.sin(t * 2.3 + s.idx),
                        speed: C.RULES.SPEED_MAX * 0.5, thrust: 1, fire: false };
      }
      const ctx = C.beginTurn(st, moves);
      for (let k = 1; k <= ctx.substeps; k++) {
        C.applySubstep(st, ctx, k);
        const IN = C.arenaInset(st.turn), R = C.RULES.HULL_R;
        for (const s of st.ships) {
          if (!s.alive) continue;      // a wreck may lie wherever it fell
          samples++;
          const out = Math.max(IN + R - s.x, s.x - (st.arena.w - IN - R),
                               IN + R - s.y, s.y - (st.arena.h - IN - R));
          if (out > 1e-6) { outside++; worst = Math.max(worst, out); }
          const mx = s.x + Math.cos(s.heading) * MUZ, my = s.y + Math.sin(s.heading) * MUZ;
          for (const pr of st.arena.prisms) if (C.prismSD(pr, mx, my) < 0) muzzleIn++;
        }
      }
      C.endTurn(st);
    }
  }
  ok(`no ship escapes the closing walls (${samples.toLocaleString()} samples)`,
     outside === 0, `${outside} escapes, worst ${worst.toExponential(2)}`);
  ok('no muzzle is ever inside a prism', muzzleIn === 0, `${muzzleIn} occurrences`);
  ok('the closed arena stays larger than a prism',
     (C.RULES.ARENA_H - 2 * C.RULES.RING_MAX) > 0.30);
}

console.log('\ncollisions are fatal');
{
  // fly straight at the left wall from the middle of the field
  const st = C.makeState(PLAYERS, 5150);
  const s0 = st.ships[0];
  // close enough that one turn at full speed reaches the wall, and already
  // at speed so acceleration clamping does not shorten the run
  s0.x = 0.30; s0.y = C.RULES.ARENA_H * 0.5; s0.heading = Math.PI; s0.speed = C.RULES.SPEED_MAX;
  const ctx = C.beginTurn(st, { [s0.id]: { heading: Math.PI, speed: C.RULES.SPEED_MAX, thrust: 1, fire: false } });
  ok('a course into the wall is flagged before the turn runs', ctx.plan[0].crashAt > 0);
  for (let k = 1; k <= ctx.substeps; k++) C.applySubstep(st, ctx, k);
  ok('and the ship is destroyed by it', !s0.alive);
  ok('leaving wreckage', st.debris.length > 0);
  ok('the wreck stops at the wall, not through it',
     s0.x >= C.RULES.MUZZLE_CLEAR - 1e-9);

  // and into a prism
  const st2 = C.makeState(PLAYERS, 5150);
  const s1 = st2.ships[0], pr = st2.arena.prisms[0];
  s1.x = pr.x - 0.30; s1.y = pr.y; s1.heading = 0; s1.speed = C.RULES.SPEED_MAX;
  const ctx2 = C.beginTurn(st2, { [s1.id]: { heading: 0, speed: C.RULES.SPEED_MAX, thrust: 1, fire: false } });
  for (let k = 1; k <= ctx2.substeps; k++) C.applySubstep(st2, ctx2, k);
  ok('flying into a prism destroys the ship', !s1.alive);

  // a ship that stays clear is untouched
  const st3 = C.makeState(PLAYERS, 5150);
  const s2 = st3.ships[0];
  s2.x = C.RULES.ARENA_W * 0.5; s2.y = C.RULES.ARENA_H * 0.5; s2.speed = C.RULES.SPEED_MIN;
  const clear = st3.arena.prisms.every(p => C.prismSD(p, s2.x, s2.y) > 0.4);
  const ctx3 = C.beginTurn(st3, { [s2.id]: { heading: s2.heading, speed: C.RULES.SPEED_MIN, thrust: 0, fire: false } });
  for (let k = 1; k <= ctx3.substeps; k++) C.applySubstep(st3, ctx3, k);
  ok('a ship in open space is not harmed', !clear || s2.alive);
}

console.log('\ntimeout behaviour');
{
  const st = C.makeState(PLAYERS, 11);
  st.ships[0].move = { heading: 1.0, speed: 0.05, fire: false, thrust: 0.5 };
  const before = { ...st.ships[0].move };
  // omit ship 0 from the move set entirely, as a timeout would
  const moves = {}; for (let i = 1; i < 4; i++) moves[st.ships[i].id] = st.ships[i].move;
  const ctx = C.beginTurn(st, moves);
  ok('a timed-out ship holds its last course',
     Math.abs(st.ships[0].move.heading - before.heading) < 1e-9 &&
     Math.abs(st.ships[0].move.speed - before.speed) < 1e-9);
  ok('and still gets a trajectory', ctx.plan[0].path.length === C.RULES.SUBSTEPS + 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
