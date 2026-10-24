// WebGL renderer for glowing orbit trails.
//
// 1. Trails are drawn as continuous triangle strips whose width and brightness vary
//    per vertex (smooth taper, no steps), with an anti-aliased core evaluated per pixel.
//    They go into an offscreen "scene" texture.
// 2. Glow is a bloom post-process: the scene is downsampled and Gaussian-blurred at
//    1/2, 1/4 and 1/8 resolution, then added back. Because glow comes from the image
//    rather than from wide geometry, tight hairpin turns never fold or tear.
function createGLPainter(canvas) {
  'use strict';
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  // ---- trail / body geometry program ----
  const geo = program(`
    attribute vec2 aPos;
    attribute vec2 aUV;
    attribute vec4 aCol;
    attribute vec3 aShape;
    attribute float aZ;
    uniform vec2 uRes;
    varying vec2 vUV;
    varying vec4 vCol;
    varying vec3 vShape;
    void main() {
      vUV = aUV; vCol = aCol; vShape = aShape;
      vec2 p = aPos / uRes * 2.0 - 1.0;
      gl_Position = vec4(p.x, -p.y, aZ, 1.0);
    }`, `
    precision mediump float;
    uniform float uMode;   // 0: additive glow; 1: opaque, premultiplied (braid diagrams with occlusion)
    varying vec2 vUV;
    varying vec4 vCol;
    varying vec3 vShape;   // x = outer half-extent px, y = core half-width px (< 0: halo only, radius |y|), z = halo amount
    void main() {
      float d = length(vUV) * vShape.x;
      float core = vShape.y > 0.0 ? clamp(vShape.y + 0.6 - d, 0.0, 1.0) : 0.0;
      float w = max(abs(vShape.y), 0.5);
      float halo = exp(-(d * d) / (1.6 * w * w)) * vShape.z;
      vec3 c = vCol.rgb;
      if (uMode > 0.5) {
        // coverage-weighted, premultiplied: a black strand erases what's behind it
        gl_FragColor = vec4(mix(c, vec3(1.0), 0.12) * vCol.a * core, core);
        return;
      }
      vec3 col = mix(c, vec3(1.0), 0.35) * core * 0.95 + c * halo * 0.45;
      gl_FragColor = vec4(col * vCol.a, 1.0);
    }`);
  const gLoc = {
    aPos: gl.getAttribLocation(geo, 'aPos'), aUV: gl.getAttribLocation(geo, 'aUV'),
    aCol: gl.getAttribLocation(geo, 'aCol'), aShape: gl.getAttribLocation(geo, 'aShape'), aZ: gl.getAttribLocation(geo, 'aZ'),
    uRes: gl.getUniformLocation(geo, 'uRes'), uMode: gl.getUniformLocation(geo, 'uMode'),
  };

  // ---- full-screen passes ----
  const QUAD_VS = `
    attribute vec2 aQ;
    varying vec2 vT;
    void main() { vT = aQ * 0.5 + 0.5; gl_Position = vec4(aQ, 0.0, 1.0); }`;
  const blur = program(QUAD_VS, `
    precision mediump float;
    varying vec2 vT;
    uniform sampler2D uTex;
    uniform vec2 uStep;    // texel step * direction
    void main() {
      // 9-tap Gaussian using linear filtering (5 fetches)
      vec3 s = texture2D(uTex, vT).rgb * 0.2270270270;
      s += texture2D(uTex, vT + uStep * 1.3846153846).rgb * 0.3162162162;
      s += texture2D(uTex, vT - uStep * 1.3846153846).rgb * 0.3162162162;
      s += texture2D(uTex, vT + uStep * 3.2307692308).rgb * 0.0702702703;
      s += texture2D(uTex, vT - uStep * 3.2307692308).rgb * 0.0702702703;
      gl_FragColor = vec4(s, 1.0);
    }`);
  const comp = program(QUAD_VS, `
    precision mediump float;
    varying vec2 vT;
    uniform sampler2D uScene, uB1, uB2, uB3;
    uniform vec3 uBg;
    uniform float uGlow;
    void main() {
      vec3 c = uBg + texture2D(uScene, vT).rgb
        + uGlow * (0.55 * texture2D(uB1, vT).rgb + 0.55 * texture2D(uB2, vT).rgb + 0.45 * texture2D(uB3, vT).rgb);
      gl_FragColor = vec4(c, 1.0);
    }`);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  // ---- render targets ----
  function target(w, h, withDepth) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (withDepth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    return { tex, fb, w, h, rb };
  }
  let T = null; // {scene, levels: [{a, b}]}
  function ensureTargets() {
    const W = canvas.width, H = canvas.height;
    if (T && T.W === W && T.H === H) return;
    if (T) for (const t of [T.scene, ...T.levels.flatMap((l) => [l.a, l.b])]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); if (t.rb) gl.deleteRenderbuffer(t.rb); }
    const lv = [2, 4, 8].map((d) => {
      const w = Math.max(1, Math.round(W / d)), h = Math.max(1, Math.round(H / d));
      return { a: target(w, h), b: target(w, h) };
    });
    T = { W, H, scene: target(W, H, true), levels: lv };
  }

  // ---- geometry batching ----
  const FL = 12, MAXV = 65000; // floats per vertex; Uint16 index limit per batch
  const verts = new Float32Array(MAXV * FL);
  const idx = new Uint16Array(MAXV * 3);
  let nv = 0, ni = 0;
  const vbo = gl.createBuffer(), ibo = gl.createBuffer();
  let dpr = 1, bg = [0, 0, 0], glowAmt = 1;

  function bindGeo() {
    gl.useProgram(geo);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const st = FL * 4;
    gl.enableVertexAttribArray(gLoc.aPos); gl.vertexAttribPointer(gLoc.aPos, 2, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(gLoc.aUV); gl.vertexAttribPointer(gLoc.aUV, 2, gl.FLOAT, false, st, 8);
    gl.enableVertexAttribArray(gLoc.aCol); gl.vertexAttribPointer(gLoc.aCol, 4, gl.FLOAT, false, st, 16);
    gl.enableVertexAttribArray(gLoc.aShape); gl.vertexAttribPointer(gLoc.aShape, 3, gl.FLOAT, false, st, 32);
    gl.enableVertexAttribArray(gLoc.aZ); gl.vertexAttribPointer(gLoc.aZ, 1, gl.FLOAT, false, st, 44);
    gl.uniform2f(gLoc.uRes, canvas.width, canvas.height);
    gl.uniform1f(gLoc.uMode, mode);
  }
  let mode = 0;
  // 0 = additive glow (trails, bodies); 1 = painter's-order opaque strands (braids)
  function setMode(m) {
    if (m === mode) return;
    drawBatch();
    mode = m;
    gl.uniform1f(gLoc.uMode, m);
    if (m === 1) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.disable(gl.DEPTH_TEST); zNow = 0;
    }
  }

  // One straight piece of a strand from (ax, ay) to (bx, by) (CSS px) with side vectors
  // (nax, nay) / (nbx, nby) shared with the neighbouring pieces, so consecutive pieces
  // meet edge to edge. halfW = half width (CSS px); rgb = null draws an opaque black gap.
  // z in (-1, 1): smaller = nearer (depth-tested in braid mode).
  function segment(ax, ay, bx, by, nax, nay, nbx, nby, halfW, rgb, a, z) {
    if (nv + 4 >= MAXV) drawBatch();
    zNow = z || 0;
    const w = halfW * dpr, H = w + 1;
    const r = rgb ? rgb[0] / 255 : 0, g = rgb ? rgb[1] / 255 : 0, b = rgb ? rgb[2] / 255 : 0;
    ax *= dpr; ay *= dpr; bx *= dpr; by *= dpr;
    const i0 = vtx(ax + nax * H, ay + nay * H, 1, 0, r, g, b, a, H, w, 0);
    vtx(ax - nax * H, ay - nay * H, -1, 0, r, g, b, a, H, w, 0);
    vtx(bx + nbx * H, by + nby * H, 1, 0, r, g, b, a, H, w, 0);
    vtx(bx - nbx * H, by - nby * H, -1, 0, r, g, b, a, H, w, 0);
    quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }
  function drawBatch() {
    if (!ni) { nv = 0; return; }
    gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, nv * FL), gl.STREAM_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, ni), gl.STREAM_DRAW);
    gl.drawElements(gl.TRIANGLES, ni, gl.UNSIGNED_SHORT, 0);
    nv = 0; ni = 0;
  }
  let zNow = 0; // depth for subsequent vertices (braid mode)
  function vtx(x, y, u, v, r, g, b, a, H, core, halo) {
    const o = nv * FL;
    verts[o + 11] = zNow;
    verts[o] = x; verts[o + 1] = y; verts[o + 2] = u; verts[o + 3] = v;
    verts[o + 4] = r; verts[o + 5] = g; verts[o + 6] = b; verts[o + 7] = a;
    verts[o + 8] = H; verts[o + 9] = core; verts[o + 10] = halo;
    return nv++;
  }
  function quad(a, b, c, d) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = b; idx[ni++] = d; idx[ni++] = c; }

  // Strip along pts (CSS px, xy pairs, count+1 points). widthAt(f) and alphaAt(f) give the
  // core width (CSS px) and intensity at fraction f in [0, 1] from tail to head.
  function ribbon(pts, count, rgb, widthAt, alphaAt, glow, headCap) {
    if (count < 1) return;
    if (nv + 2 * (count + 1) + 4 >= MAXV) drawBatch();
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const halo = glow > 0 ? Math.min(1, glow) : 0;
    let prev = -1, lastNx = 0, lastNy = 1, lastTx = 1, lastTy = 0, lastH = 1, lastW = 1, lastA = 1;
    for (let k = 0; k <= count; k++) {
      const k0 = Math.max(0, k - 1), k1 = Math.min(count, k + 1);
      let tx = pts[2 * k1] - pts[2 * k0], ty = pts[2 * k1 + 1] - pts[2 * k0 + 1];
      const len = Math.hypot(tx, ty);
      if (len > 1e-9) {
        tx /= len; ty /= len; lastTx = tx; lastTy = ty;
        // keep the side vector continuous through cusps so the strip never twists
        let nx = -ty, ny = tx;
        if (prev >= 0 && nx * lastNx + ny * lastNy < 0) { nx = -nx; ny = -ny; }
        lastNx = nx; lastNy = ny;
      }
      const f = k / count;
      const w = widthAt(f) * dpr, a = alphaAt(f);
      const H = w * (halo ? 1.6 : 0.5) + 1.5; // narrow: wide glow comes from bloom
      const x = pts[2 * k] * dpr, y = pts[2 * k + 1] * dpr;
      const i0 = vtx(x + lastNx * H, y + lastNy * H, 1, 0, r, g, b, a, H, w * 0.5, halo);
      vtx(x - lastNx * H, y - lastNy * H, -1, 0, r, g, b, a, H, w * 0.5, halo);
      if (prev >= 0) quad(prev, prev + 1, i0, i0 + 1);
      prev = i0; lastH = H; lastW = w; lastA = a;
    }
    if (headCap) {
      // rounded half-disc beyond the head so the line doesn't end in a flat edge
      const x = pts[2 * count] * dpr, y = pts[2 * count + 1] * dpr;
      const fx = lastTx, fy = lastTy;
      const i0 = vtx(x + lastNx * lastH, y + lastNy * lastH, 1, 0, r, g, b, lastA, lastH, lastW * 0.5, halo);
      vtx(x - lastNx * lastH, y - lastNy * lastH, -1, 0, r, g, b, lastA, lastH, lastW * 0.5, halo);
      vtx(x + (lastNx + fx) * lastH, y + (lastNy + fy) * lastH, 1, 1, r, g, b, lastA, lastH, lastW * 0.5, halo);
      vtx(x + (fx - lastNx) * lastH, y + (fy - lastNy) * lastH, -1, 1, r, g, b, lastA, lastH, lastW * 0.5, halo);
      quad(i0, i0 + 1, i0 + 2, i0 + 3);
    }
  }

  // Glowing body: radial version of the same profile (bloom adds the wide halo).
  function body(x, y, size, rgb, glow) {
    if (nv + 8 >= MAXV) drawBatch();
    const R = size * 0.5 * dpr;
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const core = Math.max(1.3 * dpr, R * 0.13);
    const halo = 1.6 + 0.8 * Math.min(1.5, glow);
    const X = x * dpr, Y = y * dpr;
    const i0 = vtx(X - R, Y - R, -1, -1, r, g, b, 1, R, core, halo);
    vtx(X + R, Y - R, 1, -1, r, g, b, 1, R, core, halo);
    vtx(X - R, Y + R, -1, 1, r, g, b, 1, R, core, halo);
    vtx(X + R, Y + R, 1, 1, r, g, b, 1, R, core, halo);
    quad(i0, i0 + 1, i0 + 2, i0 + 3);
    // soft coloured corona around the star
    const hr = -R * 0.3, ha = 0.55 + 0.45 * Math.min(1.5, glow);
    const j0 = vtx(X - R, Y - R, -1, -1, r, g, b, 1, R, hr, ha);
    vtx(X + R, Y - R, 1, -1, r, g, b, 1, R, hr, ha);
    vtx(X - R, Y + R, -1, 1, r, g, b, 1, R, hr, ha);
    vtx(X + R, Y + R, 1, 1, r, g, b, 1, R, hr, ha);
    quad(j0, j0 + 1, j0 + 2, j0 + 3);
  }

  function begin(bgHex, pixelRatio, glow) {
    dpr = pixelRatio; glowAmt = glow;
    const n = parseInt(bgHex.slice(1), 16);
    bg = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    ensureTargets();
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
    gl.viewport(0, 0, T.W, T.H);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    zNow = 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    mode = 0;
    bindGeo();
    nv = 0; ni = 0;
  }

  function fullscreen(prog) {
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const a = gl.getAttribLocation(prog, 'aQ');
    for (let i = 0; i < 6; i++) if (i !== a) gl.disableVertexAttribArray(i);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function blurPass(src, dst, dx, dy, spread) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.useProgram(blur);
    gl.uniform1i(gl.getUniformLocation(blur, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(blur, 'uStep'), dx * spread / dst.w, dy * spread / dst.h);
    fullscreen(blur);
  }

  function flush() {
    drawBatch();
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    // bloom chain: scene -> L1 -> L2 -> L3, each blurred horizontally then vertically
    let src = T.scene;
    const spread = Math.max(1, dpr * 0.75);
    if (glowAmt > 0) {
      for (const l of T.levels) {
        blurPass(src, l.a, 1, 0, spread);   // downsample + horizontal
        blurPass(l.a, l.b, 0, 1, spread);   // vertical
        src = l.b;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(comp);
    const tex = [T.scene, ...T.levels.map((l) => l.b)];
    ['uScene', 'uB1', 'uB2', 'uB3'].forEach((u, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i].tex);
      gl.uniform1i(gl.getUniformLocation(comp, u), i);
    });
    gl.uniform3f(gl.getUniformLocation(comp, 'uBg'), bg[0], bg[1], bg[2]);
    gl.uniform1f(gl.getUniformLocation(comp, 'uGlow'), glowAmt);
    fullscreen(comp);
    gl.activeTexture(gl.TEXTURE0);
  }

  return { gl, begin, ribbon, body, segment, setMode, flush };
}
