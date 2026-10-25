// Topology of three-body trajectories: syzygy sequences, free-group words (Montgomery),
// braid words in B3 and their invariants. Runs in the browser (window.Braid) and Node.
function braidFactory(Physics) {
  'use strict';

  // ---------- dense trajectory ----------
  // Steps are limited to a fraction of the local two-body time r_min^(3/2)/sqrt(M), so a
  // tight binary turns by only a small angle per step and no crossing is missed.
  function denseTrajectory(s0, m, tEnd, opts) {
    opts = opts || {};
    return Physics.integrateAR(s0, m, tEnd, {
      tol: opts.tol || 1e-12, maxDt: opts.maxDt || tEnd / 3000, maxPhase: opts.maxPhase || 0.08,
    });
  }

  // Cubic Hermite position of all bodies inside step k at u in [0, 1] -> out[6]
  function hermite(tr, k, u, out) {
    const a = tr.ss[k], b = tr.ss[k + 1], h = tr.ts[k + 1] - tr.ts[k];
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    for (let i = 0; i < 6; i++) out[i] = h00 * a[i] + h10 * h * a[i + 6] + h01 * b[i] + h11 * h * b[i + 6];
    return out;
  }

  // Append a straight-line return from the final configuration to the initial one, used to
  // close the half-period braid of a free-fall orbit (an "open" braid) into a loop.
  function closeLinearly(tr) {
    const last = tr.ss[tr.ss.length - 1], first = tr.ss[0], t0 = tr.ts[tr.ts.length - 1];
    const steps = 64, out = { ts: tr.ts.slice(), ss: tr.ss.slice() };
    const vel = new Float64Array(6);
    for (let i = 0; i < 6; i++) vel[i] = first[i] - last[i]; // displacement per unit pseudo-time
    for (let j = 0; j <= steps; j++) {
      const f = j / steps, s = new Float64Array(12);
      for (let i = 0; i < 6; i++) { s[i] = last[i] + f * vel[i]; s[6 + i] = vel[i]; }
      if (j === 0) { out.ss[out.ss.length - 1] = s; continue; }
      out.ts.push(t0 + f); out.ss.push(s);
    }
    return out;
  }

  const area = (p) => (p[2] - p[0]) * (p[5] - p[1]) - (p[4] - p[0]) * (p[3] - p[1]);
  function middleBody(p) {
    // along the line through the configuration, which body lies between the other two
    let dx = p[2] - p[0], dy = p[3] - p[1];
    const d13 = Math.hypot(p[4] - p[0], p[5] - p[1]), d12 = Math.hypot(dx, dy), d23 = Math.hypot(p[4] - p[2], p[5] - p[3]);
    if (d13 > d12 && d13 > d23) { dx = p[4] - p[0]; dy = p[5] - p[1]; }
    else if (d23 > d12) { dx = p[4] - p[2]; dy = p[5] - p[3]; }
    const s = [0, 1, 2].map((b) => p[2 * b] * dx + p[2 * b + 1] * dy);
    const order = [0, 1, 2].sort((a, b) => s[a] - s[b]);
    return order[1];
  }

  // Root of f on step k between sub-samples ua < ub (sign change), by bisection on the Hermite curve
  function refine(tr, k, ua, ub, f, fa, tmp) {
    for (let it = 0; it < 40; it++) {
      const um = 0.5 * (ua + ub), fm = f(hermite(tr, k, um, tmp));
      if ((fm > 0) === (fa > 0)) { ua = um; fa = fm; } else ub = um;
    }
    return 0.5 * (ua + ub);
  }

  const SUB = 8; // sub-samples per integrator step

  // Syzygies: collinear instants. Returns [{t, mid: 0|1|2, dir: +1 (area - -> +) | -1}]
  function syzygies(tr) {
    const out = [], p = new Float64Array(6), tmp = new Float64Array(6);
    let prev = area(hermite(tr, 0, 0, p));
    for (let k = 0; k < tr.ts.length - 1; k++) {
      let ua = 0;
      for (let j = 1; j <= SUB; j++) {
        const ub = j / SUB, cur = area(hermite(tr, k, ub, p));
        if (prev !== 0 && cur !== 0 && (cur > 0) !== (prev > 0)) {
          const u = refine(tr, k, ua, ub, area, prev, tmp);
          hermite(tr, k, u, p);
          out.push({ t: tr.ts[k] + u * (tr.ts[k + 1] - tr.ts[k]), mid: middleBody(p), dir: cur > 0 ? 1 : -1 });
        }
        if (cur !== 0) prev = cur;
        ua = ub;
      }
    }
    return out;
  }

  // Free-group word (Montgomery): cut the shape sphere along the two equatorial arcs where
  // bodies cutA / cutB are in the middle; crossing a cut gives a letter, its direction the
  // exponent. Letters: a, b and inverses A, B. Returned cyclically reduced.
  function f2Word(syz, cutA, cutB, flip) {
    const w = [];
    for (const z of syz) {
      let L = z.mid === cutA ? 'a' : z.mid === cutB ? 'b' : null;
      if (!L) continue;
      if ((z.dir < 0) !== !!flip) L = L.toUpperCase();
      w.push(L);
    }
    return cyclicReduce(w).join('');
  }
  const inv = (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  function freeReduce(w) {
    const st = [];
    for (const c of w) { if (st.length && st[st.length - 1] === inv(c)) st.pop(); else st.push(c); }
    return st;
  }
  function cyclicReduce(w) {
    let s = freeReduce(w);
    while (s.length > 1 && s[0] === inv(s[s.length - 1])) s = s.slice(1, -1);
    return s;
  }
  // Canonical representative of a conjugacy class: lexicographically least rotation
  function canonicalCyclic(word) {
    if (!word) return '';
    let best = word;
    for (let i = 1; i < word.length; i++) { const r = word.slice(i) + word.slice(0, i); if (r < best) best = r; }
    return best;
  }

  // Braid word from projection on axis θ: [{t, gen: 1|2, sign: ±1}], plus the strand order.
  // σ_i^{+1}: strands in positions i, i+1 exchange with the left one (moving right) in front,
  // where "front" means larger coordinate along the in-plane normal of the projection axis.
  function braidWord(tr, theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    const proj = (p, b) => p[2 * b] * c + p[2 * b + 1] * s;
    const depth = (p, b) => -p[2 * b] * s + p[2 * b + 1] * c;
    const p = new Float64Array(6), tmp = new Float64Array(6);
    hermite(tr, 0, 0, p);
    const order = [0, 1, 2].sort((a, b) => proj(p, a) - proj(p, b));
    const start = order.slice(), word = [];
    for (let k = 0; k < tr.ts.length - 1; k++) {
      let ua = 0;
      for (let j = 1; j <= SUB; j++) {
        const ub = j / SUB;
        hermite(tr, k, ub, p);
        // bubble the old order into the new one; each adjacent exchange is one generator
        let changed = true;
        while (changed) {
          changed = false;
          for (let q = 0; q < 2; q++) {
            const L = order[q], Rb = order[q + 1];
            if (proj(p, L) > proj(p, Rb)) {
              const f = (x) => proj(x, Rb) - proj(x, L);
              const fa = f(hermite(tr, k, ua, tmp));
              const u = fa > 0 ? refine(tr, k, ua, ub, f, fa, tmp) : 0.5 * (ua + ub);
              hermite(tr, k, u, tmp);
              word.push({ t: tr.ts[k] + u * (tr.ts[k + 1] - tr.ts[k]), gen: q + 1, sign: depth(tmp, L) > depth(tmp, Rb) ? 1 : -1 });
              order[q] = Rb; order[q + 1] = L; changed = true;
            }
          }
          hermite(tr, k, ub, p);
        }
        ua = ub;
      }
    }
    return { word, start, end: order.slice() };
  }

  // Free reduction of a braid word (cancels σ σ^{-1}); exact group identity, not a normal form
  function reduceBraid(word) {
    const st = [];
    for (const g of word) {
      const top = st[st.length - 1];
      if (top && top.gen === g.gen && top.sign === -g.sign) st.pop(); else st.push(g);
    }
    return st;
  }
  function braidString(word, max) {
    // compact: a = σ1, b = σ2, A = σ1⁻¹, B = σ2⁻¹, with run-length exponents
    const out = [];
    for (let i = 0; i < word.length && out.length < (max || 1e9);) {
      const g = word[i];
      let n = 1;
      while (i + n < word.length && word[i + n].gen === g.gen && word[i + n].sign === g.sign) n++;
      const L = g.gen === 1 ? (g.sign > 0 ? 'a' : 'A') : (g.sign > 0 ? 'b' : 'B');
      out.push(n > 1 ? L + n : L);
      i += n;
    }
    return out.join(' ');
  }

  // ---------- invariants ----------
  // B3 / <Δ²> ≅ PSL(2,Z): σ1 ↦ [[1,1],[0,1]], σ2 ↦ [[1,0],[-1,1]] (exact, BigInt)
  function pslImage(word) {
    let a = 1n, b = 0n, c = 0n, d = 1n; // M = [[a,b],[c,d]]
    for (const g of word) {
      const e = BigInt(g.sign);
      if (g.gen === 1) { b = b + a * e; d = d + c * e; }      // M · [[1,e],[0,1]]
      else { a = a - b * e; c = c - d * e; }                   // M · [[1,0],[-e,1]]
    }
    return [a, b, c, d];
  }
  function log10Big(x) {
    if (x < 0n) x = -x;
    if (x === 0n) return -Infinity;
    const s = x.toString(), k = Math.min(15, s.length);
    return Math.log10(Number(s.slice(0, k))) + (s.length - k);
  }
  function invariants(braid) {
    const word = braid.word;
    const [a, b, c, d] = pslImage(word);
    let tr = a + d; if (tr < 0n) tr = -tr;
    const central = b === 0n && c === 0n; // ±I: a power of the full twist, i.e. rigid rotation
    // permutation: compose the strand order changes
    const fixed = [0, 1, 2].filter((i) => braid.start.indexOf(i) === braid.end.indexOf(i)).length;
    const cycle = fixed === 3 ? 'identity' : fixed === 1 ? 'transposition' : '3-cycle';
    let expSum = 0;
    for (const g of word) expSum += g.sign;
    let type, logLambda = 0;
    if (tr < 2n || central) type = 'periodic';
    else if (tr === 2n) type = 'reducible';
    else {
      type = 'pseudo-Anosov';
      // λ = (t + sqrt(t² - 4)) / 2 ;  for large t, log λ ≈ log t
      const lt = log10Big(tr) * Math.LN10;
      logLambda = lt < 20 ? Math.log((Math.exp(lt) + Math.sqrt(Math.exp(2 * lt) - 4)) / 2) : lt;
    }
    return { trace: tr, traceDigits: tr.toString().length, type, logLambda, expSum, cycle, crossings: word.length };
  }

  // Full analysis of one orbit. kind: 'closed' (periodic, integrate T) or 'freefall' (half
  // period, then straight-line closure).
  function analyze(s0, m, T, kind, opts) {
    opts = opts || {};
    const tEnd = kind === 'freefall' ? T / 2 : T;
    let tr = denseTrajectory(s0, m, tEnd, opts);
    let syz;
    if (kind === 'freefall') syz = syzygies(tr);
    else {
      // Many orbits start exactly collinear, so a syzygy sits on t = 0 ≡ T. Count events in
      // the shifted window (δ, T + δ] on a trajectory extended slightly past T.
      const delta = 1e-3 * T, last = tr.ss[tr.ss.length - 1];
      const ext = denseTrajectory(last, m, 2 * delta, opts);
      const full = { ts: tr.ts.concat(ext.ts.slice(1).map((t) => t + T)), ss: tr.ss.concat(ext.ss.slice(1)) };
      syz = syzygies(full).filter((z) => z.t > delta && z.t <= T + delta);
    }
    if (kind === 'freefall') tr = closeLinearly(tr);
    const thetas = opts.thetas || [0.31, 1.13, 2.02];
    const braids = thetas.map((th) => braidWord(tr, th));
    const inv0 = invariants(braids[0]);
    // projection independence check: |trace| must agree across projection angles
    const consistent = braids.every((b) => invariants(b).trace === inv0.trace);
    return { syz, braid: braids[0], reduced: reduceBraid(braids[0].word), inv: inv0, consistent, steps: tr.ts.length };
  }

  return { denseTrajectory, syzygies, f2Word, canonicalCyclic, cyclicReduce, braidWord, reduceBraid, braidString, pslImage, invariants, analyze, closeLinearly, log10Big };
}

if (typeof module !== 'undefined') module.exports = braidFactory(require('./physics.js'));
else self.Braid = braidFactory(self.Physics);
