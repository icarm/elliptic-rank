// Client side of the landing page plot (landingPage in src/pages.ts): switch
// between the pre-rendered per-metric panels and toggle best-only/all curves,
// mirroring the choice into the query string. No JS: the <noscript> style in
// the page shows every panel instead.
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
  var showAll = document.getElementById('plot-show-all');
  var board = document.querySelector('.board');
  showAll.addEventListener('change', function () {
    board.classList.toggle('best-only', !showAll.checked);
    var q = new URLSearchParams(location.search);
    if (showAll.checked) q.set('show', 'all'); else q.delete('show');
    var qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  });
})();
