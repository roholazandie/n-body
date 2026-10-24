#!/usr/bin/env node
// Rebuilds app/orbits-data.js and app/liao-data.js from the published sources.
//   node scripts/build-data.js
// Requires Node 18+ (global fetch).
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const FF_BASE = 'http://db2.fmi.uni-sofia.bg/3bodyfree/';
const LL_BASE = 'https://raw.githubusercontent.com/sjtu-liao/three-body/main/';

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// Hristov, Hristova, Dmitrašinović & Tanikawa (2023): 24,582 free-fall i.c.s
async function buildFreeFall() {
  const [sol, sd, ex] = await Promise.all(['sol_80.txt', 'sd_80.txt', 'res_exponents.txt'].map((f) => get(FF_BASE + f)));
  const rows = sol.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const selfDualTs = sd.trim().split('\n').map((l) => +l.trim().split(/\s+/)[3]);
  const lyap = ex.trim().split('\n').map((l) => +l.trim().split(/\s+/)[2]);
  if (rows.length !== lyap.length) throw new Error('sol_80 / res_exponents length mismatch');
  // i.c.s are ordered by T*; consecutive equal T* = the two i.c.s of one solution
  let solId = -1, prev = -1;
  const out = rows.map(([x, y, T, Ts], i) => {
    if (Math.abs(Ts - prev) > 1e-9 * Ts) { solId++; prev = Ts; }
    const isSd = selfDualTs.some((t) => Math.abs(t - Ts) < 1e-9 * Ts) ? 1 : 0;
    return [x.toPrecision(17), y.toPrecision(17), T.toPrecision(17), Ts.toPrecision(12), lyap[i].toPrecision(5), solId, isSd]
      .map(String)
      .map((s) => s.replace(/e\+?/, 'e').replace(/^0\./, '.').replace(/(\.\d*?)0+(e|$)/, '$1$2'))
      .join(',');
  });
  fs.writeFileSync(path.join(APP, 'orbits-data.js'),
    '// Hristov, Hristova, Dmitrašinović & Tanikawa (2023), arXiv:2308.16159 — all 24,582 i.c.s\n' +
    '// Columns: x, y, T, T* = T|E|^(3/2), Lyapunov exponent (ln max|eig|), solution id, self-dual flag\n' +
    `// Source: ${FF_BASE} (sol_80.txt, sd_80.txt, res_exponents.txt)\n` +
    'window.ORBIT_DATA = `' + out.join('\n') + '`;\n');
  console.log(`orbits-data.js: ${out.length} i.c.s, ${solId + 1} solutions`);
}

// Li & Liao (2017) equal-mass and Li, Jing & Liao (2018) unequal-mass tables
function parseLiao(md) {
  const t = md.replace(/&nbsp;/g, ' ');
  const out = [];
  for (const seg of t.split('<tr>').slice(1)) {
    const cells = [...seg.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
      .map((c) => c[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    if (cells.length < 6) continue;
    const [v1, v2, T, Ts, Lf] = cells.slice(1, 6).map(Number);
    if (!Number.isFinite(v1) || !Number.isFinite(T)) continue;
    let name = cells[0], m3 = 1;
    const mm = name.match(/\(([\d.]+)\)/);
    if (mm) { m3 = +mm[1]; name = name.replace(/\s*\([\d.]+\)/, ''); }
    name = name.replace(/\s*i\.c\.\s*/, ' ').replace(/\s+/g, ' ').trim();
    out.push([name, m3, v1, v2, T, Ts, Lf].join(','));
  }
  return out;
}
async function buildLiao() {
  const [eq, un] = await Promise.all(['three-body-pictures.md', 'three-body-unequal-mass-pictures.md'].map((f) => get(LL_BASE + f)));
  const rows = parseLiao(eq).concat(parseLiao(un));
  fs.writeFileSync(path.join(APP, 'liao-data.js'),
    '// Li & Liao, Sci. China PMA 60, 129511 (2017) — 695 equal-mass orbits; Li, Jing & Liao, PASJ 70, 64 (2018) — 1349 unequal-mass orbits.\n' +
    '// Setup: m1 = m2 = 1, m3; r = (-1,0), (1,0), (0,0); v = (v1,v2), (v1,v2), (-2v1/m3, -2v2/m3); G = 1.\n' +
    '// Columns: class & number, m3, v1, v2, T, T* = T|E|^(3/2), free-group word length Lf\n' +
    '// Source: https://github.com/sjtu-liao/three-body (three-body-pictures.md, three-body-unequal-mass-pictures.md)\n' +
    'window.LIAO_DATA = `' + rows.join('\n') + '`;\n');
  console.log(`liao-data.js: ${rows.length} orbits`);
}

Promise.all([buildFreeFall(), buildLiao()]).catch((e) => { console.error(e.message); process.exit(1); });
