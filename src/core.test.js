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

// a scripted "player" — deterministic, no randomness
const script = (t, s) => ({
  heading: s.heading + Math.sin(t * 0.7 + s.idx) * 0.6,
  speed: 0.04 + 0.03 * Math.sin(t * 0.4 + s.idx * 1.3),
  thrust: 0.3 + 0.4 * ((t + s.idx) % 3) / 2,
  fire: (t + s.idx) % 4 === 0,
});
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

  const c = playout(9002, 12, script, hits);
  ok('a different arena seed diverges', a.hashes.join(',') !== c.hashes.join(','));

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

  // a full turn of uninterrupted full-power dwell should be lethal-ish
  const st2 = C.makeState(PLAYERS, 3);
  for (let i = 0; i < ctx.substeps; i++) C.applyHits(st2, [{ srcIdx: 0, shipIdx: 1, power: 1 }], msPer);
  const total = (C.RULES.SHIELD_MAX - st2.ships[1].shield) + (C.RULES.HULL_MAX - st2.ships[1].hull);
  ok('a full-turn lock is decisive', total > 150, `${total.toFixed(0)} damage`);
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
    for (const s of st.ships) moves[s.id] = { heading: 0.3, speed: C.RULES.SPEED_MAX, thrust: 1, fire: false };
    const ctx = C.beginTurn(st, moves);
    for (let sub = 1; sub <= ctx.substeps; sub++) C.applySubstep(st, ctx, sub);
    C.endTurn(st);
  }
  const inside = st.ships.every(s =>
    s.x >= 0 && s.x <= st.arena.w && s.y >= 0 && s.y <= st.arena.h);
  ok('no ship escapes the arena over 40 turns', inside,
     st.ships.map(s => `(${s.x.toFixed(2)},${s.y.toFixed(2)})`).join(' '));
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
