#!/usr/bin/env node
// Regression checks for the integrator against the published orbit catalogues.
//   node scripts/test-physics.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = path.join(__dirname, '..', 'app');
const Physics = require(path.join(APP, 'physics.js'));
const CLASSICS = require(path.join(APP, 'classics.js'));
const loadData = (file, key) => {
  const window = {};
  new Function('window', fs.readFileSync(path.join(APP, file), 'utf8'))(window);
  return window[key].split('\n').map((l) => l.split(','));
};

let failures = 0;
function check(name, fn) {
  const t0 = Date.now();
  try { const msg = fn(); console.log(`✓ ${name}  ${msg || ''}  (${Date.now() - t0} ms)`); }
  catch (e) { failures++; console.log(`✗ ${name}\n  ${e.message}`); }
}
async function checkAsync(name, fn) {
  const t0 = Date.now();
  try { const msg = await fn(); console.log(`✓ ${name}  ${msg || ''}  (${Date.now() - t0} ms)`); }
  catch (e) { failures++; console.log(`✗ ${name}\n  ${e.message}`); }
}

check('free-fall orbits come to rest at T/2 (every 50th i.c.)', () => {
  const rows = loadData('orbits-data.js', 'ORBIT_DATA');
  assert.strictEqual(rows.length, 24582);
  let worst = 0, n = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const [x, y, T] = rows[i].map(Number);
    const o = Physics.periodicOrbit(x, y, T, 800);
    worst = Math.max(worst, o.vHalf); n++;
  }
  assert(worst < 1e-2, `worst |v(T/2)| = ${worst}`);
  return `${n} orbits, worst |v(T/2)| = ${worst.toExponential(1)}`;
});

check('free-fall T* matches T|E|^(3/2)', () => {
  const rows = loadData('orbits-data.js', 'ORBIT_DATA');
  for (let i = 0; i < rows.length; i += 997) {
    const [x, y, T, Ts] = rows[i].map(Number);
    const E = Physics.energy(Physics.freeFallState(x, y), [1, 1, 1]);
    assert(Math.abs(T * Math.abs(E) ** 1.5 - Ts) < 1e-6 * Ts, `i.c. ${i + 1}`);
  }
});

check('Li & Liao orbits return to their initial state after T (every 10th)', () => {
  const rows = loadData('liao-data.js', 'LIAO_DATA');
  assert.strictEqual(rows.length, 2044);
  let worst = 0;
  for (let i = 0; i < rows.length; i += 10) {
    const [, m3, v1, v2, T] = rows[i].map(Number);
    const s = [-1, 0, 1, 0, 0, 0, v1, v2, v1, v2, -2 * v1 / m3, -2 * v2 / m3];
    worst = Math.max(worst, Physics.closedOrbit(s, [1, 1, m3], T, 500, true).returnDist);
  }
  assert(worst < 1e-3, `worst return distance = ${worst}`);
  return `worst return distance = ${worst.toExponential(1)}`;
});

check('classic gallery orbits close', () => {
  let worst = 0;
  for (const c of CLASSICS) worst = Math.max(worst, Physics.closedOrbit(c.s, [1, 1, 1], c.T, 1000).returnDist);
  assert(worst < 0.05, `worst return distance = ${worst}`);
  return `${CLASSICS.length} orbits, worst return distance = ${worst.toExponential(1)}`;
});

check('energy is conserved through a near-collision (free-fall i.c. 5001)', () => {
  const rows = loadData('orbits-data.js', 'ORBIT_DATA');
  const [x, y, T] = rows[5000].map(Number);
  const s0 = Physics.freeFallState(x, y), m = [1, 1, 1];
  const r = Physics.integrateAR(s0, m, T / 2);
  const dE = Math.abs(Physics.energy(r.ss[r.ss.length - 1], m) - Physics.energy(s0, m));
  assert(dE < 1e-8, `|ΔE| = ${dE}`);
  return `|ΔE| = ${dE.toExponential(1)}`;
});

// ---------- braid topology ----------
const Braid = require(path.join(APP, 'braid.js'));
const closedT = (c) => Physics.closedOrbit(c.s, [1, 1, 1], c.T, 2000).T;

check('figure-eight braid is (σ1 σ2⁻¹)³, the golden braid cubed', () => {
  const c = CLASSICS[0];
  const r = Braid.analyze(c.s, [1, 1, 1], closedT(c), 'closed');
  assert.strictEqual(Braid.braidString(r.reduced), 'a B a B a B');
  assert.strictEqual(r.inv.trace, 18n);
  assert.strictEqual(r.syz.map((z) => z.mid + 1).join(''), '123123');
  assert(r.consistent);
  return `trace 18, log λ = ${r.inv.logLambda.toFixed(4)}`;
});

check('Lagrange is a pure rotation (periodic); Broucke A1 is reducible', () => {
  const lag = Braid.analyze(CLASSICS[1].s, [1, 1, 1], closedT(CLASSICS[1]), 'closed');
  assert.strictEqual(lag.inv.type, 'periodic');
  assert.strictEqual(Math.abs(lag.inv.expSum), 6); // one full twist Δ²
  const br = CLASSICS.find((c) => c.name === 'Broucke A1');
  assert.strictEqual(Braid.analyze(br.s, [1, 1, 1], closedT(br), 'closed').inv.type, 'reducible');
});

check('braid trace equals the free-group-word trace via Γ(2) (every 25th Li & Liao orbit)', () => {
  // independent route: F2 word on the shape sphere, a ↦ σ1², b ↦ σ2⁻² in PSL(2,Z)
  const f2trace = (w) => {
    let a = 1n, b = 0n, c = 0n, d = 1n;
    for (const ch of w) {
      const e = ch === ch.toLowerCase() ? 1n : -1n;
      if (ch.toLowerCase() === 'a') { const k = 2n * e; b += a * k; d += c * k; } else { const k = -2n * e; a -= b * k; c -= d * k; }
    }
    const t = a + d; return t < 0n ? -t : t;
  };
  const rows = loadData('liao-data.js', 'LIAO_DATA');
  let n = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const [, m3, v1, v2, T] = rows[i].map(Number);
    const s = [-1, 0, 1, 0, 0, 0, v1, v2, v1, v2, -2 * v1 / m3, -2 * v2 / m3];
    const r = Braid.analyze(s, [1, 1, m3], T, 'closed');
    assert(r.consistent, `projection-dependent invariants for row ${i}`);
    assert.strictEqual(f2trace(Braid.f2Word(r.syz, 0, 1, false)), r.inv.trace, `row ${i}`);
    n++;
  }
  return `${n} orbits`;
});

(async () => {
  const Lifetime = require(path.join(APP, 'lifetime.js'));
  await checkAsync('monodromy exponent matches the published free-fall Lyapunov exponents (every 1000th i.c.)', async () => {
    const rows = loadData('orbits-data.js', 'ORBIT_DATA');
    const out = [];
    for (let i = 0; i < rows.length; i += 1000) {
      const [x, y, T, , lyap] = rows[i].map(Number);
      const s = Physics.freeFallState(x, y);
      if (Lifetime.closestApproach(s, [1, 1, 1], T, 'freefall') < Lifetime.RMIN_RELIABLE) continue; // λ_p flagged unreliable
      const lp = await Lifetime.lyapunov(Lifetime.reference(s, [1, 1, 1], T, 'freefall'), [1, 1, 1]);
      assert(Math.abs(lp - lyap) < 0.01 * lyap, `i.c. ${i}: λ_p = ${lp}, published ${lyap}`);
      out.push(lp);
    }
    return `${out.length} orbits`;
  });
  await checkAsync('Newton refinement removes the spurious instability of Broucke A1 (published i.c. closes to 10⁻²)', async () => {
    const c = CLASSICS.find((x) => x.name === 'Broucke A1');
    const r = await Lifetime.refine(c.s, [1, 1, 1], closedT(c));
    assert(r.closure < 1e-10, `closure ${r.closure}`);
    const lp = Lifetime.lambdaOf(r.M);
    assert(lp < 0.05, `λ_p = ${lp} on the refined orbit`);
    // a sheared, linearly stable Li & Liao orbit (m₃ = 0.5): finite-difference error must not split its unit eigenvalues
    const [, m3, v1, v2, T] = loadData('liao-data.js', 'LIAO_DATA')[728].map(Number);
    const q = await Lifetime.refine([-1, 0, 1, 0, 0, 0, v1, v2, v1, v2, -2 * v1 / m3, -2 * v2 / m3], [1, 1, m3], T);
    assert(Lifetime.lambdaOf(q.M) < 0.05, `I.A 34 (m₃ = 0.5): λ_p = ${Lifetime.lambdaOf(q.M)}`);
    return `closure ${r.closure0.toExponential(1)} → ${r.closure.toExponential(1)}, λ_p = ${lp.toFixed(3)}`;
  });
  await checkAsync('form lifetime follows ln(1/ε)/λ_p (Li & Liao I.A 6, m₃ = 0.5); figure-eight is stable', async () => {
    const [, m3, v1, v2, T] = loadData('liao-data.js', 'LIAO_DATA')[700].map(Number);
    const s = [-1, 0, 1, 0, 0, 0, v1, v2, v1, v2, -2 * v1 / m3, -2 * v2 / m3];
    const r = await Lifetime.experiment(s, [1, 1, m3], T, 'closed', { dirs: 4 });
    assert(Math.abs(r.fit.lambda / r.lambdaP - 1) < 0.1, `λ_fit ${r.fit.lambda} vs λ_p ${r.lambdaP}`);
    assert(r.closure < 1e-9 && r.closure < r.closure0, `Newton refinement: closure ${r.closure0} -> ${r.closure}`);
    const f8 = CLASSICS[0];
    const q = await Lifetime.experiment(f8.s, [1, 1, 1], closedT(f8), 'closed', { dirs: 2, eps: [1e-3, 1e-6], maxPeriods: 20, skipMonodromy: true });
    assert(q.points.every((p) => p.censored), 'figure-eight should keep its form');
    return `λ_fit/λ_p = ${(r.fit.lambda / r.lambdaP).toFixed(3)}`;
  });
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
})();
