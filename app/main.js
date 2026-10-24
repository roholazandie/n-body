/* Three-body orbit gallery — rendering, UI and orbit management. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('stage');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  let GL = null;
  try { GL = createGLPainter(canvas); } catch (e) { console.warn('WebGL unavailable, using Canvas 2D', e); }
  const ctx = GL ? null : canvas.getContext('2d');
  const PERMS = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1], [2, 1, 0], [1, 0, 2]];
  const PALETTES = {
    ember: { c: ['#ff7a22', '#fff0d6', '#9aa6ff'], bg: '#040306' },
    aurora: { c: ['#3cffc0', '#6aa8ff', '#e07bff'], bg: '#03060a' },
    neon: { c: ['#ff2e88', '#22e5ff', '#d8ff3c'], bg: '#050208' },
    mono: { c: ['#ffffff', '#c9d6ff', '#8fa3d9'], bg: '#03040a' },
    rgb: { c: ['#ff4b4b', '#4bff7a', '#4b8bff'], bg: '#030303' },
  };

  // ---------- settings ----------
  const DEFAULTS = {
    collection: 'classic', rows: 4, cols: 5, labels: false, orient: true,
    timing: 'loop', loop: 9, speed: 1, randPhase: false,
    palette: 'ember', custom: ['#ff7a22', '#fff0d6', '#9aa6ff', '#040306'], shuffleColors: true,
    trail: 0.4, width: 1.2, glow: 1, body: 1, ghost: false,
    ffSort: 'tstar', ffSelfDual: false, ffDistinct: true, ffTmin: 0, ffTmax: 80, page: 0,
    llMass: 'all', llClass: 'all', llSort: 'tstar',
    view: 'orbits', braidSpan: 8, braidAngle: 0, braidSpin: false, braidGap: 1,
  };
  let S = Object.assign({}, DEFAULTS);
  try { Object.assign(S, JSON.parse(localStorage.getItem('threebody.settings') || '{}')); } catch (e) { /* storage unavailable */ }
  // repair values persisted by older versions (e.g. fractional grid sizes)
  S.braidSpan = Number.isFinite(+S.braidSpan) ? Math.max(1, Math.min(400, +S.braidSpan)) : DEFAULTS.braidSpan;
  for (const k of ['rows', 'cols']) {
    const v = Math.round(+S[k]);
    S[k] = Number.isFinite(v) ? Math.max(1, Math.min(k === 'rows' ? 10 : 12, v)) : DEFAULTS[k];
  }
  const save = () => { try { localStorage.setItem('threebody.settings', JSON.stringify(S)); } catch (e) { /* ignore */ } };

  // ---------- free-fall data (Hristov et al. 2023) ----------
  let FF = null; // {x,y,T,Ts,lyap,sol,sd} typed arrays
  function ffData() {
    if (FF) return FF;
    const lines = window.ORBIT_DATA.split('\n');
    const n = lines.length;
    FF = { n, x: new Float64Array(n), y: new Float64Array(n), T: new Float64Array(n), Ts: new Float64Array(n),
      lyap: new Float32Array(n), sol: new Int32Array(n), sd: new Uint8Array(n), rank: new Int32Array(n) };
    for (let i = 0; i < n; i++) {
      const p = lines[i].split(',');
      FF.x[i] = +p[0]; FF.y[i] = +p[1]; FF.T[i] = +p[2]; FF.Ts[i] = +p[3];
      FF.lyap[i] = +p[4]; FF.sol[i] = +p[5]; FF.sd[i] = +p[6];
    }
    return FF;
  }

  let ffList = [];
  let shuffleSeed = 1;
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function buildFFList() {
    const D = ffData();
    const seen = new Set();
    let list = [];
    for (let i = 0; i < D.n; i++) {
      if (S.ffSelfDual && !D.sd[i]) continue;
      if (D.Ts[i] < S.ffTmin || D.Ts[i] > S.ffTmax) continue;
      if (S.ffDistinct) { if (seen.has(D.sol[i])) continue; seen.add(D.sol[i]); }
      list.push(i);
    }
    if (S.ffSort === 'lyap') list.sort((a, b) => D.lyap[a] - D.lyap[b]);
    else if (S.ffSort === 'lyapDesc') list.sort((a, b) => D.lyap[b] - D.lyap[a]);
    else if (S.ffSort === 'random') {
      const r = rng(shuffleSeed);
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    }
    ffList = list;
  }

  // ---------- Li & Liao data (2017, 2018) ----------
  let LL = null; // [{name, cls, m3, v1, v2, T, Ts, Lf}]
  function llData() {
    if (LL) return LL;
    LL = window.LIAO_DATA.split('\n').map((l) => {
      const p = l.split(',');
      return { name: p[0], cls: p[0].split(' ')[0], m3: +p[1], v1: +p[2], v2: +p[3], T: +p[4], Ts: +p[5], Lf: +p[6] };
    });
    return LL;
  }
  function llState(o) {
    return { s: [-1, 0, 1, 0, 0, 0, o.v1, o.v2, o.v1, o.v2, -2 * o.v1 / o.m3, -2 * o.v2 / o.m3], m: [1, 1, o.m3] };
  }
  let llList = [];
  function buildLLList() {
    const D = llData();
    const list = [];
    for (let i = 0; i < D.length; i++) {
      if (S.llMass !== 'all' && D[i].m3 !== +S.llMass) continue;
      if (S.llClass !== 'all' && D[i].cls !== S.llClass) continue;
      list.push(i);
    }
    if (S.llSort === 'tstar') list.sort((a, b) => D[a].Ts - D[b].Ts);
    else if (S.llSort === 'lf') list.sort((a, b) => D[a].Lf - D[b].Lf || D[a].Ts - D[b].Ts);
    else if (S.llSort === 'random') {
      const r = rng(shuffleSeed);
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    }
    llList = list;
  }
  function activeList() { return S.collection === 'liao' ? llList : ffList; }
  function collectionSize() { return S.collection === 'classic' ? CLASSICS.length : activeList().length; }

  // ---------- items & orbit computation ----------
  const cache = new Map();
  const classicItem = (i) => ({ kind: 'classic', key: 'c' + i, idx: i });
  const ffItem = (i) => ({ kind: 'ff', key: 'f' + i, idx: i });
  const llItem = (i) => ({ kind: 'll', key: 'l' + i, idx: i });

  function itemState(item) {
    if (item.kind === 'classic') return { s: CLASSICS[item.idx].s.slice(), m: [1, 1, 1] };
    if (item.kind === 'ff') { const D = ffData(); return { s: Physics.freeFallState(D.x[item.idx], D.y[item.idx]), m: [1, 1, 1] }; }
    if (item.kind === 'll') return llState(llData()[item.idx]);
    return { s: item.s.slice(), m: item.m.slice() };
  }

  function scaleInvariant(T, s, m) { return T * Math.pow(Math.abs(Physics.energy(s, m)), 1.5); }

  function computeOrbit(item) {
    let o;
    if (item.kind === 'classic') {
      const c = CLASSICS[item.idx];
      const Ts = scaleInvariant(c.T, c.s, [1, 1, 1]);
      const n = Math.min(16000, Math.round(2000 + 200 * Ts));
      o = Physics.closedOrbit(c.s, [1, 1, 1], c.T, n);
      o.Tstar = scaleInvariant(o.T, c.s, [1, 1, 1]);
      o.periodic = true;
    } else if (item.kind === 'ff') {
      const D = ffData(), i = item.idx;
      const n = Math.min(16000, Math.round(1500 + 200 * D.Ts[i]));
      o = Physics.periodicOrbit(D.x[i], D.y[i], D.T[i], n);
      o.T = D.T[i]; o.Tstar = D.Ts[i]; o.periodic = true;
    } else if (item.kind === 'll') {
      const c = llData()[item.idx], { s, m } = llState(c);
      const n = Math.min(20000, Math.round(2000 + 200 * c.Ts));
      o = Physics.closedOrbit(s, m, c.T, n, true); // published T is exact to 10 digits
      o.Tstar = c.Ts; o.periodic = true; o.masses = m;
    } else {
      const n = Math.min(40000, Math.max(3000, Math.round(item.samples || 6000)));
      if (item.periodic) {
        o = Physics.closedOrbit(item.s, item.m, item.dur, n);
        o.periodic = true;
      } else {
        o = Physics.freeOrbit(item.s, item.m, item.dur, n);
        o.T = o.tReached; o.periodic = false;
      }
      o.masses = item.m;
      const E = Physics.energy(item.s, item.m);
      o.Tstar = E < 0 ? o.T * Math.pow(-E, 1.5) : o.T;
    }
    projectOrbit(o);
    return o;
  }

  // Center, optionally rotate to principal axes, and normalise so the larger extent is 1.
  function projectOrbit(o) {
    const n = o.n, p = o.pos;
    let mx = 0, my = 0;
    for (let q = 0; q < n; q++) for (let b = 0; b < 3; b++) { mx += p[q * 6 + 2 * b]; my += p[q * 6 + 2 * b + 1]; }
    mx /= 3 * n; my /= 3 * n;
    let cxx = 0, cyy = 0, cxy = 0;
    for (let q = 0; q < n; q++) for (let b = 0; b < 3; b++) {
      const dx = p[q * 6 + 2 * b] - mx, dy = p[q * 6 + 2 * b + 1] - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    const ang = S.orient ? 0.5 * Math.atan2(2 * cxy, cxx - cyy) : 0;
    const co = Math.cos(-ang), si = Math.sin(-ang);
    const out = new Float32Array(n * 6);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let q = 0; q < n; q++) for (let b = 0; b < 3; b++) {
      const dx = p[q * 6 + 2 * b] - mx, dy = p[q * 6 + 2 * b + 1] - my;
      const X = dx * co - dy * si, Y = dx * si + dy * co;
      out[q * 6 + 2 * b] = X; out[q * 6 + 2 * b + 1] = Y;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, ext = Math.max(x1 - x0, y1 - y0) || 1;
    for (let q = 0; q < n; q++) for (let b = 0; b < 3; b++) {
      out[q * 6 + 2 * b] = (out[q * 6 + 2 * b] - cx) / ext;
      out[q * 6 + 2 * b + 1] = -(out[q * 6 + 2 * b + 1] - cy) / ext; // screen y down
    }
    o.view = out; o.aspect = (x1 - x0) / ((y1 - y0) || 1);
    o.ext = [(x1 - x0) / ext, (y1 - y0) / ext];
  }

  function getOrbit(item) {
    if (cache.has(item.key)) return cache.get(item.key);
    return null;
  }
  // Compute pending orbits a few per frame so the UI never stalls.
  const queue = [];
  function enqueue(item) { if (!cache.has(item.key) && !queue.some((q) => q.key === item.key)) queue.push(item); }
  function pump(budgetMs) {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < budgetMs) {
      const it = queue.shift();
      if (cache.has(it.key)) continue;
      try { cache.set(it.key, computeOrbit(it)); } catch (e) { console.error(e); cache.set(it.key, { failed: true }); }
    }
    if (cache.size > 400) { // simple eviction: drop oldest entries not on screen
      const keep = new Set(cells.map((c) => c.item.key));
      if (focus) keep.add(focus.item.key);
      for (const k of cache.keys()) { if (cache.size <= 300) break; if (!keep.has(k)) cache.delete(k); }
    }
  }

  // ---------- grid ----------
  let cells = [];
  let focus = null; // {item, phaseOffset, perm}
  function pageCount() {
    const per = S.rows * S.cols;
    const total = collectionSize();
    return Math.max(1, Math.ceil(total / per));
  }
  function buildCells() {
    const per = S.rows * S.cols;
    S.page = Math.min(Math.max(0, S.page), pageCount() - 1);
    const start = S.page * per;
    const items = [];
    for (let k = 0; k < per; k++) {
      const g = start + k;
      if (S.collection === 'classic') { if (g < CLASSICS.length) items.push(classicItem(g)); }
      else if (S.collection === 'liao') { if (g < llList.length) items.push(llItem(llList[g])); }
      else if (g < ffList.length) items.push(ffItem(ffList[g]));
    }
    // A collection smaller than the grid wraps around so every cell is filled;
    // repeats get their own phase and colour order so they don't mirror the originals.
    const unique = items.length;
    for (let k = unique; unique > 0 && k < per; k++) items.push(items[k % unique]);
    const r = rng(start * 7 + 3);
    cells = items.map((item, k) => ({ item, phaseOffset: r(), repeat: k >= unique,
      perm: PERMS[(k * 5 + 2 + start + Math.floor(k / Math.max(1, unique))) % 6] }));
    cells.forEach((c) => enqueue(c.item));
    updatePager();
  }

  function cellRects() {
    const W = innerWidth, H = innerHeight;
    if (focus) {
      const wide = W > 720 && !$('inspector').hidden;
      const left = wide ? 360 : 0;
      const bottom = !wide && !$('inspector').hidden ? H * 0.55 : 0;
      const pr = $('panel').classList.contains('open') && W > 1100 ? 320 : 0;
      return [{ x: left, y: 0, w: W - left - pr, h: H - bottom }];
    }
    const pr = $('panel').classList.contains('open') && W > 1100 ? 320 : 0;
    const gw = W - pr, gh = H;
    const cw = gw / S.cols, ch = gh / S.rows;
    const rects = [];
    for (let k = 0; k < cells.length; k++) {
      const r = Math.floor(k / S.cols), c = k % S.cols;
      rects.push({ x: c * cw, y: r * ch, w: cw, h: ch });
    }
    return rects;
  }

  // ---------- colors ----------
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  let colorSet = null;
  function currentColors() {
    const p = S.palette === 'custom' ? { c: S.custom.slice(0, 3), bg: S.custom[3] } : PALETTES[S.palette] || PALETTES.ember;
    return p;
  }
  function makeSprite(rgb, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    const [r, gg, b] = rgb;
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.08, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.14, `rgba(${r},${gg},${b},0.85)`);
    grd.addColorStop(0.3, `rgba(${r},${gg},${b},0.22)`);
    grd.addColorStop(0.6, `rgba(${r},${gg},${b},0.05)`);
    grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, size, size);
    return c;
  }
  function rebuildColors() {
    const p = currentColors();
    const rgbs = p.c.map(hexToRgb);
    colorSet = {
      rgb: rgbs,
      core: rgbs.map(([r, g, b]) => [Math.round(r + (255 - r) * 0.3), Math.round(g + (255 - g) * 0.3), Math.round(b + (255 - b) * 0.3)]),
      sprite: rgbs.map((c) => makeSprite(c, 128)),
      bg: p.bg,
    };
    document.documentElement.style.setProperty('--bg', p.bg);
    noiseCanvas = null; grainPattern = null;
  }

  // Subtle film grain like the original animation
  let noiseCanvas = null;
  function noise() {
    if (noiseCanvas) return noiseCanvas;
    noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = noiseCanvas.height = 256;
    const g = noiseCanvas.getContext('2d'), im = g.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) {
      const v = Math.random() * 255;
      im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 7;
    }
    g.putImageData(im, 0, 0);
    return noiseCanvas;
  }

  // ---------- rendering ----------
  let dpr = 1, clock = 0, playing = true, last = performance.now();
  let hoverIdx = -1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [canvas, overlay]) {
      c.width = Math.round(innerWidth * dpr);
      c.height = Math.round(innerHeight * dpr);
    }
  }

  function phaseFor(o, off, forceOffset) {
    let dur = S.loop;
    if (S.timing === 'scaled' || S.view === 'braid') dur = S.loop * (o.Tstar || 10) / 15;
    const ph = clock / dur + (S.randPhase || forceOffset ? off : 0);
    if (!o.periodic) return Math.min(1, ph % (1 + 0.15)); // one-shot sims: play, hold, restart
    return ph - Math.floor(ph);
  }

  // Sample body b's path over [head - L, head] into pts (CSS px). Returns segment count.
  const pts = new Float32Array(2 * 8200); // up to 8200 points per sampled path
  function sampleTrail(o, b, head, L, sx, sy, scale, maxPts) {
    const n = o.n, v = o.view, periodic = o.periodic;
    let start = head - L;
    if (!periodic && start < 0) start = 0;
    const span = head - start;
    if (span <= 0) return 0;
    const count = Math.min(maxPts, Math.max(2, Math.ceil(span * 2)));
    for (let k = 0; k <= count; k++) {
      let f = start + (span * k) / count;
      if (periodic) f = ((f % n) + n) % n; else f = Math.min(f, n - 1);
      const i0 = Math.floor(f), t = f - i0;
      const i1 = periodic ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
      // Catmull-Rom between samples for a smooth curve at any zoom
      const im = periodic ? (i0 - 1 + n) % n : Math.max(0, i0 - 1);
      const i2 = periodic ? (i1 + 1) % n : Math.min(n - 1, i1 + 1);
      for (let c = 0; c < 2; c++) {
        const p0 = v[im * 6 + 2 * b + c], p1 = v[i0 * 6 + 2 * b + c], p2 = v[i1 * 6 + 2 * b + c], p3 = v[i2 * 6 + 2 * b + c];
        const t2 = t * t, t3 = t2 * t;
        const val = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
        pts[2 * k + c] = (c ? sy : sx) + val * scale;
      }
    }
    return count;
  }

  const trailWidth = (lw) => (f) => lw * (0.3 + 0.7 * f);
  const trailAlpha = (f) => Math.pow(f, 1.7);

  // Canvas 2D fallback (used only when WebGL is unavailable)
  const CHUNKS = 16;
  function drawTrail2D(count, rgb, core, lw, glow) {
    const [r, g, bb] = rgb, [cr, cg, cb] = core;
    const per = count / CHUNKS;
    for (let j = 0; j < CHUNKS; j++) {
      const a0 = Math.floor(j * per), a1 = Math.min(count, Math.ceil((j + 1) * per));
      if (a1 <= a0) continue;
      const f = (j + 1) / CHUNKS, alpha = trailAlpha(f), w = trailWidth(lw)(f);
      ctx.beginPath();
      ctx.moveTo(pts[2 * a0], pts[2 * a0 + 1]);
      for (let k = a0 + 1; k <= a1; k++) ctx.lineTo(pts[2 * k], pts[2 * k + 1]);
      if (glow > 0) {
        ctx.strokeStyle = `rgba(${r},${g},${bb},${(alpha * 0.07 * glow).toFixed(4)})`; ctx.lineWidth = w * 7; ctx.stroke();
        ctx.strokeStyle = `rgba(${r},${g},${bb},${(alpha * 0.2 * glow).toFixed(4)})`; ctx.lineWidth = w * 2.8; ctx.stroke();
      }
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(alpha * 0.95).toFixed(4)})`; ctx.lineWidth = w; ctx.stroke();
    }
  }

  function drawGhost(o, b, sx, sy, scale, rgb) {
    const n = o.n, v = o.view, step = Math.max(1, Math.floor(n / 3000));
    let k = 0;
    for (let q = 0; q < n; q += step, k++) { pts[2 * k] = sx + v[q * 6 + 2 * b] * scale; pts[2 * k + 1] = sy + v[q * 6 + 2 * b + 1] * scale; }
    if (o.periodic) { pts[2 * k] = pts[0]; pts[2 * k + 1] = pts[1]; k++; }
    if (GL) { GL.ribbon(pts, k - 1, rgb, () => 0.9, () => 0.1, 0, false); return; }
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 1; i < k; i++) ctx.lineTo(pts[2 * i], pts[2 * i + 1]);
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.09)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function labelFor(item, o) {
    if (item.kind === 'classic') return [CLASSICS[item.idx].name, o ? 'T* = ' + o.Tstar.toFixed(2) : ''];
    if (item.kind === 'ff') {
      const D = ffData();
      return ['#' + (D.sol[item.idx] + 1) + (D.sd[item.idx] ? ' · self-dual' : ''), 'T* = ' + D.Ts[item.idx].toFixed(2)];
    }
    if (item.kind === 'll') {
      const c = llData()[item.idx];
      return [c.name + (c.m3 !== 1 ? ` · m₃ = ${c.m3}` : ''), 'T* = ' + c.Ts.toFixed(2)];
    }
    return [item.title || 'Custom', o ? 't = ' + o.T.toFixed(2) : ''];
  }

  // ---------- braid view: world-lines in (projected position, time) ----------
  // Each body is drawn as a strand: horizontal = position projected on an axis at
  // angle θ, vertical = time (now at the top, history scrolling down). The other
  // in-plane coordinate is depth: at a crossing the nearer strand passes over and
  // cuts a gap in the one behind, as in a braid diagram.
  const SMAX = 8200;
  const strand = Array.from({ length: 3 }, () => ({ x: new Float32Array(SMAX), y: new Float32Array(SMAX), d: new Float32Array(SMAX), nx: new Float32Array(SMAX), ny: new Float32Array(SMAX), n: 0 }));
  const segOrder = [];
  function braidAngle() { return (S.braidAngle + (S.braidSpin ? clock * 12 : 0)) * Math.PI / 180; }

  function drawBraidCell(cell, rect, isFocus, o) {
    const n = o.n;
    const ph = phaseFor(o, cell.phaseOffset, cell.repeat);
    const head = ph * (o.periodic ? n : n - 1);
    // window measured in scale-invariant time t* = t|E|^(3/2), so every cell shows comparable dynamics
    const periods = S.braidSpan / (o.Tstar || 10);
    const L = Math.max(4, periods * n);
    const top = rect.y + rect.h * (isFocus ? 0.1 : 0.12), height = rect.h * (isFocus ? 0.74 : S.labels ? 0.68 : 0.76);
    const th = braidAngle(), ct = Math.cos(th), st = Math.sin(th);
    const half = Math.hypot(o.ext[0], o.ext[1]) / 2 || 0.5;
    // Zoom like a camera, but gentler sideways: time is compressed by SPAN_REF/span, the
    // braid's width and strand thickness by its square root, so zooming out narrows the
    // rope instead of stretching it horizontally (never wider than the cell when zooming in).
    const hz = Math.min(1, Math.sqrt(SPAN_REF / S.braidSpan));
    const sx = (rect.w * (isFocus ? 0.4 : 0.42) * hz) / half, cx = rect.x + rect.w / 2;
    const lw = Math.max(0.6, S.width * Math.min(2.2, Math.max(0.8, Math.min(rect.w, rect.h) / 240)) * (isFocus ? 1.3 : 1) * hz);
    const gap = Math.max(0.8, Math.max(2, lw * 1.3) * hz) * S.braidGap;
    // enough points for both the screen height and the number of periods in the window
    const maxPts = Math.min(isFocus ? 8000 : 1500, Math.max(120, Math.round(Math.max(height * (isFocus ? 2 : 1.2), periods * (isFocus ? 400 : 150)))));
    const perm = S.shuffleColors ? cell.perm : PERMS[0];
    let start = head - L;
    if (!o.periodic && start < 0) start = 0;
    const spanFrac = (head - start) / L;

    segOrder.length = 0;
    for (let b = 0; b < 3; b++) {
      const sd = strand[b];
      const count = sampleTrail(o, b, head, L, 0, 0, 1, maxPts);
      sd.n = count;
      for (let k = 0; k <= count; k++) {
        const vx = pts[2 * k], vy = pts[2 * k + 1];
        sd.x[k] = cx + (vx * ct + vy * st) * sx;
        sd.d[k] = -vx * st + vy * ct;
        sd.y[k] = top + height * spanFrac * (1 - k / count);
      }
      // side vectors (continuous) for edge-to-edge pieces
      let lx = 1, ly = 0;
      for (let k = 0; k <= count; k++) {
        const k0 = Math.max(0, k - 1), k1 = Math.min(count, k + 1);
        const tx = sd.x[k1] - sd.x[k0], ty = sd.y[k1] - sd.y[k0], len = Math.hypot(tx, ty);
        if (len > 1e-9) { lx = -ty / len; ly = tx / len; }
        sd.nx[k] = lx; sd.ny[k] = ly;
      }
      for (let k = 0; k < count; k++) segOrder.push(b * 16384 + k);
    }
    // painter's order: farthest pieces first
    const dep = (code) => { const sd = strand[code >> 14], k = code & 16383; return sd.d[k] + sd.d[k + 1]; };
    segOrder.sort((a, b) => dep(a) - dep(b));
    if (GL) GL.setMode(1);
    for (const code of segOrder) {
      const b = code >> 14, k = code & 16383, sd = strand[b];
      const f = k / sd.n, fade = 0.35 + 0.65 * Math.min(1, f * 4); // soften the oldest end
      const rgb = colorSet.rgb[perm[b]];
      if (GL) {
        // depth: nearer = smaller z; the gap outline sits just behind its own strand so
        // it cuts strands clearly further back but never its own neighbouring pieces
        const z = Math.max(-0.95, Math.min(0.95, -0.35 * (sd.d[k] + sd.d[k + 1])));
        GL.segment(sd.x[k], sd.y[k], sd.x[k + 1], sd.y[k + 1], sd.nx[k], sd.ny[k], sd.nx[k + 1], sd.ny[k + 1], lw / 2 + gap, null, 1, z + 0.012);
        GL.segment(sd.x[k], sd.y[k], sd.x[k + 1], sd.y[k + 1], sd.nx[k], sd.ny[k], sd.nx[k + 1], sd.ny[k + 1], lw / 2, rgb, fade, z);
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.beginPath(); ctx.moveTo(sd.x[k], sd.y[k]); ctx.lineTo(sd.x[k + 1], sd.y[k + 1]);
        ctx.strokeStyle = colorSet.bg; ctx.lineWidth = lw + 2 * gap; ctx.stroke();
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${fade})`; ctx.lineWidth = lw; ctx.stroke();
      }
    }
    if (GL) GL.setMode(0); else ctx.globalCompositeOperation = 'lighter';
    // bodies ride the "now" line at the top
    if (S.body > 0) {
      const size = Math.max(8, Math.min(rect.w, rect.h) * 0.07 * Math.max(0.45, Math.sqrt(hz))) * S.body * (0.5 + 0.5 * Math.min(1.5, S.glow + 0.3));
      for (let b = 0; b < 3; b++) {
        const sd = strand[b];
        if (!sd.n) continue;
        const ms = o.masses ? Math.min(1.7, Math.max(0.6, Math.cbrt(3 * o.masses[b] / (o.masses[0] + o.masses[1] + o.masses[2])))) : 1;
        const x = sd.x[sd.n], y = sd.y[sd.n], sz = size * ms;
        if (GL) GL.body(x, y, sz, colorSet.rgb[perm[b]], S.glow);
        else ctx.drawImage(colorSet.sprite[perm[b]], x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    // time axis cue
    octx.strokeStyle = 'rgba(255,255,255,0.07)';
    octx.lineWidth = 1;
    octx.setLineDash([3, 4]);
    octx.beginPath(); octx.moveTo(rect.x + rect.w * 0.08, top); octx.lineTo(rect.x + rect.w * 0.92, top); octx.stroke();
    octx.setLineDash([]);
    if (isFocus) {
      octx.fillStyle = 'rgba(200,190,215,0.55)';
      octx.font = '11px ui-sans-serif, system-ui, sans-serif';
      octx.textAlign = 'left';
      octx.fillText('now', rect.x + rect.w * 0.08, top - 6);
      octx.fillText(`↑ time  ·  window t* = ${fmtSpan(S.braidSpan)} (≈ ${periods < 10 ? periods.toFixed(2) : periods.toFixed(1)} periods)  ·  projection ${((braidAngle() * 180 / Math.PI) % 180).toFixed(0)}°`, rect.x + rect.w * 0.08, top + height + 18);
    }
  }

  function drawCell(cell, rect, isFocus) {
    const o = getOrbit(cell.item);
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const fit = Math.min(rect.w, rect.h);
    if (!o || o.failed) {
      const pulse = 0.4 + 0.3 * Math.sin(performance.now() / 250);
      octx.fillStyle = o && o.failed ? 'rgba(255,80,80,.5)' : `rgba(255,255,255,${pulse * 0.25})`;
      octx.beginPath(); octx.arc(cx, cy, 2.5, 0, 7); octx.fill();
      return;
    }
    if (S.view === 'braid') { drawBraidCell(cell, rect, isFocus, o); drawLabel(cell, rect, isFocus, o); return; }
    // fit normalised orbit (larger extent = 1) into the cell, honouring aspect
    const pad = isFocus ? 0.78 : 0.74;
    const scale = Math.min((rect.w * pad) / Math.max(o.ext[0], 1e-3), (rect.h * pad) / Math.max(o.ext[1], 1e-3));
    const ph = phaseFor(o, cell.phaseOffset, cell.repeat);
    const head = ph * (o.periodic ? o.n : o.n - 1);
    const L = Math.max(2, S.trail * o.n);
    const lw = S.width * Math.max(0.8, fit / 220) * (isFocus ? 1.15 : 1);
    // resolution: roughly one vertex per 1.5 px of trail on screen
    const maxPts = Math.min(isFocus ? 8000 : 1500, Math.max(160, Math.round(fit * (isFocus ? 6 : 3) * Math.min(1, S.trail * 2 + 0.3))));
    const perm = S.shuffleColors ? cell.perm : PERMS[0];
    if (S.ghost) for (let b = 0; b < 3; b++) drawGhost(o, b, cx, cy, scale, colorSet.rgb[perm[b]]);
    for (let b = 0; b < 3; b++) {
      const ci = perm[b];
      const count = sampleTrail(o, b, head, L, cx, cy, scale, maxPts);
      if (!count) continue;
      if (GL) GL.ribbon(pts, count, colorSet.rgb[ci], trailWidth(lw), trailAlpha, S.glow, true);
      else drawTrail2D(count, colorSet.rgb[ci], colorSet.core[ci], lw, S.glow);
    }
    if (S.body > 0) {
      const v = o.view, n = o.n;
      const fpos = o.periodic ? head % n : Math.min(head, n - 1);
      const i0 = Math.floor(fpos), t = fpos - i0, i1 = o.periodic ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
      const size = Math.max(10, fit * 0.075) * S.body * (0.5 + 0.5 * Math.min(1.5, S.glow + 0.3));
      for (let b = 0; b < 3; b++) {
        const x = cx + (v[i0 * 6 + 2 * b] * (1 - t) + v[i1 * 6 + 2 * b] * t) * scale;
        const y = cy + (v[i0 * 6 + 2 * b + 1] * (1 - t) + v[i1 * 6 + 2 * b + 1] * t) * scale;
        // heavier bodies drawn larger (radius ∝ m^(1/3) relative to the mean mass)
        const ms = o.masses ? Math.min(1.7, Math.max(0.6, Math.cbrt(3 * o.masses[b] / (o.masses[0] + o.masses[1] + o.masses[2])))) : 1;
        const sz = size * ms;
        if (GL) GL.body(x, y, sz, colorSet.rgb[perm[b]], S.glow);
        else ctx.drawImage(colorSet.sprite[perm[b]], x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    drawLabel(cell, rect, isFocus, o);
  }

  function drawLabel(cell, rect, isFocus, o) {
    const cx = rect.x + rect.w / 2;
    if (S.labels || isFocus) {
      const [a, b] = labelFor(cell.item, o);
      octx.fillStyle = 'rgba(233,228,239,0.75)';
      octx.font = `${isFocus ? 13 : 11}px ui-sans-serif, system-ui, sans-serif`;
      octx.textAlign = 'center';
      octx.fillText(a, cx, rect.y + rect.h - (isFocus ? 34 : 22));
      octx.fillStyle = 'rgba(160,150,175,0.75)';
      octx.fillText(b, cx, rect.y + rect.h - (isFocus ? 16 : 8));
    }
  }

  let grainPattern = null;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) clock += dt * S.speed;
    pump(12);
    // overlay: grain, hover, labels, loading dots
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!grainPattern) grainPattern = octx.createPattern(noise(), 'repeat');
    octx.fillStyle = grainPattern;
    octx.fillRect(0, 0, overlay.width, overlay.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rects = cellRects();
    if (hoverIdx >= 0 && !focus && rects[hoverIdx]) {
      const r = rects[hoverIdx];
      octx.fillStyle = 'rgba(255,255,255,0.025)';
      octx.fillRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    }
    if (GL) GL.begin(colorSet.bg, dpr, S.view === 'braid' ? S.glow * 0.3 : S.glow);
    else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = colorSet.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    }
    placeZoomControl(focus && S.view === 'braid' ? rects[0] : null);
    if (focus) drawCell(focus, rects[0], true);
    else cells.forEach((c, k) => drawCell(c, rects[k], false));
    if (GL) GL.flush();
    else ctx.globalCompositeOperation = 'source-over';
    if (recordCanvas) {
      const rc = recordCanvas.getContext('2d');
      rc.drawImage(canvas, 0, 0); rc.drawImage(overlay, 0, 0);
    }
    requestAnimationFrame(frame);
  }

  // Stage (orbits) + overlay (labels, grain) flattened into one canvas
  function composite() {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d');
    g.drawImage(canvas, 0, 0); g.drawImage(overlay, 0, 0);
    return c;
  }
  let recordCanvas = null;

  // ---------- braid time-window zoom ----------
  // The window (in scale-invariant time t*) is shared by the slider, the +/- buttons,
  // the mouse wheel and the +/- keys. The slider is logarithmic over [SPAN_MIN, SPAN_MAX].
  const SPAN_MIN = 1, SPAN_MAX = 400, SPAN_REF = 8, ZOOM_STEP = 1.5; // SPAN_REF: full-width window (the default)
  const sliderFromSpan = (v) => Math.round(1000 * Math.log(v / SPAN_MIN) / Math.log(SPAN_MAX / SPAN_MIN));
  const spanFromSlider = (x) => SPAN_MIN * Math.pow(SPAN_MAX / SPAN_MIN, x / 1000);
  const fmtSpan = (v) => (v < 10 ? v.toFixed(1) : v.toFixed(0));
  function syncBraidSpan() {
    $('braidSpan').value = sliderFromSpan(S.braidSpan);
    $('braidSpanOut').textContent = 't* = ' + fmtSpan(S.braidSpan);
    $('zoomIn').disabled = S.braidSpan <= SPAN_MIN * 1.0001;
    $('zoomOut').disabled = S.braidSpan >= SPAN_MAX * 0.9999;
    $('zoomValue').textContent = fmtSpan(S.braidSpan);
  }
  function setBraidSpan(v) {
    S.braidSpan = Math.max(SPAN_MIN, Math.min(SPAN_MAX, v));
    syncBraidSpan(); save();
  }
  let zoomRectKey = '';
  function placeZoomControl(rect) {
    const el = $('braidZoom');
    const key = rect ? `${Math.round(rect.x + rect.w)},${Math.round(rect.y)}` : '';
    if (key === zoomRectKey) return;
    zoomRectKey = key;
    el.hidden = !rect;
    if (rect) { el.style.left = `${rect.x + rect.w - 56}px`; el.style.top = `${rect.y + 16}px`; }
  }

  // ---------- UI wiring ----------
  function seg(id, key, cb) {
    const el = $(id);
    const sync = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === S[key]));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      S[key] = b.dataset.v; sync(); save(); cb && cb();
    });
    sync();
  }
  function range(id, key, fmt, cb) {
    const el = $(id), out = $(id + 'Out');
    el.value = S[key];
    const show = () => { if (out) out.textContent = fmt(S[key]); };
    el.addEventListener('input', () => { S[key] = +el.value; show(); save(); cb && cb(); });
    show();
  }
  function check(id, key, cb) {
    const el = $(id); el.checked = !!S[key];
    el.addEventListener('change', () => { S[key] = el.checked; save(); cb && cb(); });
  }
  function num(id, key, cb) {
    const el = $(id); el.value = S[key];
    const lo = el.min === '' ? -Infinity : +el.min, hi = el.max === '' ? Infinity : +el.max;
    // apply valid values live while typing / using the spinner; clamp on commit
    const integer = el.step === ''; // no step attribute (rows, columns): whole numbers only
    const parse = () => { const v = parseFloat(el.value); return integer ? Math.round(v) : v; };
    el.addEventListener('input', () => {
      const v = parse();
      if (!isFinite(v) || v < lo || v > hi || v === S[key]) return;
      S[key] = v; save(); cb && cb();
    });
    el.addEventListener('change', () => {
      const v = parse();
      const c = isFinite(v) ? Math.max(lo, Math.min(hi, v)) : S[key];
      el.value = c;
      if (c !== S[key]) { S[key] = c; save(); cb && cb(); }
    });
  }

  function syncCollectionOpts() {
    $('freefallOpts').hidden = S.collection !== 'freefall';
    $('classicOpts').hidden = S.collection !== 'classic';
    $('liaoOpts').hidden = S.collection !== 'liao';
  }
  function onCollection() {
    syncCollectionOpts();
    if (S.collection === 'freefall') buildFFList();
    if (S.collection === 'liao') buildLLList();
    S.page = 0; closeFocus(); buildCells();
  }
  function onFFChange() { buildFFList(); S.page = 0; buildCells(); }
  function onLLChange() { buildLLList(); S.page = 0; buildCells(); }

  function updatePager() {
    const total = collectionSize();
    const per = S.rows * S.cols;
    $('pgInfo').textContent = total ? `${S.page * per + 1}–${Math.min(total, (S.page + 1) * per)} of ${total.toLocaleString()}` : 'no matches';
  }
  function gotoPage(p) { S.page = Math.max(0, Math.min(pageCount() - 1, p)); save(); buildCells(); }

  function reproject() { for (const o of cache.values()) if (o.pos) projectOrbit(o); }

  function initUI() {
    const syncView = () => { $('braidOpts').hidden = S.view !== 'braid'; };
    seg('viewSeg', 'view', syncView);
    syncView();
    $('braidSpan').addEventListener('input', () => setBraidSpan(spanFromSlider(+$('braidSpan').value)));
    syncBraidSpan();
    $('zoomIn').onclick = () => setBraidSpan(S.braidSpan / ZOOM_STEP);
    $('zoomOut').onclick = () => setBraidSpan(S.braidSpan * ZOOM_STEP);
    canvas.addEventListener('wheel', (e) => {
      if (!focus || S.view !== 'braid') return;
      e.preventDefault();
      setBraidSpan(S.braidSpan * Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.002))));
    }, { passive: false });
    range('braidAngle', 'braidAngle', (v) => v + '°');
    check('braidSpin', 'braidSpin');
    range('braidGap', 'braidGap', (v) => v.toFixed(1) + '×');
    seg('collectionSeg', 'collection', onCollection);
    seg('timingSeg', 'timing');
    $('ffSort').value = S.ffSort;
    $('ffSort').addEventListener('change', () => { S.ffSort = $('ffSort').value; shuffleSeed = (Math.random() * 1e9) | 0; save(); onFFChange(); });
    check('ffSelfDual', 'ffSelfDual', onFFChange);
    check('ffDistinct', 'ffDistinct', onFFChange);
    num('ffTmin', 'ffTmin', onFFChange);
    num('ffTmax', 'ffTmax', onFFChange);
    $('pgPrev').onclick = () => gotoPage(S.page - 1);
    $('pgNext').onclick = () => gotoPage(S.page + 1);
    $('pgShuffle').onclick = () => gotoPage(Math.floor(Math.random() * pageCount()));
    num('rows', 'rows', () => { S.page = 0; buildCells(); });
    num('cols', 'cols', () => { S.page = 0; buildCells(); });
    check('labels', 'labels');
    check('orient', 'orient', reproject);
    range('loop', 'loop', (v) => v + ' s');
    range('speed', 'speed', (v) => v.toFixed(2) + '×');
    check('randPhase', 'randPhase');
    $('playBtn').onclick = togglePlay;
    $('restartBtn').onclick = () => { clock = 0; };
    $('palette').value = S.palette;
    const syncCustom = () => { $('customColors').hidden = S.palette !== 'custom'; };
    $('palette').addEventListener('change', () => {
      S.palette = $('palette').value; syncCustom(); save(); rebuildColors();
    });
    ['c1', 'c2', 'c3', 'cbg'].forEach((id, k) => {
      $(id).value = S.custom[k];
      $(id).addEventListener('input', () => { S.custom[k] = $(id).value; save(); rebuildColors(); });
    });
    syncCustom();
    check('shuffleColors', 'shuffleColors');
    range('trail', 'trail', (v) => Math.round(v * 100) + '% of period');
    range('width', 'width', (v) => v.toFixed(1));
    range('glow', 'glow', (v) => v.toFixed(2));
    range('body', 'body', (v) => v.toFixed(2));
    check('ghost', 'ghost');
    $('pngBtn').onclick = savePNG;
    $('recBtn').onclick = recordLoop;
    $('panelToggle').onclick = () => $('panel').classList.toggle('open');
    if (innerWidth < 900) $('panel').classList.remove('open');
    syncCollectionOpts();
    for (const k of ['llMass', 'llClass', 'llSort']) {
      $(k).value = S[k];
      $(k).addEventListener('change', () => { S[k] = $(k).value; if (k === 'llSort') shuffleSeed = (Math.random() * 1e9) | 0; save(); onLLChange(); });
    }

    canvas.addEventListener('mousemove', (e) => { hoverIdx = focus ? -1 : hitCell(e.clientX, e.clientY); });
    canvas.addEventListener('mouseleave', () => { hoverIdx = -1; });
    canvas.addEventListener('click', (e) => {
      if (focus) return;
      const k = hitCell(e.clientX, e.clientY);
      if (k >= 0 && cells[k]) openFocus(cells[k]);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 's' || e.key === 'S') $('panel').classList.toggle('open');
      else if (e.key === 'b' || e.key === 'B') document.querySelector(`#viewSeg [data-v=${S.view === 'braid' ? 'orbits' : 'braid'}]`).click();
      else if (e.key === 'Escape') closeFocus();
      else if (e.key === 'ArrowRight' && !focus) gotoPage(S.page + 1);
      else if (e.key === 'ArrowLeft' && !focus) gotoPage(S.page - 1);
      else if ((e.key === '+' || e.key === '=') && focus && S.view === 'braid') setBraidSpan(S.braidSpan / ZOOM_STEP);
      else if ((e.key === '-' || e.key === '_') && focus && S.view === 'braid') setBraidSpan(S.braidSpan * ZOOM_STEP);
    });
    $('backBtn').onclick = closeFocus;
    initInspector();
  }

  function hitCell(x, y) {
    const rects = cellRects();
    return rects.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }
  function togglePlay() { playing = !playing; $('playBtn').textContent = playing ? 'Pause' : 'Play'; }

  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms || 2200);
  }

  function savePNG() {
    composite().toBlob((b) => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'three-body.png'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }
  let recording = false;
  function recordLoop() {
    if (recording) return;
    if (!canvas.captureStream || typeof MediaRecorder === 'undefined') { toast('Recording is not supported in this browser'); return; }
    const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { toast('No supported video format'); return; }
    // record a flattened copy of stage + overlay, refreshed every frame
    recordCanvas = document.createElement('canvas');
    recordCanvas.width = canvas.width; recordCanvas.height = canvas.height;
    const stream = recordCanvas.captureStream(60);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      recording = false; recordCanvas = null; $('recBtn').textContent = 'Record loop';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(chunks, { type: mime }));
      a.download = 'three-body.' + (mime.includes('mp4') ? 'mp4' : 'webm'); a.click();
    };
    // one full loop of the longest-period cell on screen
    const cs = focus ? [focus] : cells;
    let dur = S.loop;
    if (S.timing === 'scaled' || S.view === 'braid') dur = Math.max(...cs.map((c) => { const o = getOrbit(c.item); return o && o.Tstar ? S.loop * o.Tstar / 15 : S.loop; }));
    const secs = Math.min(120, dur / Math.max(0.05, S.speed));
    clock = 0; playing = true; $('playBtn').textContent = 'Pause';
    recording = true; $('recBtn').textContent = `Recording ${secs.toFixed(0)} s…`;
    rec.start();
    setTimeout(() => rec.stop(), secs * 1000);
  }

  // ---------- inspector ----------
  function fmt(v, d) { return Number.isFinite(v) ? (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(d || 6) : v.toPrecision(d || 10)) : '–'; }

  function openFocus(cell) {
    focus = { item: cell.item, phaseOffset: cell.phaseOffset, perm: cell.perm, base: cell.item };
    enqueue(focus.item);
    $('inspector').hidden = false;
    fillInspector();
  }
  function setFocusItem(item, keepBase) {
    if (!focus) focus = { phaseOffset: 0, perm: PERMS[0] };
    focus.item = item;
    if (!keepBase) focus.base = item;
    enqueue(item);
    clock = 0;
    $('inspector').hidden = false;
    fillInspector();
  }
  function closeFocus() { focus = null; $('inspector').hidden = true; }

  function fillInspector() {
    const item = focus.item, base = focus.base;
    const dl = $('insData');
    const rows = [];
    let title = 'Orbit', sub = '';
    const { s, m } = itemState(item);
    if (item.kind === 'classic') {
      const c = CLASSICS[item.idx];
      title = c.name; sub = c.ref;
      rows.push(['Period T', fmt(c.T, 8)], ['Energy E', fmt(Physics.energy(c.s, [1, 1, 1]), 8)]);
    } else if (item.kind === 'll') {
      const c = llData()[item.idx];
      title = `Li & Liao ${c.name}` + (c.m3 !== 1 ? ` (m₃ = ${c.m3})` : '');
      sub = c.m3 === 1 ? 'Li & Liao 2017 — equal masses, zero angular momentum' : 'Li, Jing & Liao 2018 — unequal masses, zero angular momentum';
      rows.push(['Masses', `1, 1, ${c.m3}`], ['v₁, v₂', `${c.v1}, ${c.v2}`], ['Period T', fmt(c.T, 11)],
        ['T* = T|E|³ᐟ²', c.Ts.toFixed(3)], ['Energy E', fmt(Physics.energy(s, m), 8)], ['Word length', c.Lf]);
    } else if (item.kind === 'ff') {
      const D = ffData(), i = item.idx;
      title = `Free-fall solution #${D.sol[i] + 1}`;
      sub = 'Hristov et al. 2023 — equal masses, zero initial velocities';
      const duals = [];
      for (let j = Math.max(0, i - 3); j < Math.min(D.n, i + 4); j++) if (j !== i && D.sol[j] === D.sol[i]) duals.push(j);
      rows.push(['x', D.x[i].toPrecision(17)], ['y', D.y[i].toPrecision(17)], ['T', fmt(D.T[i], 12)],
        ['T* = T|E|³ᐟ²', fmt(D.Ts[i], 10)], ['Energy E', fmt(Physics.energy(s, m), 10)],
        ['Lyapunov λ', D.lyap[i].toFixed(3) + '  (growth e^λ per period)'],
        ['Self-dual', D.sd[i] ? 'yes — symmetric under t → T/2' : 'no'],
        ['i.c. index', (i + 1) + ' of 24,582']);
      focus.duals = duals;
      if (duals.length) rows.push(['Dual i.c.', `<button class="link" id="dualBtn">show i.c. ${duals[0] + 1}</button>`]);
    } else {
      title = item.title || 'Custom simulation';
      sub = item.sub || 'User-defined initial conditions';
      rows.push(['Masses', item.m.map((v) => fmt(v, 4)).join(', ')], ['Duration', fmt(item.dur, 6)],
        ['Energy E', fmt(Physics.energy(item.s, item.m), 8)]);
    }
    const o = getOrbit(item);
    if (o && o.vHalf !== undefined) rows.push(['|v| at T/2', o.vHalf.toExponential(2) + ' (ideal 0)']);
    if (o && o.returnDist !== undefined) rows.push(['Return error', o.returnDist.toExponential(2)]);
    $('insTitle').textContent = title;
    $('insSub').textContent = sub;
    dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const db = $('dualBtn');
    if (db) db.onclick = () => setFocusItem(ffItem(focus.duals[0]));
    const isFF = item.kind === 'ff' || (item.kind === 'custom' && item.freefall);
    $('domainSec').hidden = !(isFF || S.collection === 'freefall');
    $('stabSec').hidden = base.kind === 'custom' && !base.periodic;
    fillICTable(s, m);
    drawDomain();
    if (!o) setTimeout(() => focus && focus.item === item && fillInspector(), 120);
  }

  function fillICTable(s, m) {
    const tb = $('icBody');
    const sw = (k) => `<span class="swatch" style="background:${currentColors().c[(focus.perm || PERMS[0])[k]]}"></span>`;
    let h = '';
    for (let b = 0; b < 3; b++) {
      h += `<tr><td>${sw(b)}</td>` + [m[b], s[2 * b], s[2 * b + 1], s[6 + 2 * b], s[7 + 2 * b]]
        .map((v, j) => `<td><input data-b="${b}" data-j="${j}" value="${+(+v).toPrecision(10)}" inputmode="decimal"></td>`).join('') + '</tr>';
    }
    tb.innerHTML = h;
    const o = getOrbit(focus.item);
    $('icDur').value = o && Number.isFinite(o.T) ? +o.T.toPrecision(6) : 10;
  }

  function initInspector() {
    $('icRun').onclick = () => {
      const s = new Array(12).fill(0), m = [1, 1, 1];
      let ok = true;
      $('icBody').querySelectorAll('input').forEach((el) => {
        const v = parseFloat(el.value), b = +el.dataset.b, j = +el.dataset.j;
        if (!isFinite(v)) { ok = false; return; }
        if (j === 0) m[b] = v; else if (j <= 2) s[2 * b + j - 1] = v; else s[6 + 2 * b + j - 3] = v;
      });
      const dur = parseFloat($('icDur').value);
      if (!ok || !(dur > 0) || m.some((v) => !(v > 0))) { $('icMsg').textContent = 'Enter numbers; masses and duration must be positive.'; return; }
      $('icMsg').textContent = '';
      const periodic = $('icPeriodic').checked;
      setFocusItem({ kind: 'custom', key: 'u' + Math.random(), s, m, dur, periodic, samples: 3000 + 400 * dur,
        title: 'Custom simulation', sub: periodic ? 'Looped as periodic with the given duration' : 'Plays once, then restarts' });
    };
    $('pertRun').onclick = () => {
      const base = focus.base;
      const o = getOrbit(base);
      if (!o) return;
      const eps = Math.pow(10, +$('pertExp').value || -6);
      const P = Math.max(1, Math.min(20, +$('pertPeriods').value || 4));
      const { s, m } = itemState(base);
      s[0] += eps;
      setFocusItem({ kind: 'custom', key: 'p' + base.key + eps + P, s, m, dur: o.T * P, periodic: false,
        samples: Math.min(40000, o.n * P), freefall: base.kind === 'ff',
        title: `Perturbed by 10^${Math.log10(eps).toFixed(0)}`, sub: `${P} periods of the nudged orbit — watch it drift` }, true);
    };
    $('pertReset').onclick = () => setFocusItem(focus.base);
    initDomain();
  }

  // ---------- Agekyan–Anosova domain map ----------
  const dom = { x0: -0.06, y0: -0.05, span: 0.96 };
  function domXY(cv, px, py) {
    const W = cv.width, s = W / dom.span, offX = (W - 0.62 * s) / 2;
    return [(px - offX) / s + dom.x0, dom.y0 + (W - py) / s];
  }
  function domPX(cv, x, y) {
    const W = cv.width, s = W / dom.span, offX = (W - 0.62 * s) / 2;
    return [offX + (x - dom.x0) * s, W - (y - dom.y0) * s];
  }
  let domBase = null;
  function initDomain() {
    const cv = $('domain');
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      const [x, y] = domXY(cv, (e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height);
      if ($('freePick').checked) {
        if (x < -0.5 || y < 0) return;
        setFocusItem({ kind: 'custom', key: 'd' + x + ',' + y, s: Physics.freeFallState(x, y), m: [1, 1, 1], dur: 12, periodic: false,
          freefall: true, samples: 12000, px: x, py: y, title: `Free fall from (${x.toFixed(4)}, ${y.toFixed(4)})`, sub: 'Arbitrary start — generally not periodic' });
        return;
      }
      const D = ffData();
      let best = -1, bd = Infinity;
      for (let i = 0; i < D.n; i++) {
        const d = (D.x[i] - x) ** 2 + (D.y[i] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) setFocusItem(ffItem(best));
    });
  }
  function drawDomain() {
    if ($('domainSec').hidden) return;
    const cv = $('domain'), g = cv.getContext('2d');
    const W = Math.round(cv.getBoundingClientRect().width * dpr) || 300;
    if (cv.width !== W) { cv.width = cv.height = W; domBase = null; }
    if (!domBase) {
      domBase = document.createElement('canvas'); domBase.width = domBase.height = W;
      const b = domBase.getContext('2d');
      b.fillStyle = '#08070c'; b.fillRect(0, 0, W, W);
      // boundary of D: x >= 0, y >= 0, (x + 0.5)^2 + y^2 <= 1
      b.strokeStyle = 'rgba(255,255,255,0.35)'; b.lineWidth = 1 * dpr;
      b.beginPath();
      let p = domPX(cv, 0, 0); b.moveTo(...p);
      p = domPX(cv, 0.5, 0); b.lineTo(...p);
      for (let a = 0; a <= 60; a += 1) { const r = (a * Math.PI) / 180; b.lineTo(...domPX(cv, -0.5 + Math.cos(r), Math.sin(r))); }
      b.closePath(); b.stroke();
      const D = ffData();
      const ps = Math.max(1, dpr * 0.9);
      for (let i = 0; i < D.n; i++) {
        const [px, py] = domPX(cv, D.x[i], D.y[i]);
        b.fillStyle = D.sd[i] ? 'rgba(255,138,61,0.95)' : 'rgba(154,166,255,0.38)';
        b.fillRect(px - ps / 2, py - ps / 2, D.sd[i] ? ps * 2 : ps, D.sd[i] ? ps * 2 : ps);
      }
      b.fillStyle = 'rgba(255,255,255,0.55)';
      b.font = `${10 * dpr}px ui-sans-serif, system-ui`;
      p = domPX(cv, 0.5, 0); b.fillText('B(0.5, 0)', p[0] - 44 * dpr, p[1] - 6 * dpr);
      p = domPX(cv, 0, 0.866); b.fillText('x = 0', p[0] + 5 * dpr, p[1] + 12 * dpr);
    }
    g.drawImage(domBase, 0, 0);
    let cur = null;
    if (focus.item.kind === 'ff') { const D = ffData(); cur = [D.x[focus.item.idx], D.y[focus.item.idx]]; }
    else if (focus.item.px !== undefined) cur = [focus.item.px, focus.item.py];
    else if (focus.base.kind === 'ff') { const D = ffData(); cur = [D.x[focus.base.idx], D.y[focus.base.idx]]; }
    if (cur) {
      const [px, py] = domPX(cv, cur[0], cur[1]);
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 * dpr;
      g.beginPath(); g.arc(px, py, 5 * dpr, 0, 7); g.stroke();
    }
  }

  // ---------- boot ----------
  resize();
  rebuildColors();
  initUI();
  if (S.collection === 'freefall') buildFFList();
  if (S.collection === 'liao') buildLLList();
  buildCells();
  window.addEventListener('resize', () => { resize(); domBase = null; if (focus) drawDomain(); });
  requestAnimationFrame(frame);
})();
