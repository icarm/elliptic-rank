// Client side of the landing page plot (landingPage in src/pages.ts): switch
// between the pre-rendered per-metric panels and toggle best-only/all curves,
// mirroring the choice into the query string, and reload for a new torsion
// subgroup (rendered server-side). No JS: the <noscript> style in the page
// shows every panel instead, and an "apply" button submits the torsion form.
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
  var torsion = document.getElementById('plot-torsion');
  torsion.addEventListener('change', function () {
    var q = new URLSearchParams(location.search);
    if (torsion.value) q.set('torsion', torsion.value); else q.delete('torsion');
    var qs = q.toString();
    location.assign(location.pathname + (qs ? '?' + qs : ''));
  });
})();
