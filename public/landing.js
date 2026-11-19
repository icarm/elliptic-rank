// Client side of the landing page plot (landingPage in src/pages.ts): switch
// between the pre-rendered per-metric panels, mirroring the choice into the
// query string, and reload for a new subset (a torsion subgroup or family) or
// for best-only/all curves (?show=all), both rendered server-side, marking the
// old plot as loading meanwhile. No JS: the <noscript> style in the page shows
// every panel instead, and an "apply" button submits the form.
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('input[name="plot-metric"]'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.board .plot-panel'));
  // The server renders the selected panel already; we only handle switches.
  tabs.forEach(function (t) {
    t.addEventListener('change', function () {
      if (!t.checked) return;
      panels.forEach(function (p) { p.hidden = p.dataset.metric !== t.value; });
      var q = new URLSearchParams(location.search);
      q.set('metric', t.value);
      history.replaceState(null, '', location.pathname + '?' + q.toString());
    });
  });
  var bestOnly = document.getElementById('plot-best-only');
  var board = document.querySelector('.board');
  // The new page takes a moment (the server recomputes the plots); until it
  // arrives, dim the old plot under a "loading…" label (see style.css).
  function reload(q) {
    board.classList.add('is-loading');
    board.setAttribute('aria-busy', 'true');
    var qs = q.toString();
    location.assign(location.pathname + (qs ? '?' + qs : ''));
  }
  // Only the best dots are in the default page, so showing all is a reload.
  bestOnly.addEventListener('change', function () {
    var q = new URLSearchParams(location.search);
    if (bestOnly.checked) q.delete('show'); else q.set('show', 'all');
    reload(q);
  });
  // Option values are "torsion:<key>" or "family:<key>"; the URL carries
  // ?torsion=<key> or ?family=<key>, as landingPage reads it.
  var subset = document.getElementById('plot-subset');
  subset.addEventListener('change', function () {
    var q = new URLSearchParams(location.search);
    ['subset', 'torsion', 'family'].forEach(function (k) { q.delete(k); });
    if (subset.value) {
      var i = subset.value.indexOf(':');
      q.set(subset.value.slice(0, i), subset.value.slice(i + 1));
    }
    reload(q);
  });
  // Coming back to this page from the browser's back-forward cache restores it
  // as it was left: loading, with the dropdown showing the choice that led
  // away rather than the subset or best-only state this page plots. Undo
  // both; the server marked the plotted subset's option as selected.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    board.classList.remove('is-loading');
    board.removeAttribute('aria-busy');
    Array.prototype.forEach.call(subset.options, function (o) { o.selected = o.defaultSelected; });
    bestOnly.checked = bestOnly.defaultChecked;
  });
})();
