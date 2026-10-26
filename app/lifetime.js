// Lifetime of forms: how long a perturbed periodic orbit keeps the orbit's symbolic form
// (its periodic syzygy sequence), as a function of the perturbation size ε. Shadowing predicts
//   τ(ε) ≈ (ln δ − ln ε) / λ_p          (τ in periods, λ_p = ln max|μ| of the monodromy matrix)
// so τ against ln(1/ε) is a line of slope 1/λ_p. λ_p is computed independently here from the
// monodromy matrix (finite-difference Jacobians along the orbit). Runs in the browser
// (window.Lifetime) and Node.
function lifetimeFactory(Physics, Braid) {
  'use strict';
  const TOL = 1e-13;
  const dense = (s, m, t) => Braid.denseTrajectory(s, m, t, { tol: TOL, maxDt: t / 400 });
  const lastState = (tr) => tr.ss[tr.ss.length - 1];
  const reached = (tr, t) => tr.ts[tr.ts.length - 1] >= t * (1 - 1e-9);

  // ---------- the periodic form ----------
  // One period of syzygy symbols {t, mid, dir} in the window (t0, t0 + T], plus the dense
  // trajectory of that period (states at integrator steps) for the monodromy matrix.
  // kind 'freefall': integrate [0, T/2] and mirror (r(T−t) = r(t), so the area changes sign the
  // other way); 'closed': shift the window by δ = 10⁻³T because many orbits start collinear.
  function reference(s0, m, T, kind) {
    if (kind === 'freefall') {
      const tr = dense(s0, m, T / 2);
      const half = Braid.syzygies(tr);
      const back = half.slice().reverse().map((z) => ({ t: T - z.t, mid: z.mid, dir: -z.dir }));
      return { syz: half.concat(back), T, t0: 0, tr, kind };
    }
    const delta = 1e-3 * T;
    const tr = dense(s0, m, T);
    const ext = dense(lastState(tr), m, 2 * delta);
    const full = { ts: tr.ts.concat(ext.ts.slice(1).map((t) => t + T)), ss: tr.ss.concat(ext.ss.slice(1)) };
    const syz = Braid.syzygies(full).filter((z) => z.t > delta && z.t <= T + delta);
    return { syz, T, t0: delta, tr, kind };
  }

  // ---------- monodromy and λ_p ----------
  // State after time dt, or null. integrateAR lands on dt by a secant search on its fictitious
  // step; for very short dt that search can fail and leave the state slightly past dt, which
  // would corrupt a finite difference, so retry with a smaller first step.
  function flow(s, m, dt) {
    for (const H0 of [0.05, 1e-3, 1e-5]) {
      const tr = Physics.integrateAR(s, m, dt, { tol: TOL, H0 });
      if (Math.abs(tr.ts[tr.ts.length - 1] - dt) <= 1e-12 * (1 + dt)) return Array.from(lastState(tr));
    }
    return null;
  }
  // 12×12 Jacobian of the time-dt flow at s, by central differences
  function jacobian(s, m, dt) {
    const J = Array.from({ length: 12 }, () => new Float64Array(12));
    for (let i = 0; i < 12; i++) {
      const h = 1e-6, sp = Array.from(s), sm = Array.from(s);
      sp[i] += h; sm[i] -= h;
      const a = flow(sp, m, dt), b = flow(sm, m, dt);
      if (!a || !b) return null;
      for (let r = 0; r < 12; r++) J[r][i] = (a[r] - b[r]) / (2 * h);
    }
    return J;
  }
  const maxAbs = (J) => { let x = 0; for (const row of J) for (const v of row) x = Math.max(x, Math.abs(v)); return x; };
  const mul = (A, B) => A.map((row) => { const o = new Float64Array(12); for (let k = 0; k < 12; k++) { const a = row[k]; if (a) for (let j = 0; j < 12; j++) o[j] += a * B[k][j]; } return o; });

  // λ_p = ln max|μ| of the one-period monodromy matrix M = J_N ⋯ J_1, the product of
  // finite-difference Jacobians over consecutive pieces of the period.
  // Free-fall orbits: only the first half is integrated. The second half is its time reverse,
  // x(T − t) = R x(t) with R = diag(1, −1) on (positions, velocities), so with J₁ the half-period
  // Jacobian, M = R J₁⁻¹ R J₁. J₁ is symplectic (unit masses: momenta = velocities), hence
  // J₁⁻¹ = −Ω J₁ᵀ Ω exactly, with no ill-conditioned inversion. Integrating the second half instead
  // would carry the ~10⁻⁸ residual speed at T/2 into a non-closing loop and spurious eigenvalues.
  async function monodromy(s0, m, T, kind, tick) {
    const tEnd = kind === 'freefall' ? T / 2 : T;
    // Cut the period only where the bodies are well separated: restarting the integrator inside a
    // close encounter (kinetic and potential energy huge and nearly cancelling) costs precision that
    // the finite differences then amplify. Candidate cuts are integrator steps whose smallest pair
    // distance is at least half its upper-quartile value along the orbit.
    const tr = dense(s0, m, tEnd);
    const rmin = tr.ss.map((x) => Math.min(Math.hypot(x[2] - x[0], x[3] - x[1]), Math.hypot(x[4] - x[0], x[5] - x[1]), Math.hypot(x[4] - x[2], x[5] - x[3])));
    const q = rmin.slice().sort((u, v) => u - v)[Math.floor(0.75 * (rmin.length - 1))];
    const cuts = [0];
    for (let k = 1; k < tr.ts.length - 1; k++) if (rmin[k] >= 0.5 * q && tr.ts[k] < tEnd) cuts.push(tr.ts[k]);
    cuts.push(tEnd);
    // greedy: from the current cut, take the farthest of ~32 evenly spread cuts whose Jacobian grows
    // by less than 100 (larger growth makes the h = 10⁻⁶ differences nonlinear enough to split the
    // unit eigenvalues of stable, sheared orbits), halving the span (in cut index) otherwise
    const stride = Math.max(1, Math.floor((cuts.length - 1) / 32));
    let M = null, x = Array.from(s0), i = 0;
    while (i < cuts.length - 1) {
      let j = Math.min(cuts.length - 1, i + stride), J = null;
      for (;;) {
        J = jacobian(x, m, cuts[j] - cuts[i]);
        if (!J) return null;
        if (maxAbs(J) <= 100 || j === i + 1) break;
        j = i + Math.max(1, (j - i) >> 1);
      }
      const nx = flow(x, m, cuts[j] - cuts[i]);
      if (!nx) return null;
      M = M ? mul(J, M) : J;
      x = nx; i = j;
      if (tick) await tick(i / (cuts.length - 1));
    }
    if (kind === 'freefall') {
      // J⁻¹ = −Ω Jᵀ Ω with Ω = [[0, I], [−I, 0]]: blocks [[A, B], [C, D]] ↦ [[Dᵀ, −Bᵀ], [−Cᵀ, Aᵀ]]
      const J = M, inv = Array.from({ length: 12 }, () => new Float64Array(12));
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
        inv[i][j] = J[6 + j][6 + i]; inv[i][6 + j] = -J[j][6 + i];
        inv[6 + i][j] = -J[6 + j][i]; inv[6 + i][6 + j] = J[j][i];
      }
      const sgn = (i) => (i < 6 ? 1 : -1);
      const RinvR = inv.map((row, i) => row.map((v, j) => sgn(i) * v * sgn(j)));
      return { M: mul(RinvR, J), end: Array.from(s0) };
    }
    return { M, end: x };
  }
  async function lyapunov(ref, m, tick) {
    const r = await monodromy(ref.tr.ss[0], m, ref.T, ref.kind, tick);
    return r ? lambdaOf(r.M) : NaN;
  }
  function lambdaOf(M) {
    // power iteration: mean log growth per application of M
    let v = new Float64Array(12).map((_, i) => Math.sin(1.7 * i + 0.3));
    let acc = 0, n = 0;
    for (let it = 0; it < 400; it++) {
      const w = new Float64Array(12);
      for (let r = 0; r < 12; r++) { let x = 0; for (let k = 0; k < 12; k++) x += M[r][k] * v[k]; w[r] = x; }
      const g = Math.hypot(...w);
      if (!(g > 0) || !isFinite(g)) return NaN;
      for (let r = 0; r < 12; r++) v[r] = w[r] / g;
      if (it >= 200) { acc += Math.log(g); n++; }
    }
    return acc / n;
  }

  // ---------- refining a closed orbit ----------
  // Published initial conditions close only approximately (the classics, given to ~6 digits, miss
  // by up to 10⁻²). For an orbit with strong shear (a fast binary, a long period) that miss alone
  // splits the monodromy's unit eigenvalues into a spurious unstable pair, so closed orbits are
  // first refined by Newton shooting on (x₀, T): solve Φ_T(x₀) = x₀ with the linearisation
  // [M − I | f(x(T))] (δx, δT) = −r, taking the minimum-norm least-squares step because the
  // symmetries (time shift, rotation, conserved quantities) make the system singular.
  function deriv(x, m) {
    const f = new Float64Array(12);
    for (let i = 0; i < 6; i++) f[i] = x[6 + i];
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const dx = x[2 * b] - x[2 * a], dy = x[2 * b + 1] - x[2 * a + 1], r3 = Math.pow(dx * dx + dy * dy, 1.5);
      f[6 + 2 * a] += m[b] * dx / r3; f[7 + 2 * a] += m[b] * dy / r3;
      f[6 + 2 * b] -= m[a] * dx / r3; f[7 + 2 * b] -= m[a] * dy / r3;
    }
    return f;
  }
  function solve(A, b) { // Gaussian elimination with partial pivoting
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let v = M[r][n]; for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k]; x[r] = v / M[r][r]; }
    return x;
  }
  async function refine(s0, m, T, tick) {
    let x = Array.from(s0), Tx = T, closure0 = NaN, best = null;
    for (let it = 0; it < 6; it++) {
      const mono = await monodromy(x, m, Tx, 'closed', tick && ((f) => tick((it + f) / 6)));
      if (!mono) break;
      const r = mono.end.map((v, i) => v - x[i]), nr = Math.hypot(...r);
      if (it === 0) closure0 = nr;
      if (best && nr >= best.closure) break; // no longer converging
      best = { s: x.slice(), T: Tx, closure: nr, M: mono.M };
      if (nr < 1e-12) break;
      const f = deriv(mono.end, m);
      const A = mono.M.map((row, i) => { const a = Array.from(row); a[i] -= 1; a.push(f[i]); return a; });
      const G = A.map((ai) => A.map((aj) => ai.reduce((acc, v, k) => acc + v * aj[k], 0)));
      const mu = 1e-14 * G.reduce((acc, row, i) => acc + row[i], 0);
      G.forEach((row, i) => { row[i] += mu; });
      const y = solve(G, r.map((v) => -v));
      const d = new Array(13).fill(0);
      for (let k = 0; k < 13; k++) for (let i = 0; i < 12; i++) d[k] += A[i][k] * y[i];
      x = x.map((v, i) => v + d[i]); Tx += d[12];
    }
    return best && { s: best.s, T: best.T, closure0, closure: best.closure, M: best.M };
  }

  // Smallest pair distance along one period (half a period for free fall). Below ~10⁻⁷ the h = 10⁻⁶
  // finite differences straddle a near-collision nonlinearly and λ_p becomes unreliable: in the
  // free-fall census all orbits off the published exponents by > 1 % have r_min < 10⁻⁷, and none of
  // the orbits with r_min ≥ 10⁻⁷ do.
  const RMIN_RELIABLE = 1e-7;
  function closestApproach(s0, m, T, kind) {
    const tr = dense(s0, m, kind === 'freefall' ? T / 2 : T);
    let r = Infinity;
    for (const x of tr.ss) r = Math.min(r, Math.hypot(x[2] - x[0], x[3] - x[1]), Math.hypot(x[4] - x[0], x[5] - x[1]), Math.hypot(x[4] - x[2], x[5] - x[3]));
    return r;
  }

  // ---------- one perturbed run ----------
  // Integrate from s period by period and compare its syzygies with the periodic form. Returns
  // the lifetime in periods: the (reference) time of the first wrong symbol, or censored at
  // maxPeriods.
  function formLifetime(ref, s, m, maxPeriods) {
    const { syz: R, T, t0 } = ref, n = R.length;
    if (!n) return { tau: NaN, censored: false };
    let state = s, tOff = 0, k = 0;
    const expectedT = (k) => (R[k % n].t + Math.floor(k / n) * T) / T;
    for (let p = 0; p < maxPeriods; p++) {
      const tr = dense(state, m, T);
      const ok = reached(tr, T);
      const P = Braid.syzygies(tr);
      for (const z of P) {
        const t = z.t + tOff;
        if (t <= t0) continue;
        const r = R[k % n];
        if (z.mid !== r.mid || z.dir !== r.dir) return { tau: expectedT(k), censored: false };
        k++;
      }
      if (!ok) return { tau: Math.min(expectedT(k), (tOff + tr.ts[tr.ts.length - 1]) / T), censored: false };
      state = lastState(tr); tOff += T;
    }
    return { tau: maxPeriods, censored: true };
  }

  // reproducible pseudo-random unit directions in phase space, centre-of-mass motion removed
  function direction(seed, m) {
    let x = seed * 2654435761 % 4294967296;
    const rnd = () => { x = (1664525 * x + 1013904223) % 4294967296; return x / 4294967296; };
    const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const d = Array.from({ length: 12 }, g), M = m[0] + m[1] + m[2];
    for (const off of [0, 1, 6, 7]) {
      let c = 0; for (let b = 0; b < 3; b++) c += m[b] * d[off + 2 * b] / M;
      for (let b = 0; b < 3; b++) d[off + 2 * b] -= c;
    }
    const nn = Math.hypot(...d);
    return d.map((v) => v / nn);
  }

  // ---------- fit ----------
  // τ = a·ln(1/(ε + ε₀)) + b: ε₀ is the floor below which the orbit's own deviation from the
  // true periodic orbit (catalogue digits, round-off) dominates. Grid over ε₀, least squares
  // for (a, b). λ_fit = 1/a, δ = exp(b/a).
  function fit(pts) {
    pts = pts.filter((p) => isFinite(p.tau) && !p.censored);
    if (pts.length < 3) return null;
    let best = null;
    for (let le0 = -18; le0 <= -2; le0 += 0.1) {
      const e0 = 10 ** le0;
      const xs = pts.map((p) => -Math.log(p.eps + e0)), ys = pts.map((p) => p.tau);
      const N = xs.length, mx = xs.reduce((a, b) => a + b) / N, my = ys.reduce((a, b) => a + b) / N;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < N; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
      if (!sxx) continue;
      const a = sxy / sxx, b = my - a * mx;
      let sse = 0; for (let i = 0; i < N; i++) sse += (ys[i] - a * xs[i] - b) ** 2;
      // prefer the smallest floor that fits as well (within 2 %)
      if (a > 0 && (!best || sse < 0.98 * best.sse)) best = { a, b, e0, sse, r2: syy ? 1 - sse / syy : 1 };
    }
    if (!best) return null;
    return { slope: best.a, lambda: 1 / best.a, delta: Math.exp(best.b / best.a), eps0: best.e0, r2: best.r2 };
  }

  const EPS = Array.from({ length: 21 }, (_, k) => 10 ** (-3 - k / 2)); // 10⁻³ … 10⁻¹³ in half decades

  // Full experiment. opts: eps (list), dirs (directions per ε), maxPeriods, lambdaRef (e.g. the
  // catalogue exponent), tick(fraction) awaited between runs so a browser can stay responsive.
  async function experiment(s0, m, T, kind, opts) {
    opts = opts || {};
    const eps = opts.eps || EPS, dirs = opts.dirs || 8, maxPeriods = opts.maxPeriods || 40;
    const tick = opts.tick || null;
    // closed orbits: perturb around the refined periodic orbit; free-fall orbits are exactly
    // periodic by construction (integrated to T/2 and mirrored)
    let sRef = s0, Tref = T, refined = null, lambdaP = NaN;
    if (kind === 'closed' && !opts.skipMonodromy) {
      refined = await refine(s0, m, T, tick && ((f) => tick(0.3 * f, 'refining')));
      if (refined) { sRef = refined.s; Tref = refined.T; lambdaP = lambdaOf(refined.M); }
    }
    const ref = reference(sRef, m, Tref, kind);
    if (kind === 'freefall' && !opts.skipMonodromy) lambdaP = await lyapunov(ref, m, tick && ((f) => tick(0.3 * f, 'monodromy')));
    // the published i.c. itself: its lifetime measures how far it sits from the true orbit
    const base = formLifetime(ref, s0, m, maxPeriods);
    const points = [];
    for (let i = 0; i < eps.length; i++) {
      // lifetimes only grow as ε shrinks: once most directions survive maxPeriods, so will the rest
      if (i > 0 && points[i - 1].censored) { points.push({ eps: eps[i], tau: maxPeriods, min: maxPeriods, max: maxPeriods, censored: true }); continue; }
      const taus = [];
      let censored = 0;
      for (let d = 0; d < dirs; d++) {
        const u = direction(d + 1, m);
        const s = sRef.map((v, j) => v + eps[i] * u[j]);
        const r = formLifetime(ref, s, m, maxPeriods);
        if (r.censored) censored++;
        taus.push(r.tau);
        if (tick) await tick(0.3 + 0.7 * (i * dirs + d + 1) / (eps.length * dirs), 'lifetimes');
      }
      // mean over directions: forms break only at close encounters, so single lifetimes are
      // quantised; the mean smooths the staircase into the expected lifetime
      const sorted = taus.slice().sort((a, b) => a - b);
      points.push({ eps: eps[i], tau: taus.reduce((a, b) => a + b) / taus.length, min: sorted[0], max: sorted[sorted.length - 1],
        censored: censored * 2 > dirs });
    }
    const f = fit(points);
    // invert the fitted law at the published i.c.'s own lifetime: its effective distance from the orbit
    const epsCat = f && !base.censored ? f.delta * Math.exp(-f.lambda * base.tau) : NaN;
    return { points, fit: f, lambdaP, lambdaRef: opts.lambdaRef, base, nSyz: ref.syz.length, maxPeriods,
      epsCat, rmin: closestApproach(s0, m, T, kind), closure0: refined ? refined.closure0 : NaN, closure: refined ? refined.closure : NaN, T: Tref };
  }

  return { RMIN_RELIABLE, closestApproach, reference, monodromy, lyapunov, lambdaOf, refine, formLifetime, fit, experiment, EPS };
}

if (typeof module !== 'undefined') module.exports = lifetimeFactory(require('./physics.js'), require('./braid.js'));
else self.Lifetime = lifetimeFactory(self.Physics, self.Braid);
