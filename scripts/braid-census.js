#!/usr/bin/env node
// Braid census of every catalogued orbit -> app/braid-data.js
//   node scripts/braid-census.js            (uses all CPU cores; about a minute)
//
// For each orbit: syzygy sequence, free-group word (Montgomery), projected braid word in B3,
// and invariants (permutation type, exponent sum, |trace| in PSL(2,Z), Nielsen–Thurston type,
// dilatation λ). Validation against the published topology:
//   - Li & Liao: free-group word vs the published word (conjugacy class, up to inversion)
//   - free fall, self-dual orbits: half-period syzygy sequence vs Hristov et al.'s table
// Free-fall orbits retrace themselves (full-period braid ββ⁻¹ = 1); we analyse the half-period
// braid closed by a straight-line return to the initial configuration.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const APP = path.join(__dirname, '..', 'app');
const loadWindow = (file, key) => {
  const window = {};
  new Function('window', fs.readFileSync(path.join(APP, file), 'utf8'))(window);
  return window[key];
};

// ---------- worker ----------
if (!isMainThread) {
  const Physics = require(path.join(APP, 'physics.js'));
  const Braid = require(path.join(APP, 'braid.js'));
  const invW = (w) => w.split('').reverse().map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  const out = [];
  for (const job of workerData.jobs) {
    let r;
    try {
      r = Braid.analyze(job.s, job.m, job.T, job.kind);
    } catch (e) {
      out.push({ ...job.meta, error: String(e) });
      continue;
    }
    const half = job.kind === 'freefall';
    const f2 = half ? '' : Braid.f2Word(r.syz, 0, 1, false);
    let valid = -1; // -1: no published reference
    if (job.publishedWord !== undefined) {
      const target = new Set([Braid.canonicalCyclic(job.publishedWord), Braid.canonicalCyclic(invW(job.publishedWord))]);
      // published words are not always freely reduced; compare reduced forms
      const red = Braid.cyclicReduce(job.publishedWord.split('')).join('');
      target.add(Braid.canonicalCyclic(red)); target.add(Braid.canonicalCyclic(invW(red)));
      valid = target.has(Braid.canonicalCyclic(f2)) ? 1 : 0;
    }
    if (job.publishedSeq !== undefined) valid = r.syz.map((z) => z.mid + 1).join('') === job.publishedSeq ? 1 : 0;
    out.push({
      ...job.meta,
      cross: r.reduced.length, syz: r.syz.length, f2len: f2.length,
      digits: r.inv.traceDigits, logLambda: r.inv.logLambda,
      type: { periodic: 0, reducible: 1, 'pseudo-Anosov': 2 }[r.inv.type],
      expSum: r.inv.expSum, cycle: { identity: 0, transposition: 1, '3-cycle': 2 }[r.inv.cycle],
      consistent: r.consistent ? 1 : 0, valid,
    });
  }
  parentPort.postMessage(out);
  return;
}

// ---------- main ----------
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}
function parseLiaoWords(md) {
  const out = [];
  for (const seg of md.replace(/&nbsp;/g, ' ').split('<tr>').slice(1)) {
    const cells = [...seg.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => c[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    if (cells.length >= 2 && /^[abAB]+$/.test(cells[1])) out.push(cells[1]);
  }
  return out;
}

(async () => {
  const t0 = Date.now();
  const Physics = require(path.join(APP, 'physics.js'));
  const CLASSICS = require(path.join(APP, 'classics.js'));
  const LL = loadWindow('liao-data.js', 'LIAO_DATA').split('\n').map((l) => l.split(','));
  const FF = loadWindow('orbits-data.js', 'ORBIT_DATA').split('\n').map((l) => l.split(','));

  console.log('fetching published words and sequences …');
  const LLB = 'https://raw.githubusercontent.com/sjtu-liao/three-body/main/';
  const words = parseLiaoWords(await fetchText(LLB + 'three-body-free-group-word.md'))
    .concat(parseLiaoWords(await fetchText(LLB + 'three-body-unequal-mass-free-group-word.md')));
  if (words.length !== LL.length) throw new Error(`word table has ${words.length} rows, orbit table ${LL.length}`);
  const html = await fetchText('http://db2.fmi.uni-sofia.bg/3bodyfree/');
  const sdSeq = [...html.matchAll(/<tr>\s*<td>(\d+)<\/td>\s*<td><a href="table\/data\d+\.txt"[\s\S]*?<\/td>\s*<td>[\s\S]*?<\/td>\s*<td>([123]+)<\/td>/g)].map((m) => m[2]);
  const sdTs = (await fetchText('http://db2.fmi.uni-sofia.bg/3bodyfree/sd_80.txt')).trim().split('\n').map((l) => +l.trim().split(/\s+/)[3]);

  const jobs = [];
  CLASSICS.forEach((c, i) => jobs.push({ s: c.s, m: [1, 1, 1], T: Physics.closedOrbit(c.s, [1, 1, 1], c.T, 2000).T, kind: 'closed',
    meta: { col: 0, idx: i, Tstar: c.T * Math.abs(Physics.energy(c.s, [1, 1, 1])) ** 1.5 } }));
  LL.forEach((r, i) => {
    const [, m3, v1, v2, T, Ts] = r.map(Number);
    jobs.push({ s: [-1, 0, 1, 0, 0, 0, v1, v2, v1, v2, -2 * v1 / m3, -2 * v2 / m3], m: [1, 1, m3], T, kind: 'closed',
      publishedWord: words[i], meta: { col: 1, idx: i, Tstar: Ts } });
  });
  const seen = new Set();
  FF.forEach((r, i) => {
    const [x, y, T, Ts, lyap, sol, sd] = r.map(Number);
    if (seen.has(sol)) return; // one i.c. per distinct solution
    seen.add(sol);
    const job = { s: Physics.freeFallState(x, y), m: [1, 1, 1], T, kind: 'freefall', meta: { col: 2, idx: i, Tstar: Ts, lyap, sd } };
    if (sd) { const k = sdTs.findIndex((t) => Math.abs(t - Ts) < 1e-9 * Ts); if (k >= 0 && sdSeq[k]) job.publishedSeq = sdSeq[k]; }
    jobs.push(job);
  });

  const nw = Math.max(1, os.cpus().length - 1);
  console.log(`${jobs.length} orbits on ${nw} workers …`);
  // interleave so every worker gets a similar mix of short and long orbits
  const chunks = Array.from({ length: nw }, (_, w) => jobs.filter((_, k) => k % nw === w));
  const results = (await Promise.all(chunks.map((c) => new Promise((res, rej) => {
    const wk = new Worker(__filename, { workerData: { jobs: c } });
    wk.on('message', res); wk.on('error', rej);
    wk.on('exit', (code) => rej(new Error(`worker exited with code ${code} before reporting`))); // no-op once settled
  })))).flat();
  results.sort((a, b) => a.col - b.col || a.idx - b.idx);

  const errors = results.filter((r) => r.error);
  const ok = results.filter((r) => !r.error);
  const llv = ok.filter((r) => r.col === 1), sdv = ok.filter((r) => r.col === 2 && r.valid >= 0);
  const meta = {
    generated: new Date().toISOString().slice(0, 10),
    counts: { classic: ok.filter((r) => r.col === 0).length, liao: llv.length, freefall: ok.filter((r) => r.col === 2).length, errors: errors.length },
    validation: {
      liaoWordMatch: llv.filter((r) => r.valid === 1).length, liaoTotal: llv.length,
      selfDualSeqMatch: sdv.filter((r) => r.valid === 1).length, selfDualTotal: sdv.length,
      projectionConsistent: ok.filter((r) => r.consistent).length, total: ok.length,
    },
  };
  const f = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : '');
  const csv = ok.map((r) => [r.col, r.idx, f(r.Tstar, 4), r.cross, r.syz, r.f2len, r.digits, f(r.logLambda, 4), r.type, r.expSum,
    r.cycle, r.consistent, r.valid, r.col === 2 ? f(r.lyap, 3) : '', r.col === 2 ? r.sd : ''].join(','));
  fs.writeFileSync(path.join(APP, 'braid-data.js'),
    '// Braid census generated by scripts/braid-census.js — do not edit by hand.\n' +
    '// Columns: collection (0 classic, 1 Li & Liao, 2 free fall), index in its catalogue, T*, braid crossings\n' +
    '// (freely reduced), syzygies, free-group word length, |trace| digits, log λ (dilatation), Nielsen–Thurston\n' +
    '// type (0 periodic, 1 reducible, 2 pseudo-Anosov), exponent sum, permutation (0 id, 1 transposition,\n' +
    '// 2 3-cycle), projection-consistent, validated (1 yes, 0 no, -1 no reference), Lyapunov exponent, self-dual\n' +
    `window.BRAID_META = ${JSON.stringify(meta)};\n` +
    'window.BRAID_DATA = `' + csv.join('\n') + '`;\n');
  console.log(JSON.stringify(meta, null, 1));
  if (errors.length) console.log('errors:', errors.slice(0, 5));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})().catch((e) => { console.error(e); process.exit(1); });
