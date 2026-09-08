// Real locus of the curve with its witness points, drawn client-side into the
// <figure id="curve-plot"> on a curve page from its data-ainvs / data-points.
//
// Coefficients of record curves exceed double range, so everything is first
// rescaled exactly with BigInt: x = 2^k t and y = 2^(3k/2) Y (k even) turn
// y'^2 = 4x^3 + b2 x^2 + 2 b4 x + b6 into u^2 = g(t) with O(1) coefficients.
// The picture is the true curve up to that anisotropic rescaling, which is the
// only sensible way to draw a plane cubic whose coefficients span hundreds of
// digits. Witness points far from the real roots are counted, not squeezed in.
(function () {
  'use strict';

  function bitlen(x) {
    if (x < 0n) x = -x;
    return x === 0n ? 0 : x.toString(2).length;
  }

  // Parse "n", "-n", "n/d" (also U+2212 minus) into {n, d} BigInt rationals.
  function rat(s) {
    var m = String(s).trim().replace(/−/g, '-').split('/');
    var n = BigInt(m[0]);
    var d = m[1] ? BigInt(m[1]) : 1n;
    if (d < 0n) { n = -n; d = -d; }
    return { n: n, d: d };
  }

  // (n/d) * 2^e2 as a double, tolerating huge n and d: keep 60 significant
  // bits of each and fold the rest into the exponent. Overflows to Infinity
  // (treated as "outside the window") rather than throwing.
  function toFloat(r, e2) {
    var n = r.n, d = r.d, sign = 1;
    if (n < 0n) { n = -n; sign = -1; }
    if (n === 0n) return 0;
    var ln = bitlen(n), ld = bitlen(d);
    if (ln > 60) { n >>= BigInt(ln - 60); e2 += ln - 60; }
    if (ld > 60) { d >>= BigInt(ld - 60); e2 -= ld - 60; }
    return sign * (Number(n) / Number(d)) * Math.pow(2, e2);
  }

  // Real roots of 4t^3 + c1 t^2 + c2 t + c3, ascending.
  function cubicRoots(c1, c2, c3) {
    var b = c1 / 4, c = c2 / 4, d = c3 / 4;
    var p = c - b * b / 3;
    var q = 2 * b * b * b / 27 - b * c / 3 + d;
    var disc = (q / 2) * (q / 2) + (p / 3) * (p / 3) * (p / 3);
    var shift = -b / 3;
    var cbrt = function (t) { return t < 0 ? -Math.pow(-t, 1 / 3) : Math.pow(t, 1 / 3); };
    if (disc > 0) {
      var s = Math.sqrt(disc);
      return [cbrt(-q / 2 + s) + cbrt(-q / 2 - s) + shift];
    }
    if (p === 0) return [shift];
    var m = 2 * Math.sqrt(-p / 3);
    var th = Math.acos(Math.max(-1, Math.min(1, (3 * q) / (p * m)))) / 3;
    var roots = [];
    for (var k = 0; k < 3; k++) roots.push(m * Math.cos(th - (2 * Math.PI * k) / 3) + shift);
    roots.sort(function (a, b2) { return a - b2; });
    return roots;
  }

  // Geometry of the plot: sampled branches in scaled (t, Y) coordinates, the
  // window, and which witness points fall inside it. Pure; exposed for tests.
  function computePlot(ainvs, points) {
    var a = ainvs.map(function (s) { return rat(s).n; }); // minimal model: integers
    if (a.length === 2) a = [0n, 0n, 0n, a[0], a[1]];
    var a1 = a[0], a2 = a[1], a3 = a[2], a4 = a[3], a6 = a[4];
    var b2 = a1 * a1 + 4n * a2, b4 = 2n * a4 + a1 * a3, b6 = a3 * a3 + 4n * a6;
    var k = Math.max(0, bitlen(b2), Math.ceil(bitlen(2n * b4) / 2), Math.ceil(bitlen(b6) / 3));
    if (k % 2) k++; // keep 3k/2 integral
    var c1 = toFloat({ n: b2, d: 1n }, -k);
    var c2 = toFloat({ n: 2n * b4, d: 1n }, -2 * k);
    var c3 = toFloat({ n: b6, d: 1n }, -3 * k);
    var A1 = toFloat({ n: a1, d: 1n }, -k / 2);       // a1 x / 2^(3k/2) = A1 t
    var A3 = toFloat({ n: a3, d: 1n }, (-3 * k) / 2); // a3 / 2^(3k/2)
    var g = function (t) { return ((4 * t + c1) * t + c2) * t + c3; };
    // y = (y' - a1 x - a3) / 2, in scaled units.
    var Yof = function (t, u) { return (u - A1 * t - A3) / 2; };

    var roots = cubicRoots(c1, c2, c3);
    var rFirst = roots[0], rLast = roots[roots.length - 1];
    // Natural length scale of the cubic in scaled units (all O(1) by the
    // choice of k); the root spread when there are three real roots.
    var scale = Math.max(Math.abs(c1), Math.sqrt(Math.abs(c2)), Math.pow(Math.abs(c3), 1 / 3), 1e-3);
    var span = Math.max(rLast - rFirst, scale);

    var pts = points.map(function (p) {
      return { t: toFloat(rat(p[0]), -k), Y: toFloat(rat(p[1]), (-3 * k) / 2), x: p[0], y: p[1] };
    });
    // Horizontal window: a little left of the first root, two spans right of
    // the last; stretched (up to a limit) so that nearby witness points make
    // it in.
    var tlo = rFirst - 0.15 * span;
    var thi = rLast + 2.0 * span;
    var reach = rLast + 8 * span;
    pts.forEach(function (p) {
      if (isFinite(p.t) && p.t > thi && p.t <= reach) thi = p.t + 0.3 * span;
    });

    var N = 240, branches = [];
    var sample = function (t) {
      var u = Math.sqrt(Math.max(g(t), 0));
      return { t: t, hi: Yof(t, u), lo: Yof(t, -u) };
    };
    if (roots.length === 3) {
      // Bounded component (oval) between the first two roots: parametrize by
      // angle so the ends are sampled densely, and close the path.
      var mid = (roots[0] + roots[1]) / 2, half = (roots[1] - roots[0]) / 2, oval = [];
      for (var i = 0; i <= N; i++) oval.push(sample(mid - half * Math.cos((Math.PI * i) / N)));
      branches.push({ closed: true, samples: oval });
    }
    // Unbounded component from the last root to the window edge, sampled
    // densely near the root (t = r + (thi - r) s^2). It leaves the picture
    // through the top and bottom: the SVG clips it.
    var arm = [];
    for (var j = 0; j <= N; j++) {
      var s = j / N;
      arm.push(sample(rLast + (thi - rLast) * s * s));
    }
    branches.push({ closed: false, samples: arm });

    // Vertical window: what the curve does near the roots (out to 0.8 span
    // past the last one), so the oval and the point cluster stay legible
    // rather than being flattened by the arm's height at the window edge.
    var Ymin = Infinity, Ymax = -Infinity;
    var near = rLast + 0.8 * span;
    branches.forEach(function (br) {
      br.samples.forEach(function (q) {
        if (q.t <= near) { Ymin = Math.min(Ymin, q.lo); Ymax = Math.max(Ymax, q.hi); }
      });
    });
    // Witness points inside the horizontal window and not absurdly far up the
    // arm (within 3x the near range) stretch the vertical window to fit.
    var Yspan = Ymax - Ymin || 1;
    pts.forEach(function (p) {
      if (isFinite(p.t) && isFinite(p.Y) && p.t >= tlo && p.t <= thi && p.Y >= Ymin - 3 * Yspan && p.Y <= Ymax + 3 * Yspan) {
        Ymin = Math.min(Ymin, p.Y); Ymax = Math.max(Ymax, p.Y);
      }
    });
    // Symmetric about y = 0 so the x-axis sits at mid-height on every plot.
    var Yhalf = Math.max(-Ymin, Ymax, 1e-9);
    var pad = 0.06 * Yhalf;
    var Ylo = -(Yhalf + pad), Yhi = Yhalf + pad;
    // Once both branches of the arm have left through the top and bottom,
    // nothing further right is visible (a witness point inside the vertical
    // window lies on a branch before it exits), so trim the horizontal window.
    for (var e = 0; e < arm.length; e++) {
      if (arm[e].hi > Yhi && arm[e].lo < Ylo) { thi = Math.min(thi, arm[e].t + 0.08 * span); break; }
    }
    var win = { tlo: tlo, thi: thi, Ylo: Ylo, Yhi: Yhi };
    var inside = pts.filter(function (p) {
      return isFinite(p.t) && isFinite(p.Y) && p.t >= win.tlo && p.t <= win.thi && p.Y >= win.Ylo && p.Y <= win.Yhi;
    });
    return { k: k, roots: roots, branches: branches, window: win, points: pts, inside: inside, components: roots.length === 3 ? 2 : 1 };
  }

  function clip(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

  function render(fig) {
    var ainvs = JSON.parse(fig.dataset.ainvs);
    var points = JSON.parse(fig.dataset.points);
    var plot = computePlot(ainvs, points);
    var svg = fig.querySelector('svg');
    var W = 600, H = 380, M = 12;
    var w = plot.window;
    var X = function (t) { return M + ((t - w.tlo) / (w.thi - w.tlo)) * (W - 2 * M); };
    var Y = function (y) { return H - M - ((y - w.Ylo) / (w.Yhi - w.Ylo)) * (H - 2 * M); };
    var f = function (v) { return v.toFixed(1); };
    var out = [];
    // Axes, where they fall inside the window.
    if (w.tlo <= 0 && 0 <= w.thi) out.push('<line class="axis" x1="' + f(X(0)) + '" y1="0" x2="' + f(X(0)) + '" y2="' + H + '"/>');
    if (w.Ylo <= 0 && 0 <= w.Yhi) out.push('<line class="axis" x1="0" y1="' + f(Y(0)) + '" x2="' + W + '" y2="' + f(Y(0)) + '"/>');
    plot.branches.forEach(function (br) {
      var s = br.samples, d = [];
      // One continuous stroke: down the upper branch from the far end to the
      // root, then back out along the lower branch. (An oval closes on
      // itself; the arm is left open so no edge gets drawn at the window.)
      for (var j = s.length - 1; j >= 0; j--) d.push((j === s.length - 1 ? 'M' : 'L') + f(X(s[j].t)) + ' ' + f(Y(s[j].hi)));
      for (var i = 0; i < s.length; i++) d.push('L' + f(X(s[i].t)) + ' ' + f(Y(s[i].lo)));
      out.push('<path class="locus' + (br.closed ? ' oval' : '') + '" d="' + d.join(' ') + (br.closed ? ' Z' : '') + '"/>');
    });
    plot.inside.forEach(function (p) {
      out.push(
        '<circle class="pt" cx="' + f(X(p.t)) + '" cy="' + f(Y(p.Y)) + '" r="4.5">' +
          '<title>(' + clip(p.x, 40) + ', ' + clip(p.y, 40) + ')</title></circle>',
      );
    });
    svg.innerHTML = out.join('');
    var n = plot.points.length, m = plot.inside.length;
    var cap =
      'Real locus (' + (plot.components === 2 ? 'two components' : 'one component') + ') with ' +
      (m === n ? (n === 1 ? 'its witness point' : n === 2 ? 'both witness points' : 'all ' + n + ' witness points') : m + ' of the ' + n + ' witness points') +
      (m < n ? '; the other ' + (n - m === 1 ? 'one lies' : n - m + ' lie') + ' outside the plotted range' : '') +
      '.';
    fig.querySelector('figcaption').textContent = cap;
    fig.hidden = false;
  }

  if (typeof window !== 'undefined') window.__curvePlot = computePlot;
  if (typeof document !== 'undefined' && document.getElementById) {
    var fig = document.getElementById('curve-plot');
    if (fig) {
      try { render(fig); } catch (e) { fig.hidden = true; }
    }
  }
})();
