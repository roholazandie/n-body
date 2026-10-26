#!/usr/bin/env node
// Lifetime-of-forms census -> app/lifetime-data.js
//   node scripts/lifetime-census.js            (uses all CPU cores; about an hour)
//
// For a sample of catalogued orbits (all classics, every 8th Li & Liao orbit, every 24th distinct
// free-fall solution): perturb the initial state by ε = 10⁻³ … 10⁻¹³ in 8 random directions, measure
// how many periods the orbit keeps its periodic syzygy sequence, and fit τ = ln(δ/(ε + ε₀))/λ_fit.
// Closed orbits are first refined by Newton shooting (published i.c.s close only to 10⁻² … 10⁻⁸), and
// perturbed around the refined orbit; the lifetime of the published i.c. itself then measures its
// effective distance from the true orbit.
// Shadowing predicts λ_fit = λ_p, the monodromy exponent, computed here independently (and, for
// free-fall orbits, checked against the published Lyapunov exponents).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const APP = path.join(__dirname, '..', 'app');
const MAX_PERIODS = 40;

if (!isMainThread) {
  const Lifetime = require(path.join(APP, 'lifetime.js'));
  (async () => {
    for (const job of workerData.jobs) {
      let out;
      try {
        const r = await Lifetime.experiment(job.s, job.m, job.T, job.kind, { maxPeriods: MAX_PERIODS });
        out = { ...job.meta, lambdaP: r.lambdaP, fit: r.fit, base: r.base, nSyz: r.nSyz, taus: r.points.map((p) => p.tau),
          epsCat: r.epsCat, closure0: r.closure0, closure: r.closure, rmin: r.rmin };
      } catch (e) {
        out = { ...job.meta, error: String(e) };
      }
      parentPort.postMessage(out);
    }
    parentPort.postMessage(null);
  })();
  return;
}

const loadWindow = (file, key) => {
  const window = {};
  new Function('window', fs.readFileSync(path.join(APP, file), 'utf8'))(window);
  return window[key];
};

(async () => {
  const t0 = Date.now();
  const Physics = require(path.join(APP, 'physics.js'));
  const Lifetime = require(path.join(APP, 'lifetime.js'));
  const CLASSICS = require(path.join(APP, 'classics.js'));
  const LL = loadWindow('liao-data.js', 'LIAO_DATA').split('\n').map((l) => l.split(','));
  const FF = loadWindow('orbits-data.js', 'ORBIT_DATA').split('\n').map((l) => l.split(','));

  const jobs = [];
  CLASSICS.forEach((c, i) => jobs.push({ s: c.s, m: [1, 1, 1], T: Physics.closedOrbit(c.s, [1, 1, 1], c.T, 2000).T, kind: 'closed',
    meta: { col: 0, idx: i, Tstar: c.T * Math.abs(Physics.energy(c.s, [1, 1, 1])) ** 1.5 } }));
  LL.forEach((r, i) => {
    if (i % 8) return;
    const [, m3, v1, v2, T, Ts] = r.map(Number);
    jobs.push({ s: [-1, 0, 1, 0, 0, 0, v1, v2, v1, v2, -2 * v1 / m3, -2 * v2 / m3], m: [1, 1, m3], T, kind: 'closed',
      meta: { col: 1, idx: i, Tstar: Ts } });
  });
  const seen = new Set();
  FF.forEach((r, i) => {
    const [x, y, T, Ts, lyap, sol] = r.map(Number);
    if (seen.has(sol)) return;
    seen.add(sol);
    if ((seen.size - 1) % 24) return;
    jobs.push({ s: Physics.freeFallState(x, y), m: [1, 1, 1], T, kind: 'freefall', meta: { col: 2, idx: i, Tstar: Ts, lambdaCat: lyap } });
  });

  const nw = Math.max(1, os.cpus().length - 1);
  console.log(`${jobs.length} orbits on ${nw} workers …`);
  const chunks = Array.from({ length: nw }, (_, w) => jobs.filter((_, k) => k % nw === w));
  const results = [];
  await Promise.all(chunks.map((c) => new Promise((res, rej) => {
    const wk = new Worker(__filename, { workerData: { jobs: c } });
    wk.on('message', (m) => {
      if (m === null) return res();
      results.push(m);
      if (results.length % 50 === 0) console.log(`  ${results.length} / ${jobs.length}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    });
    wk.on('error', rej);
    wk.on('exit', (code) => { if (code !== 0) rej(new Error(`worker exited with code ${code}`)); });
  })));
  results.sort((a, b) => a.col - b.col || a.idx - b.idx);
  const errors = results.filter((r) => r.error), ok = results.filter((r) => !r.error);

  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  // monodromy λ_p against the published free-fall exponents
  const ff = ok.filter((r) => r.col === 2 && Number.isFinite(r.lambdaP) && r.rmin >= Lifetime.RMIN_RELIABLE);
  const relDev = ff.map((r) => Math.abs(r.lambdaP - r.lambdaCat) / r.lambdaCat);
  // lifetime law: λ_fit / λ_p for unstable orbits with a fit
  const ratios = (col) => ok.filter((r) => r.col === col && r.fit && r.lambdaP > 0.05 && r.rmin >= Lifetime.RMIN_RELIABLE).map((r) => r.fit.lambda / r.lambdaP);
  const meta = {
    generated: new Date().toISOString().slice(0, 10),
    eps: Array.from({ length: 21 }, (_, k) => -3 - k / 2), maxPeriods: MAX_PERIODS, directions: 8,
    counts: [0, 1, 2].map((c) => ok.filter((r) => r.col === c).length), errors: errors.length,
    monodromy: { n: ff.length, medianRelDev: median(relDev), within1pct: relDev.filter((d) => d < 0.01).length },
    ratio: [0, 1, 2].map((c) => { const q = ratios(c); return { n: q.length, median: median(q), within20: q.filter((x) => Math.abs(x - 1) < 0.2).length }; }),
    stable: [0, 1, 2].map((c) => ok.filter((r) => r.col === c && r.lambdaP < 0.05).length),
    nearCollision: [0, 1, 2].map((c) => ok.filter((r) => r.col === c && r.rmin < Lifetime.RMIN_RELIABLE).length),
    noSyzygies: ok.filter((r) => r.nSyz === 0).length,
    refined: { n: ok.filter((r) => r.col < 2).length, medianBefore: median(ok.filter((r) => r.col < 2).map((r) => r.closure0)),
      medianAfter: median(ok.filter((r) => r.col < 2).map((r) => r.closure)) },
  };
  const f = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : '');
  const csv = ok.map((r) => [r.col, r.idx, f(r.Tstar, 4), f(r.lambdaP, 4), r.col === 2 ? f(r.lambdaCat, 3) : '',
    r.fit ? f(r.fit.lambda, 4) : '', r.fit ? f(r.fit.r2, 3) : '', r.fit ? f(Math.log10(r.fit.eps0), 1) : '',
    r.fit ? f(Math.log10(r.fit.delta), 2) : '', f(r.base.tau, 3), r.base.censored ? 1 : 0, r.nSyz,
    f(Math.log10(r.epsCat), 2), f(Math.log10(r.closure0), 2), f(Math.log10(r.closure), 2), f(Math.log10(r.rmin), 2),
    r.taus.map((t) => f(t, 3)).join(' ')].join(','));
  fs.writeFileSync(path.join(APP, 'lifetime-data.js'),
    '// Lifetime-of-forms census generated by scripts/lifetime-census.js — do not edit by hand.\n' +
    '// Columns: collection (0 classic, 1 Li & Liao, 2 free fall), index in its catalogue, T*, λ_p (monodromy,\n' +
    '// ln max|μ| per period), published Lyapunov exponent (free fall), λ_fit (from lifetimes), R² of the fit,\n' +
    '// log10 ε₀ (floor), log10 δ, lifetime of the unperturbed i.c. (periods), censored, syzygies per period,\n' +
    '// log10 effective distance of the published i.c. from the orbit, log10 closure of the published i.c.,\n' +
    '// log10 closure after Newton refinement (closed orbits), log10 closest approach (λ_p unreliable below -7),\n' +
    '// mean lifetime in periods for ε = 10^(meta.eps[k]) (space-separated; = maxPeriods when censored)\n' +
    `window.LIFETIME_META = ${JSON.stringify(meta)};\n` +
    'window.LIFETIME_DATA = `' + csv.join('\n') + '`;\n');
  console.log(JSON.stringify(meta, null, 1));
  if (errors.length) console.log('errors:', errors.slice(0, 5));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})().catch((e) => { console.error(e); process.exit(1); });
