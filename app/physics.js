// Planar Newtonian 3-body integrator (G = 1).
// Free-fall initial conditions follow Agekyan–Anosova (Hristov et al. 2023):
//   body 1 at P(x, y), body 2 at (-0.5, 0), body 3 at (0.5, 0), all at rest.
// Written as a factory so the same source can be injected into a Blob Web Worker
// (works from file:// without a server).
function physicsFactory(root) {
  'use strict';

  function energy(s, m) {
    let K = 0;
    for (let i = 0; i < 3; i++) K += 0.5 * m[i] * (s[6 + 2 * i] ** 2 + s[7 + 2 * i] ** 2);
    const r = (i, j) => Math.hypot(s[2 * i] - s[2 * j], s[2 * i + 1] - s[2 * j + 1]);
    return K - m[0] * m[1] / r(0, 1) - m[0] * m[2] / r(0, 2) - m[1] * m[2] / r(1, 2);
  }

  // Algorithmic regularization (Mikkola & Tanikawa 1999; Mikkola & Aarseth 1993 chain):
  // logarithmic-Hamiltonian leapfrog in fictitious time, in chain coordinates
  // (relative vectors along the two shortest edges, so close pairs keep full
  // precision), combined with Gragg–Bulirsch–Stoer extrapolation.
  // y = [t, X1x, X1y, X2x, X2y, W1x, W1y, W2x, W2y]; chain order c = [a, b, c].
  function chainBodies(y, c, m, R, V, pos, vel) {
    // r_a relative to CM, then walk the chain
    const M = m[0] + m[1] + m[2];
    const mb = m[c[1]], mc = m[c[2]];
    const ox = -(mb * y[1] + mc * (y[1] + y[3])) / M, oy = -(mb * y[2] + mc * (y[2] + y[4])) / M;
    const ux = -(mb * y[5] + mc * (y[5] + y[7])) / M, uy = -(mb * y[6] + mc * (y[6] + y[8])) / M;
    const t = y[0];
    const ax = R[0] + V[0] * t + ox, ay = R[1] + V[1] * t + oy;
    pos[2 * c[0]] = ax; pos[2 * c[0] + 1] = ay;
    pos[2 * c[1]] = ax + y[1]; pos[2 * c[1] + 1] = ay + y[2];
    pos[2 * c[2]] = ax + y[1] + y[3]; pos[2 * c[2] + 1] = ay + y[2] + y[4];
    if (vel) {
      const vx = V[0] + ux, vy = V[1] + uy;
      vel[2 * c[0]] = vx; vel[2 * c[0] + 1] = vy;
      vel[2 * c[1]] = vx + y[5]; vel[2 * c[1] + 1] = vy + y[6];
      vel[2 * c[2]] = vx + y[5] + y[7]; vel[2 * c[2] + 1] = vy + y[6] + y[8];
    }
  }

  // Re-chain so the omitted (unchained) edge is the longest one.
  function rechain(y, c) {
    const d = (x, yy) => x * x + yy * yy;
    const l1 = d(y[1], y[2]), l2 = d(y[3], y[4]), l3 = d(y[1] + y[3], y[2] + y[4]);
    if (l3 >= l1 && l3 >= l2) return c; // current chain already omits the longest edge
    // pair vectors relative to current chain a->b (X1), b->c (X2), a->c (X1+X2)
    const [A, B, Cc] = c;
    if (l1 >= l2) {
      // omit edge a-b: new chain b -> c -> a : X1' = c-b = X2, X2' = a-c = -(X1+X2)
      const n = [y[0], y[3], y[4], -(y[1] + y[3]), -(y[2] + y[4]), y[7], y[8], -(y[5] + y[7]), -(y[6] + y[8])];
      for (let i = 0; i < 9; i++) y[i] = n[i];
      return [B, Cc, A];
    }
    // omit edge b-c: new chain b -> a -> c : X1' = a-b = -X1, X2' = c-a = X1+X2
    const n = [y[0], -y[1], -y[2], y[1] + y[3], y[2] + y[4], -y[5], -y[6], y[5] + y[7], y[6] + y[8]];
    for (let i = 0; i < 9; i++) y[i] = n[i];
    return [B, A, Cc];
  }

  // Chain accelerations and potential U (> 0)
  function chainAccel(y, c, m, soft2, A) {
    const ma = m[c[0]], mb = m[c[1]], mc = m[c[2]];
    const p = [[y[1], y[2]], [y[3], y[4]], [y[1] + y[3], y[2] + y[4]]]; // ab, bc, ac
    const f = [];
    let U = 0;
    const mm = [ma * mb, mb * mc, ma * mc];
    for (let k = 0; k < 3; k++) {
      const r2 = p[k][0] ** 2 + p[k][1] ** 2 + soft2, r = Math.sqrt(r2);
      U += mm[k] / r;
      const ir3 = 1 / (r2 * r);
      f.push([p[k][0] * ir3, p[k][1] * ir3]);
    }
    // body accelerations
    const aax = mb * f[0][0] + mc * f[2][0], aay = mb * f[0][1] + mc * f[2][1];
    const abx = -ma * f[0][0] + mc * f[1][0], aby = -ma * f[0][1] + mc * f[1][1];
    const acx = -ma * f[2][0] - mb * f[1][0], acy = -ma * f[2][1] - mb * f[1][1];
    A[0] = abx - aax; A[1] = aby - aay; A[2] = acx - abx; A[3] = acy - aby;
    return U;
  }

  function chainKinetic(y, c, m) {
    const M = m[0] + m[1] + m[2], mb = m[c[1]], mc = m[c[2]];
    const ux = -(mb * y[5] + mc * (y[5] + y[7])) / M, uy = -(mb * y[6] + mc * (y[6] + y[8])) / M;
    const vbx = ux + y[5], vby = uy + y[6], vcx = vbx + y[7], vcy = vby + y[8];
    return 0.5 * (m[c[0]] * (ux * ux + uy * uy) + mb * (vbx * vbx + vby * vby) + mc * (vcx * vcx + vcy * vcy));
  }

  function logHLeapfrog(y0, c, m, E0, soft2, H, n, out, A) {
    out.set(y0);
    const h = H / n;
    const drift = (dh) => {
      const dt = dh / (chainKinetic(out, c, m) - E0);
      out[0] += dt;
      out[1] += dt * out[5]; out[2] += dt * out[6]; out[3] += dt * out[7]; out[4] += dt * out[8];
    };
    const kick = (dh) => {
      const dt = dh / chainAccel(out, c, m, soft2, A);
      out[5] += dt * A[0]; out[6] += dt * A[1]; out[7] += dt * A[2]; out[8] += dt * A[3];
    };
    drift(h / 2);
    for (let k = 1; k < n; k++) { kick(h); drift(h); }
    kick(h); drift(h / 2);
  }

  // Integrate until physical time tEnd. Returns {ts, ss} with ss = 12-state per step
  // ([x1,y1,x2,y2,x3,y3, vx1,...,vy3] in body order).
  function integrateAR(s0, m, tEnd, opts) {
    opts = opts || {};
    const tol = opts.tol || 1e-12, maxSteps = opts.maxSteps || 100000;
    const soft2 = (opts.soft || 0) ** 2;
    const maxDt = opts.maxDt || Infinity;
    const KMAX = 10, NY = 9;
    const seq = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const Aacc = new Float64Array(4);
    const M = m[0] + m[1] + m[2];
    const R = [0, 0], V = [0, 0];
    for (let i = 0; i < 3; i++) {
      R[0] += m[i] * s0[2 * i] / M; R[1] += m[i] * s0[2 * i + 1] / M;
      V[0] += m[i] * s0[6 + 2 * i] / M; V[1] += m[i] * s0[7 + 2 * i] / M;
    }
    // energy in the CM frame (logH uses the internal energy)
    const sCM = Array.from(s0);
    for (let i = 0; i < 3; i++) { sCM[6 + 2 * i] -= V[0]; sCM[7 + 2 * i] -= V[1]; }
    let E0 = energy(sCM, m);
    if (soft2) {
      // softened potential differs slightly; recompute U with softening
      let K = 0, U = 0;
      for (let i = 0; i < 3; i++) K += 0.5 * m[i] * (sCM[6 + 2 * i] ** 2 + sCM[7 + 2 * i] ** 2);
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
        U += m[i] * m[j] / Math.sqrt((s0[2 * i] - s0[2 * j]) ** 2 + (s0[2 * i + 1] - s0[2 * j + 1]) ** 2 + soft2);
      E0 = K - U;
    }
    let c = [0, 1, 2];
    let y = new Float64Array(NY);
    y[1] = s0[2] - s0[0]; y[2] = s0[3] - s0[1]; y[3] = s0[4] - s0[2]; y[4] = s0[5] - s0[3];
    y[5] = s0[8] - s0[6]; y[6] = s0[9] - s0[7]; y[7] = s0[10] - s0[8]; y[8] = s0[11] - s0[9];
    c = rechain(y, c);
    const tab = Array.from({ length: KMAX }, () => new Float64Array(NY));
    const ts = [0], ss = [Float64Array.from(s0)];
    let H = opts.H0 || 0.05, steps = 0;
    let bestErr = Infinity, bestY = null, fails = 0;
    // One GBS step of fictitious length H from y; returns {ok, k, y}
    const gbs = (y, H) => {
      for (let k = 0; k < KMAX; k++) {
        logHLeapfrog(y, c, m, E0, soft2, H, seq[k], tab[k], Aacc);
        for (let j = k - 1; j >= 0; j--) {
          const r = (seq[k] / seq[j]) ** 2 - 1;
          for (let i = 0; i < NY; i++) tab[j][i] = tab[j + 1][i] + (tab[j + 1][i] - tab[j][i]) / r;
        }
        if (k >= 2) {
          // error scaled per vector: positions by chain length, velocities by speed
          let err = Math.abs(tab[0][0] - tab[1][0]) / (1 + Math.abs(tab[0][0]));
          for (let v = 0; v < 4; v++) {
            const i = 1 + 2 * v;
            const sc = 1e-3 + Math.hypot(tab[0][i], tab[0][i + 1]);
            const e = Math.hypot(tab[0][i] - tab[1][i], tab[0][i + 1] - tab[1][i + 1]) / sc;
            if (e > err) err = e;
          }
          if (err < tol && isFinite(err)) return { ok: true, k, y: Float64Array.from(tab[0]) };
          if (isFinite(err) && err < bestErr) { bestErr = err; bestY = Float64Array.from(tab[0]); }
        }
      }
      return { ok: false };
    };
    const pos = new Float64Array(6), vel = new Float64Array(6);
    // Near-collisions can hit the double-precision floor; after repeated step halvings
    // accept the best-converged extrapolation instead of stalling.
    while (y[0] < tEnd && steps < maxSteps) {
      let st = gbs(y, H);
      steps++;
      if (!st.ok) {
        if (++fails < 6 || !bestY) { H *= 0.5; if (H < 1e-15) break; continue; }
        st = { ok: true, k: KMAX, y: bestY };
      }
      fails = 0; bestErr = Infinity; bestY = null;
      let yn = st.y;
      // keep physical steps short enough for smooth Hermite resampling
      const dtStep = yn[0] - y[0];
      if (dtStep > 2 * maxDt) { H *= 0.9 * maxDt / dtStep; continue; }
      if (yn[0] > tEnd) {
        // land exactly on tEnd: secant iteration on the fictitious step length
        let h0 = 0, f0 = y[0] - tEnd, h1 = H, f1 = yn[0] - tEnd;
        for (let it = 0; it < 30 && Math.abs(f1) > 1e-15 * (1 + tEnd); it++) {
          const h2 = h1 - f1 * (h1 - h0) / (f1 - f0);
          const r = gbs(y, h2);
          if (!r.ok) break;
          h0 = h1; f0 = f1; h1 = h2; f1 = r.y[0] - tEnd; yn = r.y;
        }
        // Only snap the clock when the secant actually converged; otherwise keep the
        // true time of this state (resampling interpolates to tEnd exactly anyway).
        if (Math.abs(f1) <= 1e-9 * (1 + tEnd)) yn[0] = tEnd;
      }
      y = yn;
      chainBodies(y, c, m, R, V, pos, vel);
      const out = new Float64Array(12);
      out.set(pos, 0); out.set(vel, 6);
      ts.push(y[0]); ss.push(out);
      c = rechain(y, c);
      if (st.k <= 4) H *= 1.5; else if (st.k >= 8) H *= 0.7;
      if (dtStep > maxDt) H *= maxDt / dtStep;
    }
    return { ts, ss, steps };
  }

  function freeFallState(x, y) {
    return [x, y, -0.5, 0, 0.5, 0, 0, 0, 0, 0, 0, 0];
  }

  // Cubic Hermite resample of positions at nSamples uniform times over [0, tEnd].
  function resample(res, tEnd, nSamples) {
    const { ts, ss } = res;
    const out = new Float32Array(nSamples * 6);
    let seg = 0;
    for (let q = 0; q < nSamples; q++) {
      const t = (q / (nSamples - 1)) * tEnd;
      while (seg < ts.length - 2 && ts[seg + 1] < t) seg++;
      const t0 = ts[seg], t1 = ts[Math.min(seg + 1, ts.length - 1)];
      const a = ss[seg], b = ss[Math.min(seg + 1, ss.length - 1)];
      const h = t1 - t0 || 1, u = Math.min(1, Math.max(0, (t - t0) / h));
      const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
      const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
      for (let i = 0; i < 6; i++) {
        out[q * 6 + i] = h00 * a[i] + h10 * h * a[i + 6] + h01 * b[i] + h11 * h * b[i + 6];
      }
    }
    return out;
  }

  // Full periodic free-fall orbit: integrate to T/2 (bodies come to rest again),
  // then mirror in time (free-fall orbits are time-reversal symmetric about T/2).
  // Returns positions sampled uniformly over one full period [0, T].
  // vHalf = residual speed at T/2 (ideally 0) — a quality check on the integration.
  function periodicOrbit(x, y, T, nSamples, m) {
    m = m || [1, 1, 1];
    const half = Math.ceil(nSamples / 2);
    const maxDt = (T / 2) / (half * 0.5);
    let best = null;
    for (const tol of [1e-12, 1e-13, 1e-11, 3e-14, 1e-10]) {
      const res = integrateAR(freeFallState(x, y), m, T / 2, { tol, maxDt });
      const last = res.ss[res.ss.length - 1];
      const reached = res.ts[res.ts.length - 1] >= T / 2 - 1e-9;
      const v = reached ? Math.hypot(...Array.from(last.subarray(6))) : Infinity;
      if (!best || v < best.v) best = { res, v };
      if (v < 1e-3) break;
    }
    const h = resample(best.res, T / 2, half + 1);
    const out = new Float32Array(2 * half * 6);
    out.set(h.subarray(0, half * 6), 0);
    for (let q = 0; q < half; q++) {
      const src = (half - q) * 6;
      for (let i = 0; i < 6; i++) out[(half + q) * 6 + i] = h[src + i];
    }
    return { pos: out, n: 2 * half, steps: best.res.steps, vHalf: best.v };
  }

  // Generic (non-periodic) evolution with arbitrary masses/velocities.
  function freeOrbit(s0, m, tEnd, nSamples, soft) {
    const res = integrateAR(s0, m, tEnd, { tol: 1e-12, soft: soft || 0, maxDt: tEnd / nSamples * 2 });
    const tReached = res.ts[res.ts.length - 1];
    return { pos: resample(res, tReached, nSamples), n: nSamples, tReached, steps: res.steps };
  }

  // Periodic orbit with general initial state s0 and nominal period T: refine the
  // period to the closest phase-space return, resample, and remove the tiny residual
  // mismatch linearly so the animation loops seamlessly.
  // exact = true: T is known precisely (e.g. published to 10 digits) — integrate to
  // exactly T instead of searching for the closest return.
  function closedOrbit(s0, m, T, nSamples, exact) {
    const res = integrateAR(s0, m, exact ? T : T * 1.04, { tol: 1e-12, maxDt: T / 4000 });
    let best = Infinity, Tb = T;
    if (exact) {
      const e = res.ss[res.ss.length - 1];
      best = 0;
      for (let i = 0; i < 12; i++) best += (e[i] - s0[i]) ** 2;
    } else for (let k = 0; k < res.ts.length; k++) {
      if (res.ts[k] < 0.96 * T) continue;
      let d = 0;
      for (let i = 0; i < 12; i++) d += (res.ss[k][i] - s0[i]) ** 2;
      if (d < best) { best = d; Tb = res.ts[k]; }
    }
    const pos = resample(res, Tb, nSamples + 1);
    const out = new Float32Array(nSamples * 6);
    for (let q = 0; q < nSamples; q++) {
      const f = q / nSamples;
      for (let i = 0; i < 6; i++) out[q * 6 + i] = pos[q * 6 + i] - f * (pos[nSamples * 6 + i] - pos[i]);
    }
    return { pos: out, n: nSamples, T: Tb, returnDist: Math.sqrt(best) };
  }

  const api = { closedOrbit, integrateAR, energy, freeFallState, resample, periodicOrbit, freeOrbit };
  return api;
}

if (typeof module !== 'undefined') module.exports = physicsFactory();
else self.Physics = physicsFactory(self);
