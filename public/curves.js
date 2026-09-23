// Client side of the curve table (curveTablePage in src/pages.ts): live
// sorting, the rank and torsion filters and the query-string round trip. Without JS the
// sort links and the controls form still work server-side.
(function () {
  var KEYS = ['id', 'rank', 'naive', 'faltings', 'conductor', 'disc'];
  var tbody = document.getElementById('curves-table').tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var rankInput = document.getElementById('rank-filter');
  var rankOp = document.getElementById('rank-op');
  var torsionSel = document.getElementById('torsion-filter');
  var count = document.getElementById('curve-count');
  var heading = document.getElementById('table-title');
  var buttons = document.querySelectorAll('a.sort');
  var sortKey = 'conductor';
  var sortDir = 1; // 1 = ascending, -1 = descending; default: smallest conductor first
  var lastTorsion = null; // the torsion filter the record highlights were last set for

  var params = new URLSearchParams(location.search);
  if (KEYS.indexOf(params.get('sort')) >= 0) {
    sortKey = params.get('sort');
    sortDir = params.get('dir') === 'desc' ? -1 : 1;
  }
  if (/^[0-9]+$/.test(params.get('minrank') || '')) rankInput.value = params.get('minrank');
  if (params.get('rankmode') === 'eq') rankOp.value = 'eq';
  // Only offered groups are selectable; anything else leaves "any".
  if (params.get('torsion')) torsionSel.value = params.get('torsion');
  if (torsionSel.selectedIndex < 0) torsionSel.value = '';

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
    // "=" with an empty box means no filter (any rank); ">=" defaults to 0.
    rankInput.placeholder = eq ? 'any' : '0';
    var torsion = torsionSel.value;
    var shown = 0;
    rows.forEach(function (r) {
      var rk = Number(r.dataset.rank);
      r.hidden = (hasFilter && (eq ? rk !== n : rk < n)) ||
        (torsion !== '' && r.dataset.torsion !== torsion);
      if (!r.hidden) shown++;
      tbody.appendChild(r);
    });
    count.textContent = shown;
    // With a torsion subgroup selected, highlight records within the subgroup
    // (each row's data-trec) instead of overall records (data-rec); those that
    // are not also overall records get the hollow star. Classes and titles
    // match curveTableRow's.
    if (torsion !== lastTorsion) {
      lastTorsion = torsion;
      rows.forEach(function (r) {
        var rank = r.dataset.rank;
        Array.prototype.forEach.call(r.querySelectorAll('td[data-rec]'), function (td) {
          var on = (torsion !== '' ? td.dataset.trec : td.dataset.rec) === '1';
          var torsionOnly = on && td.dataset.rec !== '1';
          td.classList.toggle('record', on);
          td.classList.toggle('torsion-record', torsionOnly);
          if (on) {
            td.title = torsionOnly
              ? 'record for this torsion subgroup: smallest among curves of rank \u2265 ' + rank + ' with this torsion'
              : 'record: smallest among curves of rank \u2265 ' + rank;
          } else {
            td.removeAttribute('title');
          }
        });
      });
    }
    buttons.forEach(function (b) {
      b.className = 'sort' + (b.dataset.key === sortKey ? (sortDir === 1 ? ' asc' : ' desc') : '');
    });
    // The heading names the current view: "All curves" when unfiltered
    // (including ">= 0", which every curve satisfies), the rank and torsion
    // restrictions otherwise — same condition as the query string below.
    var restricted = hasFilter && (eq || n > 0);
    var phrases = [];
    if (restricted) phrases.push('rank lower bound ' + (eq ? '= ' : '\u2265 ') + n);
    if (torsion === 'trivial') phrases.push('trivial torsion');
    else if (torsion !== '') phrases.push('torsion ' + torsionSel.selectedOptions[0].dataset.label);
    var title = phrases.length ? 'Curves with ' + phrases.join(' and ') : 'All curves';
    heading.textContent = title;
    document.title = title + ' \u2014 Elliptic Curve Rank Leaderboard';
    var q = new URLSearchParams();
    if (sortKey !== 'conductor' || sortDir !== 1) {
      q.set('sort', sortKey);
      if (sortDir === -1) q.set('dir', 'desc');
    }
    // Persist the value whenever it filters: any value in "=" mode, or >0 in ">=" mode.
    if (restricted) q.set('minrank', String(n));
    if (eq) q.set('rankmode', 'eq');
    if (torsion !== '') q.set('torsion', torsion);
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
  torsionSel.addEventListener('change', apply);
  // The controls form is the no-JS fallback; here everything is already
  // applied live, so Enter in the rank box must not reload the page.
  document.querySelector('form.table-controls').addEventListener('submit', function (e) {
    e.preventDefault();
  });
  // Clicking a row's "≥ N" restricts the view to exactly that lower bound,
  // in place (preserving the current sort). Modified clicks fall through to
  // the link's href so the filtered view can still open in a new tab.
  // A torsion cell likewise restricts to that torsion subgroup.
  tbody.addEventListener('click', function (e) {
    var a = e.target.closest('a.rank-link, a.torsion-link');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (a.classList.contains('rank-link')) {
      rankInput.value = a.closest('tr').dataset.rank;
      rankOp.value = 'eq';
    } else {
      torsionSel.value = a.closest('tr').dataset.torsion;
    }
    apply();
  });
  apply();
})();
