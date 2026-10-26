/* Clouds view: evolve a cloud of nearby states and show its objects at resolution ε (core in clouds.js).
   Left: the cloud coloured by object; right: N(ε, t), the dendrogram now, and the prediction
   t_split ≈ ln(ε/δ₀)/λ. Systems: the Chirikov standard map and three-body clouds around catalogued orbits. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const C = window.Clouds, P = window.Physics;
  // categorical slots 1–3 (validated all-pairs on the dark surface); every other object is neutral
  const OBJ = ['#3987e5', '#d95926', '#199e70'], OTHER = 'rgba(190,184,204,.55)';
  const INK = 'rgba(160,150,175,.9)', GRID = 'rgba(255,255,255,.06)', AXIS = 'rgba(255,255,255,.22)';
  const dpr = () => Math.min(2, window.devicePixelRatio || 1);

  // three-body presets: λ_p per period from the monodromy (lifetime census / Hristov et al.)
  const ORBITS = [
    { name: 'Figure-eight (stable)', kind: 'classic', idx: 0, lam: 0, periods: 20, r0: -6 },
    { name: 'Butterfly I (λ_p = 0.57 per period)', kind: 'classic', idx: 2, lam: 0.574, periods: 20, r0: -6 },
    { name: 'Li & Liao I.A 6, m₃ = 0.5 (λ_p = 2.7)', kind: 'll', idx: 700, lam: 2.709, periods: 8, r0: -8 },
    { name: 'Lagrange triangle (λ_p = 4.4)', kind: 'classic', idx: 1, lam: 4.443, periods: 4, r0: -8 },
    { name: 'Free fall, solution #2 (λ_p = 15.4)', kind: 'ff', idx: 2, lam: 15.428, periods: 2, r0: -9 },
  ];
  const st = {
    sys: 'std', K: 0.971635, center: [Math.PI, 1.0], orbit: 0, eps: -2, k: 0, playing: true,
    cloud: null, hist: null, lam: NaN, unit: 1, unitName: 'iterations', portrait: null, objects: null, job: 0, visible: false,
  };

  function orbitSpec(o) {
    if (o.kind === 'classic') {
      const c = window.CLASSICS[o.idx];
      return { s: c.s, m: [1, 1, 1], T: P.closedOrbit(c.s, [1, 1, 1], c.T, 2000).T };
    }
    if (o.kind === 'll') {
      const [, m3, v1, v2, T] = window.LIAO_DATA.split('\n')[o.idx].split(',').map(Number);
      return { s: [-1, 0, 1, 0, 0, 0, v1, v2, v1, v2, -2 * v1 / m3, -2 * v2 / m3], m: [1, 1, m3], T };
    }
    const [x, y, T] = window.ORBIT_DATA.split('\n')[o.idx].split(',').map(Number);
    return { s: P.freeFallState(x, y), m: [1, 1, 1], T };
  }

  // ---------- computation ----------
  async function run() {
    const job = ++st.job, N = +$('clN').value, r0 = 10 ** +$('clR0').value;
    st.cloud = st.hist = st.objects = null; st.k = 0;
    let last = performance.now();
    const tick = (label) => async (f) => {
      if (job !== st.job) throw new Error('cancelled');
      if (performance.now() - last > 40) { $('clMsg').textContent = `${label} … ${Math.round(100 * f)}%`; await new Promise((r) => setTimeout(r, 0)); last = performance.now(); }
    };
    try {
      if (st.sys === 'std') {
        st.K = +$('clK').value;
        if (!st.portrait || st.portrait.K !== st.K) st.portrait = { K: st.K, pts: C.stdPortrait(st.K, 260, 260) };
        st.cloud = C.stdCloud(st.center[0], st.center[1], st.K, N, r0, 200, 1);
        st.lam = C.stdLyapunov(st.center[0], st.center[1], st.K, 4000);
        st.lnL = C.runningMax(C.stdStretch(st.center[0], st.center[1], st.K, 200));
        st.unit = 1; st.unitName = 'iterations';
      } else {
        const o = ORBITS[st.orbit], sp = orbitSpec(o);
        const cloud = await C.threeBodyCloud(sp.s, sp.m, o.periods * sp.T, N, r0, 241, tick('Integrating members'));
        if (job !== st.job) return; // superseded while integrating
        st.cloud = cloud;
        // dense one-period path of the orbit for the background, centre-of-mass frame
        const res = P.integrateAR(sp.s, sp.m, o.kind === 'ff' ? sp.T / 2 : sp.T, { tol: 1e-12, maxDt: sp.T / 1500 });
        const Mm = sp.m[0] + sp.m[1] + sp.m[2];
        st.path = res.ss.map((x) => {
          const cx = (sp.m[0] * x[0] + sp.m[1] * x[2] + sp.m[2] * x[4]) / Mm, cy = (sp.m[0] * x[1] + sp.m[1] * x[3] + sp.m[2] * x[5]) / Mm;
          return [x[0] - cx, x[1] - cy, x[2] - cx, x[3] - cy, x[4] - cx, x[5] - cy];
        });
        st.bounds = null;
        st.lam = o.lam / sp.T; st.unit = sp.T; st.unitName = 'periods';
        $('clMsg').textContent = 'Stretching of the centre …'; await new Promise((r) => setTimeout(r, 0));
        const lnL = C.runningMax(C.tbStretch(sp.s, sp.m, o.periods * sp.T, 241));
        if (job !== st.job) return;
        st.lnL = lnL;
      }
      const hist = await C.history(st.cloud, tick('Clustering'));
      if (job !== st.job) return;
      st.hist = hist; st.k = 0; st.cache = {};
      $('clMsg').textContent = '';
      $('clT').max = st.cloud.frames.length - 1; $('clT').value = 0;
      st.playing = true; $('clPlay').textContent = '❚❚';
      refreshObjects(); draw();
    } catch (e) { if (e.message !== 'cancelled') $('clMsg').textContent = 'Failed: ' + e.message; }
  }
  function refreshObjects() {
    if (!st.hist) return;
    st.objects = C.objectsAt(st.cloud, st.k, 10 ** st.eps, st.cache || (st.cache = {}));
  }

  // ---------- drawing ----------
  function sizeCanvas(cv) {
    const W = cv.clientWidth, H = cv.clientHeight, r = dpr();
    cv.width = Math.round(W * r); cv.height = Math.round(H * r);
    const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, W, H);
    return { g, W, H };
  }
  const colorOf = (label) => (label < 3 ? OBJ[label] : OTHER);

  function drawPhase() {
    const { g, W, H } = sizeCanvas($('clPhase'));
    if (!st.cloud) return;
    const f = st.cloud.frames[st.k], N = st.cloud.N, lab = st.objects ? st.objects.labels : null;
    if (st.sys === 'std') {
      const S = Math.min(W - 60, H - 40), ox = 44 + (W - 60 - S) / 2, oy = 12;
      const X = (x) => ox + x / (2 * Math.PI) * S, Y = (p) => oy + S - p / (2 * Math.PI) * S;
      g.fillStyle = 'rgba(200,192,220,.16)';
      const pts = st.portrait.pts;
      for (let i = 0; i < pts.length; i += 2) g.fillRect(X(pts[i]), Y(pts[i + 1]), 1, 1);
      g.strokeStyle = AXIS; g.strokeRect(ox, oy, S, S);
      g.fillStyle = INK; g.font = '11px ui-sans-serif, system-ui'; g.textAlign = 'center';
      g.fillText('x', ox + S / 2, oy + S + 16); g.fillText('0', ox, oy + S + 16); g.fillText('2π', ox + S, oy + S + 16);
      g.save(); g.translate(ox - 18, oy + S / 2); g.rotate(-Math.PI / 2); g.fillText('p', 0, 0); g.restore();
      st.phaseMap = { ox, oy, S };
      for (const pass of [false, true]) for (let i = 0; i < N; i++) {
        const l = lab ? lab[i] : 0;
        if ((l < 3) !== pass) continue; // grey objects underneath
        g.fillStyle = colorOf(l); g.beginPath(); g.arc(X(f[2 * i]), Y(f[2 * i + 1]), 2.4, 0, 7); g.fill();
      }
      g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.beginPath(); g.arc(X(st.center[0]), Y(st.center[1]), 6, 0, 7); g.stroke();
    } else {
      // configuration: all three bodies of every member, centre-of-mass frame; faint trail of member 0
      if (!st.bounds) {
        let r = 0; for (const x of st.path || []) for (const v of x) r = Math.max(r, Math.abs(v));
        st.bounds = (r || 1.5) * 1.12;
      }
      const R = st.bounds, S = Math.min(W, H) - 30, ox = (W - S) / 2, oy = 14;
      const X = (x) => ox + (x / R + 1) / 2 * S, Y = (y) => oy + (1 - (y / R + 1) / 2) * S;
      g.strokeStyle = 'rgba(200,192,220,.22)'; g.lineWidth = 1;
      if (st.path) for (let b = 0; b < 3; b++) {
        g.beginPath();
        st.path.forEach((x, k) => { k ? g.lineTo(X(x[2 * b]), Y(x[2 * b + 1])) : g.moveTo(X(x[2 * b]), Y(x[2 * b + 1])); });
        g.stroke();
      }
      for (const pass of [false, true]) for (let i = 0; i < N; i++) {
        if (Number.isNaN(f[6 * i])) continue;
        const l = lab ? lab[i] : 0;
        if ((l < 3) !== pass) continue;
        g.fillStyle = colorOf(l);
        for (let b = 0; b < 3; b++) { g.beginPath(); g.arc(X(f[6 * i + 2 * b]), Y(f[6 * i + 2 * b + 1]), 2.2, 0, 7); g.fill(); }
      }
    }
  }

  const diam0 = () => { const h0 = st.hist.heights[0]; return h0[h0.length - 1]; };
  // first time the stretched cloud δ₀Λ(t) reaches ε
  function tPredicted() {
    if (!st.hist) return NaN;
    const target = Math.log(10 ** st.eps / diam0());
    for (let k = 0; k < st.lnL.length; k++) if (st.lnL[k] >= target) return st.cloud.times[k];
    return NaN;
  }
  function tMeasured() {
    if (!st.hist) return NaN;
    const eps = 10 ** st.eps, H = st.hist.heights;
    for (let k = 0; k < H.length; k++) if (C.countObjects(H[k], eps) > 1) return st.cloud.times[k];
    return NaN;
  }
  function growthRate() {
    // slope of ln N against t while 2 ≤ N ≤ N_members/3: the measured h(ε)
    const eps = 10 ** st.eps, H = st.hist.heights, ts = st.cloud.times, cap = st.cloud.N / 3;
    const xs = [], ys = [];
    for (let k = 0; k < H.length; k++) { const n = C.countObjects(H[k], eps); if (n >= 2 && n <= cap) { xs.push(ts[k]); ys.push(Math.log(n)); } }
    if (xs.length < 4) return NaN;
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    return sxx ? sxy / sxx : NaN;
  }

  function drawCount() {
    const { g, W, H } = sizeCanvas($('clCount'));
    if (!st.hist) return;
    const m = { l: 34, r: 8, t: 8, b: 26 }, ts = st.cloud.times, T1 = ts[ts.length - 1] / st.unit, Nmax = st.cloud.N;
    const sx = (t) => m.l + t / st.unit / T1 * (W - m.l - m.r), sy = (n) => H - m.b - Math.log10(n) / Math.log10(Nmax) * (H - m.t - m.b);
    g.font = '10px ui-sans-serif, system-ui'; g.lineWidth = 1;
    for (const n of [1, 10, 100, 1000].filter((v) => v <= Nmax)) {
      g.strokeStyle = GRID; g.beginPath(); g.moveTo(m.l, sy(n)); g.lineTo(W - m.r, sy(n)); g.stroke();
      g.fillStyle = INK; g.textAlign = 'right'; g.fillText(n, m.l - 5, sy(n) + 3);
    }
    const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => T1 / s <= 5) || 200;
    for (let t = 0; t <= T1 + 1e-9; t += step) { g.fillStyle = INK; g.textAlign = 'center'; g.fillText(+t.toFixed(2), sx(t * st.unit), H - m.b + 12); }
    g.strokeStyle = AXIS; g.beginPath(); g.moveTo(m.l, m.t); g.lineTo(m.l, H - m.b); g.lineTo(W - m.r, H - m.b); g.stroke();
    g.fillStyle = INK; g.textAlign = 'center'; g.fillText(st.unitName, m.l + (W - m.l - m.r) / 2, H - 2);
    // reference resolutions (muted) and the chosen ε (accent)
    const refs = [-5, -4, -3, -2, -1, 0].filter((e) => Math.abs(e - st.eps) > 0.2);
    const line = (eps, color, w) => {
      g.strokeStyle = color; g.lineWidth = w; g.beginPath();
      st.hist.heights.forEach((h, k) => { const x = sx(ts[k]), y = sy(C.countObjects(h, 10 ** eps)); k ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    };
    refs.forEach((e) => line(e, 'rgba(190,184,204,.22)', 1));
    // linear prediction from the stretching of the centre: N ≈ δ₀Λ(t)/ε
    g.save(); g.setLineDash([5, 4]); g.strokeStyle = 'rgba(233,228,239,.7)'; g.lineWidth = 1.3; g.beginPath();
    ts.forEach((t, k) => { const y = sy(C.predictedCount(st.lnL[k], diam0(), 10 ** st.eps, Nmax)); k ? g.lineTo(sx(t), y) : g.moveTo(sx(t), y); });
    g.stroke(); g.restore();
    line(st.eps, '#d95926', 2);
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1; g.beginPath(); g.moveTo(sx(ts[st.k]), m.t); g.lineTo(sx(ts[st.k]), H - m.b); g.stroke();
    $('clCountLegend').innerHTML = `<span><i class="ln" style="border-color:#d95926"></i>ε = 10<sup>${st.eps.toFixed(2)}</sup></span>` +
      `<span><i class="ln" style="border-color:rgba(190,184,204,.5)"></i>ε = 10⁻⁵ … 1</span><span><i class="ln dash" style="border-color:rgba(233,228,239,.7)"></i>δ₀Λ*(t)/ε</span>`;
  }

  function drawDendro() {
    const { g, W, H } = sizeCanvas($('clDendro'));
    const ob = st.objects;
    if (!ob) return;
    const N = st.cloud.N, m = { l: 34, r: 8, t: 8, b: 14 };
    const hs = ob.merges.map((x) => x.h).filter((h) => h > 0 && Number.isFinite(h));
    const lo = Math.max(-8, Math.floor(Math.log10(Math.min(...hs, 10 ** st.eps)) - 0.2)), hi = Math.ceil(Math.log10(Math.max(...hs, 10 ** st.eps)) + 0.1);
    const sy = (h) => H - m.b - (Math.log10(Math.max(h, 10 ** lo)) - lo) / (hi - lo) * (H - m.t - m.b);
    const pos = new Float64Array(2 * N), ht = new Float64Array(2 * N).fill(10 ** lo);
    ob.leaves.forEach((leaf, i) => { pos[leaf] = m.l + (i + 0.5) / N * (W - m.l - m.r); });
    g.font = '10px ui-sans-serif, system-ui';
    for (let e = lo; e <= hi; e++) {
      g.strokeStyle = GRID; g.beginPath(); g.moveTo(m.l, sy(10 ** e)); g.lineTo(W - m.r, sy(10 ** e)); g.stroke();
      g.fillStyle = INK; g.textAlign = 'right'; g.fillText(`10${String(e).replace('-', '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d])}`, m.l - 4, sy(10 ** e) + 3);
    }
    g.strokeStyle = 'rgba(220,214,230,.55)'; g.lineWidth = 1;
    ob.merges.forEach((mm, i) => {
      const id = N + i, h = Number.isFinite(mm.h) ? mm.h : 10 ** hi;
      const x1 = pos[mm.a], x2 = pos[mm.b], y = sy(h);
      g.beginPath(); g.moveTo(x1, sy(ht[mm.a])); g.lineTo(x1, y); g.lineTo(x2, y); g.lineTo(x2, sy(ht[mm.b])); g.stroke();
      pos[id] = (x1 + x2) / 2; ht[id] = h;
    });
    // leaves coloured by object at ε, and the cut
    ob.leaves.forEach((leaf, i) => { g.fillStyle = colorOf(ob.labels[leaf]); g.fillRect(m.l + i / N * (W - m.l - m.r), H - m.b + 3, Math.max(1, (W - m.l - m.r) / N), 5); });
    g.save(); g.setLineDash([5, 4]); g.strokeStyle = '#d95926'; g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(m.l, sy(10 ** st.eps)); g.lineTo(W - m.r, sy(10 ** st.eps)); g.stroke(); g.restore();
  }

  function stats() {
    if (!st.hist) { $('clStats').innerHTML = ''; return; }
    const ob = st.objects, eps = 10 ** st.eps, u = st.unit, nm = st.unitName;
    const tp = tPredicted(), tm = tMeasured(), h = growthRate(), h0 = st.hist.heights[0];
    const rows = [
      ['Objects now', `${ob ? ob.sizes.length : '–'} <span class="muted">of ${st.cloud.N}</span>`],
      ['λ (long run)', st.lam > 1e-9 ? `${(st.lam * u).toFixed(3)} <span class="muted">per ${nm === 'periods' ? 'period' : 'iteration'}</span>` : '≈ 0 <span class="muted">(no exponential instability)</span>'],
      ['<span title="largest stretching ln ‖DΦ_s‖ of the centre for s ≤ t">ln Λ*(t)</span>', st.lnL[st.k].toFixed(2)],
      ['Cloud diameter δ₀', h0[h0.length - 1].toExponential(1)],
      ['<span title="running diameter of the cloud divided by the linear prediction δ₀Λ*(t); ≈ 1 while the cloud is small">Diameter / δ₀Λ*</span>',
        (() => { const hk = st.hist.heights[st.k], d = hk[hk.length - 1] / (h0[h0.length - 1] * Math.exp(st.lnL[st.k])); return Number.isFinite(d) ? d.toFixed(2) : '–'; })()],
      ['First split at ε', Number.isFinite(tm) ? `${(tm / u).toFixed(2)} ${nm}` : `none within ${(st.cloud.times[st.cloud.times.length - 1] / u).toFixed(0)} ${nm}`],
      ['Predicted: δ₀Λ* = ε', Number.isFinite(tp) ? `${(tp / u).toFixed(2)} ${nm}` : `not within ${(st.cloud.times[st.cloud.times.length - 1] / u).toFixed(0)} ${nm}`],
      ['<span title="slope of ln N against t while 2 ≤ N ≤ N/3: the measured h(ε)">Growth of ln N</span>', Number.isFinite(h) ? `${(h * u).toFixed(3)} <span class="muted">per ${nm === 'periods' ? 'period' : 'iteration'}</span>` : '–'],
    ];
    const lost = st.hist.lost[st.k];
    if (lost) rows.push(['Members lost', `${lost} <span class="muted">(collision or escape)</span>`]);
    $('clStats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  function draw() {
    if (!st.visible) return;
    drawPhase(); drawCount(); drawDendro(); stats();
    $('clEpsOut').innerHTML = `10<sup>${st.eps.toFixed(2)}</sup>`;
    if (st.cloud) $('clTOut').textContent = `${(st.cloud.times[st.k] / st.unit).toFixed(st.unit === 1 ? 0 : 2)} ${st.unitName}`;
  }

  // ---------- playback ----------
  let lastT = 0, acc = 0, loopId = 0;
  function loop(now, id) {
    if (!st.visible || id !== loopId) return; // hidden, or superseded by a newer loop
    const dt = Math.min(0.1, (now - lastT) / 1000 || 0); lastT = now;
    if (st.playing && st.hist) {
      acc += dt * 24; // frames per second
      if (acc >= 1) {
        const n = Math.floor(acc); acc -= n;
        st.k = Math.min(st.cloud.frames.length - 1, st.k + n);
        if (st.k === st.cloud.frames.length - 1) { st.playing = false; $('clPlay').textContent = '▶'; }
        $('clT').value = st.k; refreshObjects(); draw();
      }
    }
    requestAnimationFrame((t) => loop(t, id));
  }

  function setSystem(s) {
    st.sys = s; st.bounds = null;
    document.querySelectorAll('#cloudSys button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
    document.querySelectorAll('#clouds .cl-std').forEach((el) => { el.hidden = s !== 'std'; });
    document.querySelectorAll('#clouds .cl-tb').forEach((el) => { el.hidden = s !== 'tb'; });
    $('clR0').value = s === 'std' ? -4 : ORBITS[st.orbit].r0;
    run();
  }

  function init() {
    $('clOrbit').innerHTML = ORBITS.map((o, i) => `<option value="${i}">${o.name}</option>`).join('');
    document.querySelectorAll('#cloudSys button').forEach((b) => b.addEventListener('click', () => setSystem(b.dataset.s)));
    $('clIsland').onclick = () => { st.center = [Math.PI, 1.0]; run(); };
    $('clChaos').onclick = () => { st.center = [0.05, 0.05]; run(); };
    $('clK').addEventListener('change', run);
    $('clN').addEventListener('change', run);
    $('clR0').addEventListener('change', run);
    $('clOrbit').addEventListener('change', () => { st.orbit = +$('clOrbit').value; st.bounds = null; $('clR0').value = ORBITS[st.orbit].r0; run(); });
    $('clEps').addEventListener('input', () => { st.eps = +$('clEps').value; refreshObjects(); draw(); });
    $('clT').addEventListener('input', () => {
      if (!st.hist) return; // nothing to scrub while a cloud is being computed
      st.k = Math.min(+$('clT').value, st.cloud.frames.length - 1); st.playing = false; $('clPlay').textContent = '▶'; refreshObjects(); draw(); });
    $('clPlay').onclick = () => {
      if (!st.cloud) return;
      if (!st.playing && st.k === st.cloud.frames.length - 1) st.k = 0;
      st.playing = !st.playing; $('clPlay').textContent = st.playing ? '❚❚' : '▶';
    };
    $('clPhase').addEventListener('click', (e) => {
      if (st.sys !== 'std' || !st.phaseMap) return;
      const b = $('clPhase').getBoundingClientRect(), { ox, oy, S } = st.phaseMap;
      const x = (e.clientX - b.left - ox) / S * 2 * Math.PI, p = (1 - (e.clientY - b.top - oy) / S) * 2 * Math.PI;
      if (x < 0 || x > 2 * Math.PI || p < 0 || p > 2 * Math.PI) return;
      st.center = [x, p]; run();
    });
    window.addEventListener('resize', draw);
  }

  let started = false;
  window.CloudView = {
    show() {
      const wasVisible = st.visible;
      st.visible = true;
      if (!started) { started = true; init(); setSystem('std'); }
      // one playback loop only: it stops by itself once the view is hidden
      if (!wasVisible) { const id = ++loopId; lastT = performance.now(); requestAnimationFrame((t) => loop(t, id)); }
      draw();
    },
    hide() { st.visible = false; },
    draw,
  };
})();
