// Objects at finite resolution: evolve a cloud of nearby states and ask which members are still "one
// object" at resolution ε. Following the paper, two members belong to one object at (ε, t) if their
// distance stayed within ε over the whole window [0, t]: with D_ij(t) = max_{s≤t} d_ij(s), an object is
// a set of members of D-diameter ≤ ε, i.e. a complete-linkage cluster. D only grows, so objects only
// split as t grows or ε shrinks, and the merge heights form an ultrametric hierarchy (the dendrogram).
// Single linkage would not do: a continuously stretched filament stays chained together forever.
// Two systems: the Chirikov standard map (mixed phase space: KAM islands and a chaotic sea) and the
// three-body problem (clouds around catalogued periodic orbits). Core runs in Node and the browser
// (window.Clouds); the view is attached in the browser only.
function cloudsFactory(Physics) {
  'use strict';
  const TAU = 2 * Math.PI;

  // seeded uniform random numbers (reproducible clouds)
  function rng(seed) {
    let x = (seed * 2654435761) % 4294967296 || 1;
    return () => { x = (1664525 * x + 1013904223) % 4294967296; return x / 4294967296; };
  }
  const gauss = (rnd) => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(TAU * rnd());

  // ---------- Chirikov standard map: p' = p + K sin x, x' = x + p' (both mod 2π) ----------
  const wrap = (v) => ((v % TAU) + TAU) % TAU;
  function stdStep(x, p, K) { const q = wrap(p + K * Math.sin(x)); return [wrap(x + q), q]; }
  // background phase portrait: points of many orbits
  function stdPortrait(K, nOrbits, nIter) {
    const out = new Float32Array(nOrbits * nIter * 2), rnd = rng(7);
    let k = 0;
    for (let o = 0; o < nOrbits; o++) {
      let x = TAU * rnd(), p = TAU * rnd();
      for (let i = 0; i < nIter; i++) { [x, p] = stdStep(x, p, K); out[k++] = x; out[k++] = p; }
    }
    return out;
  }
  // largest Lyapunov exponent per iteration along the orbit of (x, p): tangent map
  // [[1 + K cos x, 1], [K cos x, 1]] (x before the step), renormalised every step
  function stdLyapunov(x, p, K, n) {
    let u = 1, v = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      const c = K * Math.cos(x);
      const nu = (1 + c) * u + v, nv = c * u + v, g = Math.hypot(nu, nv);
      u = nu / g; v = nv / g; acc += Math.log(g);
      [x, p] = stdStep(x, p, K);
    }
    return acc / n;
  }
  // cumulative stretching ln Λ(t) = ln ‖DΦ_t‖ (largest singular value of the 2×2 Jacobian product) along
  // the orbit of (x, p), t = 0 … steps. It is the finite-time version of the exponent: near a hyperbolic
  // point it far exceeds the long-run λ, and on a KAM torus it grows only linearly (shear).
  function stdStretch(x, p, K, steps) {
    let a = 1, b = 0, c = 0, d = 1, logScale = 0;
    const out = new Float64Array(steps + 1);
    for (let i = 0; i < steps; i++) {
      const k = K * Math.cos(x);
      // [[1 + k, 1], [k, 1]] · [[a, b], [c, d]]
      const na = (1 + k) * a + c, nb = (1 + k) * b + d, nc = k * a + c, nd = k * b + d;
      a = na; b = nb; c = nc; d = nd;
      const m = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
      // rescale long before squares and products of entries could overflow (|entry|² ≤ 1e60)
      if (m > 1e30) { a /= m; b /= m; c /= m; d /= m; logScale += Math.log(m); }
      // largest singular value of [[a, b], [c, d]]
      const s1 = a * a + b * b + c * c + d * d, det = a * d - b * c;
      const sig = Math.sqrt((s1 + Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))) / 2);
      out[i + 1] = logScale + Math.log(sig);
      [x, p] = stdStep(x, p, K);
    }
    return out;
  }
  // cloud of N points uniform in a disk of radius r0 around (x0, p0); frames[k] = Float64Array(2N)
  function stdCloud(x0, p0, K, N, r0, steps, seed) {
    const rnd = rng(seed || 1), f0 = new Float64Array(2 * N);
    for (let i = 0; i < N; i++) {
      const r = r0 * Math.sqrt(rnd()), a = TAU * rnd();
      f0[2 * i] = wrap(x0 + r * Math.cos(a)); f0[2 * i + 1] = wrap(p0 + r * Math.sin(a));
    }
    const frames = [f0];
    for (let k = 0; k < steps; k++) {
      const a = frames[k], b = new Float64Array(2 * N);
      for (let i = 0; i < N; i++) { const [x, p] = stdStep(a[2 * i], a[2 * i + 1], K); b[2 * i] = x; b[2 * i + 1] = p; }
      frames.push(b);
    }
    return { frames, dim: 2, N, times: frames.map((_, k) => k), torus: true };
  }

  // ---------- three-body clouds ----------
  // States at K uniform times in [0, tEnd], integrating exactly to each frame time (no interpolation:
  // Hermite resampling on each run's own step grid adds ~10⁻⁹ noise near close encounters, which
  // finite differences and small clouds would see). Returns Float64Array(12K) of states; after a
  // failure (collision, escape) the remaining frames are NaN.
  function framesExact(s0, m, tEnd, K, tol) {
    const out = new Float64Array(12 * K).fill(NaN), dt = tEnd / (K - 1);
    let s = Array.from(s0);
    out.set(s, 0);
    for (let k = 1; k < K; k++) {
      const r = Physics.integrateAR(s, m, dt, { tol: tol || 1e-12 });
      if (Math.abs(r.ts[r.ts.length - 1] - dt) > 1e-9 * (1 + dt)) break;
      s = Array.from(r.ss[r.ss.length - 1]);
      out.set(s, 12 * k);
    }
    return out;
  }
  // configuration relative to the centre of mass, frame k
  function cmPositions(st, k, m, out, off) {
    const M = m[0] + m[1] + m[2];
    let cx = 0, cy = 0;
    for (let b = 0; b < 3; b++) { cx += m[b] * st[12 * k + 2 * b] / M; cy += m[b] * st[12 * k + 2 * b + 1] / M; }
    for (let b = 0; b < 3; b++) { out[off + 2 * b] = st[12 * k + 2 * b] - cx; out[off + 2 * b + 1] = st[12 * k + 2 * b + 1] - cy; }
  }
  // N members displaced from s0 by r0 in random phase-space directions (centre-of-mass motion removed),
  // integrated for tEnd; frames hold the positions relative to the centre of mass (the configuration,
  // as in the definition of an object) at K uniform times.
  async function threeBodyCloud(s0, m, tEnd, N, r0, K, tick, seed) {
    const rnd = rng(seed || 1), M = m[0] + m[1] + m[2];
    const frames = Array.from({ length: K }, () => new Float64Array(6 * N));
    for (let i = 0; i < N; i++) {
      const d = Array.from({ length: 12 }, () => gauss(rnd));
      for (const off of [0, 1, 6, 7]) {
        let c = 0; for (let b = 0; b < 3; b++) c += m[b] * d[off + 2 * b] / M;
        for (let b = 0; b < 3; b++) d[off + 2 * b] -= c;
      }
      const nn = Math.hypot(...d), s = s0.map((v, j) => v + r0 * d[j] / nn);
      const traj = framesExact(s, m, tEnd, K);
      for (let k = 0; k < K; k++) cmPositions(traj, k, m, frames[k], 6 * i); // NaN after a collision or escape
      if (tick) await tick((i + 1) / N);
    }
    return { frames, dim: 6, N, times: frames.map((_, k) => (k / (K - 1)) * tEnd), torus: false };
  }

  // ln Λ(t) = ln ‖DΦ_t‖ for the configuration (centre-of-mass positions) along the orbit of s0, from 12
  // central-difference trajectories with h = 10⁻⁹ (linear while hΛ ≪ 1, i.e. up to Λ ~ 10⁷, past any
  // split of interest). ‖·‖ is the largest singular value of the 6×12 position block, by power
  // iteration on AᵀA. Independent of the cloud: a prediction, not a fit.
  function tbStretch(s0, m, tEnd, K) {
    const h = 1e-9, P = [], Q = [], tmp = new Float64Array(6), tmq = new Float64Array(6);
    for (let i = 0; i < 12; i++) {
      const a = s0.slice(), b = s0.slice(); a[i] += h; b[i] -= h;
      P.push(framesExact(a, m, tEnd, K, 1e-13)); Q.push(framesExact(b, m, tEnd, K, 1e-13));
    }
    const out = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const A = P.map((pa, i) => {
        cmPositions(pa, k, m, tmp, 0); cmPositions(Q[i], k, m, tmq, 0);
        return tmp.map((v, r) => (v - tmq[r]) / (2 * h));
      });
      if (A.some((col) => col.some((v) => !Number.isFinite(v)))) { out[k] = out[k - 1] || 0; continue; }
      let v = new Float64Array(12).fill(1), sig = 0;
      for (let it = 0; it < 40; it++) {
        const w = new Float64Array(6);
        for (let i = 0; i < 12; i++) for (let r = 0; r < 6; r++) w[r] += A[i][r] * v[i];
        const u = new Float64Array(12);
        for (let i = 0; i < 12; i++) for (let r = 0; r < 6; r++) u[i] += A[i][r] * w[r];
        const n = Math.hypot(...u); if (!(n > 0)) break;
        sig = Math.sqrt(n / Math.hypot(...v)); v = u.map((x) => x / n);
      }
      out[k] = Math.log(Math.max(sig, 1e-300));
    }
    // normalise so that ln Λ(0) = 0 (the position block at t = 0 has unit norm)
    const z = out[0]; for (let k = 0; k < K; k++) out[k] -= z;
    return out;
  }

  // ---------- objects ----------
  function pairDist(f, i, j, dim, torus) {
    let s = 0;
    for (let c = 0; c < dim; c++) {
      let d = f[dim * i + c] - f[dim * j + c];
      if (torus) { d = Math.abs(d); if (d > Math.PI) d = TAU - d; }
      s += d * d;
    }
    return Math.sqrt(s);
  }
  // complete-linkage clustering of an N×N distance matrix (row-major Float64Array, destroyed) by the
  // nearest-neighbour chain algorithm, O(N²). Returns merges [{a, b, h}] sorted by height, where a and b
  // are cluster ids (0…N−1 leaves, N + k the k-th merge).
  function completeLinkage(D, N) {
    const active = new Uint8Array(N).fill(1), raw = [], chain = [], deferred = [];
    let left = N;
    while (left > 1) {
      if (!chain.length) { for (let i = 0; i < N; i++) if (active[i]) { chain.push(i); break; } }
      const a = chain[chain.length - 1], prev = chain.length > 1 ? chain[chain.length - 2] : -1;
      let b = -1, best = Infinity;
      for (let j = 0; j < N; j++) {
        if (!active[j] || j === a) continue;
        const d = D[a * N + j];
        if (d < best || (d === best && j === prev)) { best = d; b = j; }
      }
      // a cluster with no finite distance left (a member lost to a collision or escape) joins the rest only
      // at infinite height, i.e. after every finite merge: set it aside and attach it at the end
      if (b < 0) { active[a] = 0; left--; chain.pop(); deferred.push(a); continue; }
      if (b === prev) {
        // reciprocal nearest neighbours: merge slot a into slot b (Lance–Williams, complete linkage)
        chain.pop(); chain.pop();
        raw.push({ i: a, j: b, h: best });
        for (let k = 0; k < N; k++) {
          if (!active[k] || k === a || k === b) continue;
          const v = Math.max(D[a * N + k], D[b * N + k]);
          D[b * N + k] = v; D[k * N + b] = v;
        }
        active[a] = 0; left--;
      } else chain.push(b);
    }
    let root = -1;
    for (let i = 0; i < N; i++) if (active[i]) root = i;
    if (root < 0) root = deferred.pop();
    for (const d of deferred) raw.push({ i: d, j: root, h: Infinity });
    // The chain finds merges out of height order; complete linkage has no inversions, so replaying
    // them sorted by height (union–find on one leaf per slot) gives the dendrogram with cluster ids
    // 0…N−1 for leaves and N + k for the k-th merge.
    raw.sort((u, v) => u.h - v.h);
    const parent = Int32Array.from({ length: N }, (_, i) => i), rep = Int32Array.from({ length: N }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    return raw.map((r, k) => {
      const ra = find(r.i), rb = find(r.j);
      const mm = { a: rep[ra], b: rep[rb], h: r.h };
      parent[ra] = rb; rep[rb] = N + k;
      return mm;
    });
  }

  // Object hierarchy over time. For every frame: the running-max distance matrix D(t), and the sorted
  // complete-linkage merge heights, from which N(ε, t) = 1 + #{heights > ε} for any ε.
  async function history(cloud, tick) {
    const { frames, dim, N, torus } = cloud;
    const D = new Float64Array(N * N), W = new Float64Array(N * N);
    const heights = [], lost = [];
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k];
      let gone = 0;
      for (let i = 0; i < N; i++) {
        if (Number.isNaN(f[dim * i])) gone++;
        for (let j = i + 1; j < N; j++) {
          const d = pairDist(f, i, j, dim, torus);
          const v = Number.isFinite(d) ? Math.max(D[i * N + j], d) : Infinity;
          D[i * N + j] = v; D[j * N + i] = v;
        }
      }
      W.set(D);
      heights.push(Float64Array.from(completeLinkage(W, N).map((mm) => mm.h)));
      lost.push(gone);
      if (tick) await tick((k + 1) / frames.length);
    }
    return { heights, lost, final: D };
  }
  const countObjects = (h, eps) => { let n = 1; for (let i = h.length - 1; i >= 0 && h[i] > eps; i--) n++; return n; };

  // Objects at ε for one frame: the running-max matrix D(t) (advanced incrementally through `cache`
  // when frames are visited in order), complete linkage, and a cut at ε. Returns labels (object index
  // per member, by decreasing size), sizes, merges and a dendrogram leaf order.
  function objectsAt(cloud, k, eps, cache) {
    const { frames, dim, N, torus } = cloud;
    cache = cache || {};
    if (!cache.D || cache.k > k || cache.cloud !== cloud) { cache.D = new Float64Array(N * N); cache.k = -1; cache.cloud = cloud; cache.mk = -1; }
    const D = cache.D;
    for (let q = cache.k + 1; q <= k; q++) {
      const f = frames[q];
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const d = pairDist(f, i, j, dim, torus), v = Number.isFinite(d) ? Math.max(D[i * N + j], d) : Infinity;
        D[i * N + j] = v; D[j * N + i] = v;
      }
    }
    cache.k = k;
    if (cache.mk !== k) { cache.merges = completeLinkage(Float64Array.from(D), N); cache.mk = k; }
    const merges = cache.merges;
    const parent = Int32Array.from({ length: 2 * N }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    merges.forEach((mm, i) => { if (mm.h <= eps) { parent[find(mm.a)] = N + i; parent[find(mm.b)] = N + i; } });
    const root = Array.from({ length: N }, (_, i) => find(i));
    const size = new Map(); root.forEach((r) => size.set(r, (size.get(r) || 0) + 1));
    const order = [...size.keys()].sort((a, b) => size.get(b) - size.get(a));
    const rank = new Map(order.map((r, i) => [r, i]));
    // leaf order: depth-first through the merge tree from the root
    const kids = new Map(merges.map((mm, i) => [N + i, [mm.a, mm.b]]));
    const leaves = [], stack = [N + merges.length - 1];
    while (stack.length) { const c = stack.pop(); if (c < N) leaves.push(c); else { const [a, b] = kids.get(c); stack.push(b, a); } }
    return { labels: root.map((r) => rank.get(r)), sizes: order.map((r) => size.get(r)), merges, leaves };
  }

  // Objects are defined by the running maximum of distances, so the prediction uses the running maximum
  // of the stretching too: within a period it pulses (peaks at close encounters, then relaxes).
  const runningMax = (a) => { const o = Float64Array.from(a); for (let k = 1; k < o.length; k++) o[k] = Math.max(o[k], o[k - 1]); return o; };
  // Linear prediction for the number of objects: a cloud of diameter δ₀ is stretched into a filament of
  // length δ₀Λ*(t) (Λ* the running max), which holds about δ₀Λ*(t)/ε objects at resolution ε (at least
  // 1, at most N); the first split comes when δ₀Λ*(t) reaches ε.
  const predictedCount = (lnL, delta0, eps, N) => Math.min(N, Math.max(1, delta0 * Math.exp(lnL) / eps));

  return { stdStep, stdPortrait, stdLyapunov, stdStretch, tbStretch, runningMax, predictedCount, stdCloud, threeBodyCloud, completeLinkage, history, countObjects, objectsAt, rng };
}

if (typeof module !== 'undefined') module.exports = cloudsFactory(require('./physics.js'));
else self.Clouds = cloudsFactory(self.Physics);
