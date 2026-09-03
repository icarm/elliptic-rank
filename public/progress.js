// Client side of /progress (rendered by progressPage in src/pages.ts): the
// id/start sliders, metric switch, reference curves and playback. Reads its
// data from the JSON block with id "progress-data" that the page emits just
// before this script; the SVG geometry mirrors the server's constants.
(() => {
  const data = JSON.parse(document.getElementById('progress-data').textContent);
  const points = data.points;
  const ids = points.map((p) => p.id);
  const referenceCurves = data.referenceCurves;
  const metrics = {
    conductor: { label: 'log conductor', format: (v) => v.toFixed(0) },
    naive: { label: 'naive height', format: (v) => v.toFixed(0) },
    faltings: { label: 'Faltings height', format: (v) => v.toFixed(2) },
    disc: { label: 'log |discriminant|', format: (v) => v.toFixed(0) },
  };
  const { T, plotH, L, rankMax: RANK_MAX, plotW: PLOT_W, plotRight: PLOT_RIGHT } = data.geometry;
  const startSlider = document.getElementById('progress-start');
  const startCurrent = document.getElementById('progress-start-current');
  const slider = document.getElementById('progress-id');
  const current = document.getElementById('progress-current');
  const count = document.getElementById('progress-count');
  const play = document.getElementById('progress-play');
  const dots = Array.from(document.querySelectorAll('.progress-link'));
  const metricInputs = Array.from(document.querySelectorAll('input[name="progress-metric"]'));
  const yTicks = Array.from(document.querySelectorAll('.progress-y-tick'));
  const yTitle = document.getElementById('progress-y-title');
  const svg = document.querySelector('.progress-plot');
  const referenceControls = document.getElementById('progress-reference-controls');
  const referenceGroup = document.getElementById('progress-reference-curves');
  const referenceToggles = Array.from(document.querySelectorAll('.progress-reference-toggle'));
  let timer = null;

  function visibleCount(cutoff) {
    let lo = 0, hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] <= cutoff) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function currentMetric() {
    const checked = metricInputs.find((input) => input.checked);
    return checked ? checked.value : 'conductor';
  }

  function scaleFor(metric) {
    // Mirror the server: scale to the best (lowest) value at each rank
    // so one huge low-rank submission cannot stretch the axis.
    const minByRank = new Map();
    points.forEach((p) => {
      const value = p[metric];
      if (value == null) return;
      const prev = minByRank.get(p.rank);
      if (prev == null || value < prev) minByRank.set(p.rank, value);
    });
    if (minByRank.size === 0) return { min: 0, max: 1 };
    let min = Infinity, max = -Infinity;
    minByRank.forEach((value) => {
      if (value < min) min = value;
      if (value > max) max = value;
    });
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.05;
    return { min: min - pad, max: max + pad };
  }

  function yFor(value, scale) {
    return T + plotH - ((value - scale.min) / (scale.max - scale.min)) * plotH;
  }

  function xForRank(rank) {
    return L + (rank / RANK_MAX) * PLOT_W;
  }

  function referenceGeometry(c, scale) {
    const qStart = Math.max(scale.min, 1.000001);
    const qEnd = scale.max;
    if (qEnd <= qStart) return { d: '', label: null };
    let d = '';
    let drawing = false;
    let last = null;
    for (let i = 0; i <= 180; i++) {
      const q = qStart + (i / 180) * (qEnd - qStart);
      const denom = Math.log(q);
      const rank = c * q / denom;
      if (!Number.isFinite(rank) || rank < 0 || rank > RANK_MAX) {
        drawing = false;
        continue;
      }
      const x = xForRank(rank);
      const y = yFor(q, scale);
      d += (drawing ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
      drawing = true;
      last = { x, y };
    }
    if (last == null) return { d, label: null };
    const nearRight = last.x > PLOT_RIGHT - 80;
    return {
      d,
      label: {
        x: nearRight ? Math.max(L + 8, last.x - 8) : Math.min(PLOT_RIGHT - 8, last.x + 8),
        y: Math.max(T + 16, Math.min(T + plotH - 8, last.y - 6)),
        anchor: nearRight ? 'end' : 'start',
      },
    };
  }

  function referenceToggle(key) {
    return referenceToggles.find((input) => input.value === key);
  }

  function renderReferenceCurves(metric, scale) {
    const conductorMode = metric === 'conductor';
    referenceControls.classList.toggle('is-disabled', !conductorMode);
    referenceGroup.classList.toggle('is-hidden', !conductorMode);
    referenceToggles.forEach((input) => { input.disabled = !conductorMode; });
    referenceCurves.forEach((curve) => {
      const toggle = referenceToggle(curve.key);
      const path = referenceGroup.querySelector('[data-ref="' + curve.key + '"]');
      const label = referenceGroup.querySelector('[data-ref-label="' + curve.key + '"]');
      const enabled = conductorMode && toggle && toggle.checked;
      const geom = enabled ? referenceGeometry(curve.c, scale) : { d: '', label: null };
      path.setAttribute('d', geom.d);
      path.style.display = enabled && geom.d ? '' : 'none';
      label.style.display = enabled && geom.label ? '' : 'none';
      if (geom.label) {
        label.setAttribute('x', geom.label.x.toFixed(1));
        label.setAttribute('y', geom.label.y.toFixed(1));
        label.setAttribute('text-anchor', geom.label.anchor);
      }
    });
  }

  function render() {
    const metric = currentMetric();
    const cfg = metrics[metric];
    const scale = scaleFor(metric);
    const start = Number(startSlider.value);
    if (Number(slider.value) < start) slider.value = String(start);
    const cutoff = Number(slider.value);
    let baseline = 0;
    let shown = 0;
    startCurrent.value = '#' + start;
    current.value = '#' + cutoff;
    yTicks.forEach((tick) => {
      const i = Number(tick.dataset.tick);
      const value = scale.min + (i / 5) * (scale.max - scale.min);
      tick.textContent = cfg.format(value);
    });
    yTitle.textContent = cfg.label + ' \u2192';
    svg.setAttribute('aria-label', cfg.label + ' versus rank over time');
    renderReferenceCurves(metric, scale);
    dots.forEach((a, i) => {
      const p = points[i];
      const value = p[metric];
      const hasValue = value != null;
      const gray = hasValue && p.id <= start;
      const on = hasValue && p.id > start && p.id <= cutoff;
      if (gray) baseline += 1;
      if (on) shown += 1;
      const c = a.querySelector('circle');
      const title = c.querySelector('title');
      c.classList.toggle('is-baseline', gray);
      c.classList.toggle('is-visible', on);
      c.setAttribute('r', gray ? '3.5' : on ? '5' : '0');
      c.setAttribute('cy', hasValue ? yFor(value, scale).toFixed(1) : String(T + plotH));
      title.textContent = hasValue
        ? 'curve #' + p.id + ': rank >= ' + p.rank + ', ' + cfg.label + ' ' + cfg.format(value)
        : 'curve #' + p.id + ': ' + cfg.label + ' not recorded';
    });
    count.textContent = shown + ' new; ' + baseline + ' gray';
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    play.textContent = 'Play';
  }

  function updateStartUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('start', startSlider.value);
    window.history.replaceState(null, '', url);
  }

  function updateMetricUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('metric', currentMetric());
    window.history.replaceState(null, '', url);
  }

  startSlider.addEventListener('input', () => { stop(); updateStartUrl(); render(); });
  slider.addEventListener('input', () => { stop(); render(); });
  metricInputs.forEach((input) => {
    input.addEventListener('change', () => { stop(); updateMetricUrl(); render(); });
  });
  referenceToggles.forEach((input) => {
    input.addEventListener('change', render);
  });
  play.addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (Number(slider.value) >= Number(slider.max)) slider.value = startSlider.value;
    play.textContent = 'Pause';
    timer = setInterval(() => {
      const next = ids[visibleCount(Number(slider.value))];
      if (next == null) { slider.value = slider.max; render(); stop(); return; }
      slider.value = String(next);
      render();
    }, 90);
    render();
  });
  render();
})();
