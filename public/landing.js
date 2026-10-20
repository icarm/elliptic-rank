// Client side of the landing page plot (landingPage in src/pages.ts): switch
// between the pre-rendered per-metric panels and toggle best-only/all curves,
// mirroring the choice into the query string, and reload for a new subset
// (a torsion subgroup or family, rendered server-side), marking the old plot
// as loading meanwhile. No JS: the <noscript>
// style in the page shows every panel instead, and an "apply" button submits
// the subset form.
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
  bestOnly.addEventListener('change', function () {
    board.classList.toggle('best-only', bestOnly.checked);
    var q = new URLSearchParams(location.search);
    if (bestOnly.checked) q.delete('show'); else q.set('show', 'all');
    var qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  });
  // Option values are "torsion:<key>" or "family:<key>"; the URL carries
  // ?torsion=<key> or ?family=<key>, as landingPage reads it.
  var subset = document.getElementById('plot-subset');
  subset.addEventListener('change', function () {
    // The new page takes a moment (the server recomputes the plots); until it
    // arrives, dim the old plot under a "loading…" label (see style.css).
    board.classList.add('is-loading');
    board.setAttribute('aria-busy', 'true');
    var q = new URLSearchParams(location.search);
    ['subset', 'torsion', 'family'].forEach(function (k) { q.delete(k); });
    if (subset.value) {
      var i = subset.value.indexOf(':');
      q.set(subset.value.slice(0, i), subset.value.slice(i + 1));
    }
    var qs = q.toString();
    location.assign(location.pathname + (qs ? '?' + qs : ''));
  });
  // Coming back to this page from the browser's back-forward cache restores it
  // as it was left: loading, with the dropdown showing the choice that led
  // away rather than the subset this page plots. Undo both; the server marked
  // the plotted subset's option as selected.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    board.classList.remove('is-loading');
    board.removeAttribute('aria-busy');
    Array.prototype.forEach.call(subset.options, function (o) { o.selected = o.defaultSelected; });
  });
})();
