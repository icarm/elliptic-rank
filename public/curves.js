// Client side of the curve table (curveTablePage in src/pages.ts): live
// sorting, the rank filter and the query-string round trip. Without JS the
// sort links and the controls form still work server-side.
(function () {
  var KEYS = ['id', 'rank', 'naive', 'faltings', 'conductor', 'disc'];
  var tbody = document.getElementById('curves-table').tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var rankInput = document.getElementById('rank-filter');
  var rankOp = document.getElementById('rank-op');
  var count = document.getElementById('curve-count');
  var heading = document.getElementById('table-title');
  var buttons = document.querySelectorAll('a.sort');
  var sortKey = 'conductor';
  var sortDir = 1; // 1 = ascending, -1 = descending; default: smallest conductor first

  var params = new URLSearchParams(location.search);
  if (KEYS.indexOf(params.get('sort')) >= 0) {
    sortKey = params.get('sort');
    sortDir = params.get('dir') === 'desc' ? -1 : 1;
  }
  if (/^[0-9]+$/.test(params.get('minrank') || '')) rankInput.value = params.get('minrank');
  if (params.get('rankmode') === 'eq') rankOp.value = 'eq';

  function apply() {
    rows.sort(function (a, b) {
      var av = a.dataset[sortKey], bv = b.dataset[sortKey];
      if (av === '') return bv === '' ? 0 : 1; // missing values last either way
      if (bv === '') return -1;
      return (Number(av) - Number(bv)) * sortDir;
    });
    // Rank values are proven lower bounds. Empty input = no filter;
    // otherwise restrict to lower bound == n ("=") or lower bound >= n (">=").
    var hasFilter = /^[0-9]+$/.test(rankInput.value);
    var n = Number(rankInput.value);
    var eq = rankOp.value === 'eq';
    // "=" with an empty box means no filter (any rank); ">=" defaults to 1.
    rankInput.placeholder = eq ? 'any' : '1';
    var shown = 0;
    rows.forEach(function (r) {
      var rk = Number(r.dataset.rank);
      r.hidden = hasFilter && (eq ? rk !== n : rk < n);
      if (!r.hidden) shown++;
      tbody.appendChild(r);
    });
    count.textContent = shown;
    buttons.forEach(function (b) {
      b.className = 'sort' + (b.dataset.key === sortKey ? (sortDir === 1 ? ' asc' : ' desc') : '');
    });
    // The heading names the current view: "All curves" when unfiltered
    // (including ">= 1", which every curve satisfies), the rank
    // restriction otherwise — same condition as the query string below.
    var restricted = hasFilter && (eq || n > 1);
    var title = restricted
      ? 'Curves with rank lower bound ' + (eq ? '= ' : '\u2265 ') + n
      : 'All curves';
    heading.textContent = title;
    document.title = title + ' \u2014 Elliptic Curve Rank Leaderboard';
    var q = new URLSearchParams();
    if (sortKey !== 'conductor' || sortDir !== 1) {
      q.set('sort', sortKey);
      if (sortDir === -1) q.set('dir', 'desc');
    }
    // Persist the value whenever it filters: any value in "=" mode, or >1 in ">=" mode.
    if (restricted) q.set('minrank', String(n));
    if (eq) q.set('rankmode', 'eq');
    var qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function (e) {
      // Modified clicks fall through to the href (open sorted view in a
      // new tab); the href is also the no-JS fallback.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (sortKey === b.dataset.key) {
        sortDir = -sortDir;
      } else {
        sortKey = b.dataset.key;
        sortDir = sortKey === 'rank' ? -1 : 1; // high rank first; small heights first
      }
      apply();
    });
  });
  rankInput.addEventListener('input', apply);
  rankOp.addEventListener('change', apply);
  // The controls form is the no-JS fallback; here everything is already
  // applied live, so Enter in the rank box must not reload the page.
  document.querySelector('form.table-controls').addEventListener('submit', function (e) {
    e.preventDefault();
  });
  // Clicking a row's "≥ N" restricts the view to exactly that lower bound,
  // in place (preserving the current sort). Modified clicks fall through to
  // the link's href so the filtered view can still open in a new tab.
  tbody.addEventListener('click', function (e) {
    var a = e.target.closest('a.rank-link');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    rankInput.value = a.closest('tr').dataset.rank;
    rankOp.value = 'eq';
    apply();
  });
  apply();
})();
