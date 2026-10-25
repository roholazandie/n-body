/* Braid lab: census of braid invariants over every catalogued orbit (data from
   scripts/braid-census.js). Scatter with hover/click, correlation statistics and
   Nielsen–Thurston type counts. Talks to main.js through window.ThreeBodyApp. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // Categorical slots 1–3 of the validated reference palette (dark steps; all-pairs checked
  // against the app surface #0d0b12): fixed order, colour follows the collection.
  const SERIES = [
    { name: 'Classic', color: '#3987e5', r: 4.5 },
    { name: 'Li & Liao', color: '#d95926', r: 2.6 },
    { name: 'Free fall', color: '#199e70', r: 1.8 },
  ];
  const TYPES = ['periodic', 'reducible', 'pseudo-Anosov'];
  const AXES = {
    Tstar: { label: 'Scale-invariant period T*', get: (r) => r.Tstar },
    cross: { label: 'Braid crossings (freely reduced)', get: (r) => r.cross },
    syz: { label: 'Syzygies (free fall: half period)', get: (r) => r.syz },
    f2len: { label: 'Free-group word length', get: (r) => (r.col === 1 || r.col === 0 ? r.f2len : NaN) },
    lyap: { label: 'Lyapunov exponent per period (free fall)', get: (r) => (r.col === 2 ? r.lyap : NaN) },
    logLambda: { label: 'Braid entropy log λ per period', get: (r) => r.logLambda },
    rate: { label: 'Braid entropy per unit t*:  log λ / T*', get: (r) => r.logLambda / r.Tstar },
  };

  let rows = null;
  const state = { x: 'Tstar', y: 'logLambda', show: [true, true, true], hover: null, logX: false, logY: false };
  function data() {
    if (rows) return rows;
    if (!window.BRAID_DATA) return (rows = []);
    rows = window.BRAID_DATA.split('\n').map((l) => {
      const p = l.split(',');
      return { col: +p[0], idx: +p[1], Tstar: +p[2], cross: +p[3], syz: +p[4], f2len: +p[5], digits: +p[6],
        logLambda: +p[7], type: +p[8], expSum: +p[9], cycle: +p[10], consistent: +p[11], valid: +p[12],
        lyap: p[13] === '' ? NaN : +p[13], sd: p[14] === '1' };
    });
    return rows;
  }
  function lookup(col, idx) { return data().find((r) => r.col === col && r.idx === idx) || null; }

  // ---------- statistics ----------
  function ranks(a) {
    const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length);
    for (let i = 0; i < o.length;) {
      let j = i;
      while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++;
      for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  }
  function pearson(x, y) {
    const n = x.length; if (n < 3) return NaN;
    let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxy / Math.sqrt(sxx * syy);
  }
  const spearman = (x, y) => pearson(ranks(x), ranks(y));
  function slope(x, y) {
    const n = x.length; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
    let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    return sxy / sxx;
  }

  // ---------- plot ----------
  let pts = []; // [{px, py, r(row)}] for hit testing
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  const fmt = (v) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : +v.toPrecision(3) + '');

  function draw() {
    const cv = $('labPlot'); if (!cv || $('lab').hidden) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const AX = AXES[state.x], AY = AXES[state.y];
    // optional log10 axes (points with non-positive values are dropped there)
    const ax = { label: state.logX ? `${AX.label}  (log₁₀)` : AX.label, get: state.logX ? (r) => { const v = AX.get(r); return v > 0 ? Math.log10(v) : NaN; } : AX.get };
    const ay = { label: state.logY ? `${AY.label}  (log₁₀)` : AY.label, get: state.logY ? (r) => { const v = AY.get(r); return v > 0 ? Math.log10(v) : NaN; } : AY.get };
    const vis = data().filter((r) => state.show[r.col] && Number.isFinite(ax.get(r)) && Number.isFinite(ay.get(r)));
    const m = { l: 62, r: 16, t: 14, b: 46 };
    if (!vis.length) {
      g.fillStyle = 'rgba(200,190,215,.7)'; g.font = '13px ui-sans-serif, system-ui'; g.textAlign = 'center';
      g.fillText('No orbits have both of these quantities — pick other axes or collections.', W / 2, H / 2);
      pts = []; return;
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of vis) { const x = ax.get(r), y = ay.get(r); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const px = (x1 - x0) * 0.04 || 1, py = (y1 - y0) * 0.05 || 1; x0 -= px; x1 += px; y0 = state.logY ? y0 - py : Math.min(0, y0 - py); y1 += py;
    const sx = (v) => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r), sy = (v) => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
    // recessive grid + axes
    g.font = '11px ui-sans-serif, system-ui'; g.lineWidth = 1;
    for (const t of niceTicks(x0, x1, 7)) {
      g.strokeStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(sx(t), m.t); g.lineTo(sx(t), H - m.b); g.stroke();
      g.fillStyle = 'rgba(160,150,175,.9)'; g.textAlign = 'center'; g.fillText(fmt(t), sx(t), H - m.b + 16);
    }
    for (const t of niceTicks(y0, y1, 6)) {
      g.strokeStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(m.l, sy(t)); g.lineTo(W - m.r, sy(t)); g.stroke();
      g.fillStyle = 'rgba(160,150,175,.9)'; g.textAlign = 'right'; g.fillText(fmt(t), m.l - 8, sy(t) + 4);
    }
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.beginPath(); g.moveTo(m.l, m.t); g.lineTo(m.l, H - m.b); g.lineTo(W - m.r, H - m.b); g.stroke();
    g.fillStyle = 'rgba(220,214,230,.9)'; g.textAlign = 'center'; g.font = '12px ui-sans-serif, system-ui';
    g.fillText(ax.label, m.l + (W - m.l - m.r) / 2, H - 10);
    g.save(); g.translate(16, m.t + (H - m.t - m.b) / 2); g.rotate(-Math.PI / 2); g.fillText(ay.label, 0, 0); g.restore();
    // points: most numerous first so the rarer collections stay visible on top
    pts = [];
    for (const col of [2, 1, 0]) {
      if (!state.show[col]) continue;
      const s = SERIES[col];
      g.fillStyle = s.color; g.globalAlpha = col === 2 ? 0.45 : col === 1 ? 0.7 : 1;
      for (const r of vis) {
        if (r.col !== col) continue;
        const X = sx(ax.get(r)), Y = sy(ay.get(r));
        g.beginPath(); g.arc(X, Y, s.r, 0, 7); g.fill();
        pts.push({ X, Y, r });
      }
    }
    g.globalAlpha = 1;
    // surface ring + direct label on the figure-eight (classic #0) when visible
    const f8 = pts.find((p) => p.r.col === 0 && p.r.idx === 0);
    if (f8) {
      g.strokeStyle = '#0d0b12'; g.lineWidth = 2; g.beginPath(); g.arc(f8.X, f8.Y, 6.5, 0, 7); g.stroke();
      g.fillStyle = 'rgba(233,228,239,.92)'; g.textAlign = 'left'; g.font = '11px ui-sans-serif, system-ui';
      g.fillText('figure-eight  (σ₁σ₂⁻¹)³', f8.X + 9, f8.Y - 7);
    }
    if (state.hover) {
      const h = state.hover;
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(h.X, h.Y, SERIES[h.r.col].r + 3, 0, 7); g.stroke();
    }
    stats(vis, ax, ay);
  }

  function stats(vis, ax, ay) {
    let h = '<table class="lab-table"><thead><tr><th></th><th>n</th><th title="Spearman rank correlation">ρ</th><th title="Pearson correlation">r</th><th title="least-squares slope">slope</th></tr></thead><tbody>';
    for (let col = 0; col < 3; col++) {
      if (!state.show[col]) continue;
      const sub = vis.filter((r) => r.col === col);
      const x = sub.map(ax.get), y = sub.map(ay.get);
      const cells = sub.length >= 3 ? [spearman(x, y), pearson(x, y), slope(x, y)].map((v) => (Number.isFinite(v) ? v.toFixed(3) : '–')) : ['–', '–', '–'];
      h += `<tr><td><i class="sw" style="background:${SERIES[col].color}"></i>${SERIES[col].name}</td><td>${sub.length.toLocaleString()}</td><td>${cells.join('</td><td>')}</td></tr>`;
    }
    h += '</tbody></table>';
    $('labStats').innerHTML = h;
    // Nielsen–Thurston types per collection (independent of axes)
    let t = '<table class="lab-table"><thead><tr><th></th>' + TYPES.map((x) => `<th>${x}</th>`).join('') + '</tr></thead><tbody>';
    for (let col = 0; col < 3; col++) {
      const sub = data().filter((r) => r.col === col);
      const c = [0, 0, 0]; sub.forEach((r) => c[r.type]++);
      t += `<tr><td><i class="sw" style="background:${SERIES[col].color}"></i>${SERIES[col].name}</td>` +
        c.map((v) => `<td>${v.toLocaleString()} <span class="muted">${sub.length ? Math.round(100 * v / sub.length) : 0}%</span></td>`).join('') + '</tr>';
    }
    $('labTypes').innerHTML = t + '</tbody></table>';
  }

  function header() {
    const M = window.BRAID_META;
    if (!M) { $('labSummary').textContent = 'No census data found — run  node scripts/braid-census.js'; return; }
    const v = M.validation;
    const liaoBad = v.liaoTotal - v.liaoWordMatch;
    $('labSummary').innerHTML =
      `<span class="chip ok">✓ Li &amp; Liao free-group words: ${v.liaoWordMatch.toLocaleString()} / ${v.liaoTotal.toLocaleString()}</span>` +
      (liaoBad ? `<span class="chip">${liaoBad} published entr${liaoBad === 1 ? 'y' : 'ies'} inconsistent with their own length column</span>` : '') +
      `<span class="chip ok">✓ Self-dual syzygy sequences: ${v.selfDualSeqMatch} / ${v.selfDualTotal}</span>` +
      `<span class="chip ok">✓ Projection-independent invariants: ${v.projectionConsistent.toLocaleString()} / ${v.total.toLocaleString()}</span>`;
    $('labLegend').innerHTML = SERIES.map((s, i) => {
      const n = data().filter((r) => r.col === i).length;
      return `<label class="check"><input type="checkbox" data-col="${i}" ${state.show[i] ? 'checked' : ''}><i class="sw" style="background:${s.color}"></i>${s.name} <span class="muted">${n.toLocaleString()}</span></label>`;
    }).join('');
    $('labLegend').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => { state.show[+el.dataset.col] = el.checked; draw(); }));
  }

  function hit(e) {
    const cv = $('labPlot'), b = cv.getBoundingClientRect(), X = e.clientX - b.left, Y = e.clientY - b.top;
    let best = null, bd = 100; // 10 px radius
    for (const p of pts) { const d = (p.X - X) ** 2 + (p.Y - Y) ** 2; if (d < bd) { bd = d; best = p; } }
    return best;
  }
  function tooltip(p, e) {
    const tip = $('labTip');
    if (!p) { tip.hidden = true; return; }
    const r = p.r, app = window.ThreeBodyApp;
    const name = app ? app.orbitName(r.col, r.idx) : `${SERIES[r.col].name} #${r.idx + 1}`;
    tip.innerHTML = `<b>${name}</b><br>${AXES[state.x].label}: ${fmt(AXES[state.x].get(r))}<br>${AXES[state.y].label}: ${fmt(AXES[state.y].get(r))}` +
      `<br>${TYPES[r.type]} · ${r.cross} crossings${r.valid === 1 ? ' · <span class="okc">validated</span>' : ''}<br><span class="muted">click to open</span>`;
    const b = $('labPlot').getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${Math.min(b.width - 230, e.clientX - b.left + 14)}px`;
    tip.style.top = `${Math.max(0, e.clientY - b.top - 10)}px`;
  }

  function init() {
    const fill = (id, keys) => { $(id).innerHTML = keys.map((k) => `<option value="${k}">${AXES[k].label}</option>`).join(''); };
    fill('labX', ['Tstar', 'cross', 'syz', 'f2len', 'lyap']);
    fill('labY', ['logLambda', 'rate', 'cross']);
    $('labX').value = state.x; $('labY').value = state.y;
    $('labX').addEventListener('change', () => { state.x = $('labX').value; draw(); });
    $('labY').addEventListener('change', () => { state.y = $('labY').value; draw(); });
    $('labLogX').addEventListener('change', () => { state.logX = $('labLogX').checked; draw(); });
    $('labLogY').addEventListener('change', () => { state.logY = $('labLogY').checked; draw(); });
    const cv = $('labPlot');
    cv.addEventListener('mousemove', (e) => { const p = hit(e); if (p !== state.hover) { state.hover = p; draw(); } tooltip(p, e); cv.style.cursor = p ? 'pointer' : 'default'; });
    cv.addEventListener('mouseleave', () => { state.hover = null; $('labTip').hidden = true; draw(); });
    cv.addEventListener('click', (e) => { const p = hit(e); if (p && window.ThreeBodyApp) window.ThreeBodyApp.openOrbit(p.r.col, p.r.idx); });
    window.addEventListener('resize', draw);
    header();
  }

  window.BraidLab = { init, draw, lookup, show() { header(); draw(); } };
})();
