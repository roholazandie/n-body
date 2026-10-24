// Classic planar periodic 3-body orbits (G = 1, unit masses unless noted).
// state: [x1,y1,x2,y2,x3,y3, vx1,vy1,vx2,vy2,vx3,vy3], T = period.
(function (root) {
  'use strict';
  // Šuvakov & Dmitrašinović (PRL 110, 114301, 2013): r1=(-1,0), r2=(1,0), r3=(0,0),
  // v1 = v2 = (p1, p2), v3 = -2 (p1, p2)
  const sd = (name, p1, p2, T, ref) => ({
    name, T, ref: ref || 'Šuvakov & Dmitrašinović 2013',
    s: [-1, 0, 1, 0, 0, 0, p1, p2, p1, p2, -2 * p1, -2 * p2],
  });
  // Broucke / Hénon orbits: collinear start on x-axis, velocities along y
  const br = (name, x, vy, T, ref) => ({
    name, T, ref: ref || 'Broucke 1975',
    s: [x[0], 0, x[1], 0, x[2], 0, 0, vy[0], 0, vy[1], 0, vy[2]],
  });
  const w = Math.sqrt(3), rL = 1 / Math.sqrt(3), vL = w * rL;
  const CLASSICS = [
    { name: 'Figure-eight', T: 6.3259139829, ref: 'Moore 1993; Chenciner & Montgomery 2000',
      s: [-0.97000436, 0.24308753, 0.97000436, -0.24308753, 0, 0,
        0.4662036850, 0.4323657300, 0.4662036850, 0.4323657300, -0.93240737, -0.86473146] },
    { name: 'Lagrange', T: 2 * Math.PI / w, ref: 'Lagrange 1772',
      s: [rL, 0, -rL / 2, rL * w / 2, -rL / 2, -rL * w / 2,
        0, vL, -vL * w / 2, -vL / 2, vL * w / 2, -vL / 2] },
    sd('Butterfly I', 0.306893, 0.125507, 6.2356),
    sd('Butterfly II', 0.392955, 0.097579, 7.0039),
    sd('Bumblebee', 0.184279, 0.587188, 63.5345),
    sd('Moth I', 0.464445, 0.396060, 14.8939),
    sd('Moth II', 0.439166, 0.452968, 28.6703),
    sd('Butterfly III', 0.405916, 0.230163, 13.8658),
    sd('Moth III', 0.383444, 0.377364, 25.8406),
    sd('Goggles', 0.083300, 0.127889, 10.4668),
    sd('Dragonfly', 0.080584, 0.588836, 21.2710),
    sd('Yarn', 0.559064, 0.349192, 55.5018),
    sd('Yin-yang Ia', 0.513938, 0.304736, 17.3284),
    sd('Yin-yang Ib', 0.282699, 0.327209, 10.9626),
    sd('Yin-yang IIa', 0.416822, 0.330333, 55.7898),
    sd('Yin-yang IIb', 0.417343, 0.313100, 54.2076),
    br('Broucke A1', [-0.9892620043, 2.2096177241, -1.2203557197], [1.9169244185, 0.1910268738, -2.1079512924], 6.283213),
    br('Broucke A2', [0.3361300950, 0.7699893804, -1.1061194753], [1.5324315370, -0.6287350978, -0.9036964391], 7.702408),
    br('Broucke A3', [0.3149337497, 0.8123820710, -1.1273158206], [1.4601869417, -0.5628292375, -0.8973577042], 7.910268),
    br('Broucke R1', [0.8083106230, -0.4954148566, -0.3128957664], [0.9901979166, -2.7171431768, 1.7269452602], 5.226525),
  ];
  if (typeof module !== 'undefined') module.exports = CLASSICS; else root.CLASSICS = CLASSICS;
})(typeof self !== 'undefined' ? self : this);
