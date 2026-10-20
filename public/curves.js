// Client side of the curve table (curveTablePage in src/pages.ts): live
// sorting, the rank and subset (torsion subgroup or family) filters and the
// query-string round trip. Without JS the
// sort links and the controls form still work server-side.
(function () {
  var KEYS = ['id', 'rank', 'naive', 'faltings', 'conductor', 'disc'];
  var tbody = document.getElementById('curves-table').tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var rankInput = document.getElementById('rank-filter');
  var rankOp = document.getElementById('rank-op');
  var subsetSel = document.getElementById('subset-filter');
  var count = document.getElementById('curve-count');
  var heading = document.getElementById('table-title');
  var buttons = document.querySelectorAll('a.sort');
  var sortKey = 'rank';
  var sortDir = -1; // 1 = ascending, -1 = descending; default: highest rank first
  var lastSubset = null; // the subset filter the record highlights were last set for

  var params = new URLSearchParams(location.search);
  if (KEYS.indexOf(params.get('sort')) >= 0) {
    sortKey = params.get('sort');
    sortDir = params.get('dir') === 'desc' ? -1 : 1;
  }
  if (/^[0-9]+$/.test(params.get('minrank') || '')) rankInput.value = params.get('minrank');
  if (params.get('rankmode') === 'eq') rankOp.value = 'eq';
  // Only offered subsets are selectable; anything else leaves all curves. Same
  // precedence as pickSubset in pages.ts.
  if (params.get('subset')) subsetSel.value = params.get('subset');
  else if (params.get('family')) subsetSel.value = 'family:' + params.get('family');
  else if (params.get('torsion')) subsetSel.value = 'torsion:' + params.get('torsion');
  if (subsetSel.selectedIndex < 0) subsetSel.value = '';

  // Whether `key` is among the space-separated keys of `list`: a row's
  // data-torsion (one key) or data-families, or a cell's data-frec (the
  // families it is a record in).
  function inSubset(list, key) {
    return (list || '').split(' ').indexOf(key) >= 0;
  }

  function compare(av, bv, dir) {
    if (av === '') return bv === '' ? 0 : 1; // missing values last either way
    if (bv === '') return -1;
    return (Number(av) - Number(bv)) * dir;
  }

  function apply() {
    // Ties (common for rank) by increasing conductor, then id, so the order
    // does not depend on earlier sorts; same as curveTablePage.
    rows.sort(function (a, b) {
      return compare(a.dataset[sortKey], b.dataset[sortKey], sortDir) ||
        compare(a.dataset.conductor, b.dataset.conductor, 1) ||
        Number(a.dataset.id) - Number(b.dataset.id);
    });
    // Rank values are proven lower bounds. Empty input = no filter;
    // otherwise restrict to lower bound == n ("=") or lower bound >= n (">=").
    var hasFilter = /^[0-9]+$/.test(rankInput.value);
    var n = Number(rankInput.value);
    var eq = rankOp.value === 'eq';
    // "=" with an empty box means no filter (any rank); ">=" defaults to 0.
    rankInput.placeholder = eq ? 'any' : '0';
    // "torsion:2x4" or "family:mordell" (matched against the row's
    // data-torsion or data-families), or '' for all curves.
    var subset = subsetSel.value;
    var kind = subset.split(':')[0];
    var key = subset.slice(kind.length + 1);
    var option = subsetSel.selectedOptions[0];
    var shown = 0;
    rows.forEach(function (r) {
      var rk = Number(r.dataset.rank);
      r.hidden = (hasFilter && (eq ? rk !== n : rk < n)) ||
        (subset !== '' && !inSubset(r.dataset[kind === 'torsion' ? 'torsion' : 'families'], key));
      if (!r.hidden) shown++;
    });
    // One call sets the new order. Appending the rows one at a time left the
    // whitespace between the server-rendered rows piled up in front of them,
    // and Chrome then took over a second per re-sort.
    tbody.replaceChildren.apply(tbody, rows);
    count.textContent = shown;
    // With a subset selected, highlight records within it too (each row's
    // data-trec or data-frec) besides overall records (data-rec); those that
    // are not also overall records get the hollow star. Classes and titles
    // match curveTableRow's.
    if (subset !== lastSubset) {
      lastSubset = subset;
      rows.forEach(function (r) {
        var rank = r.dataset.rank;
        Array.prototype.forEach.call(r.querySelectorAll('td[data-rec]'), function (td) {
          var overall = td.dataset.rec === '1';
          var on = overall || (kind === 'torsion' && td.dataset.trec === '1') || (kind === 'family' && inSubset(td.dataset.frec, key));
          var subsetOnly = on && !overall;
          td.classList.toggle('record', on);
          td.classList.toggle('subset-record', subsetOnly);
          if (on) {
            td.title = !subsetOnly
              ? 'record: smallest among curves of rank \u2265 ' + rank
              : kind === 'family'
                ? 'record for ' + option.dataset.name + ': smallest among ' + option.dataset.name + ' of rank \u2265 ' + rank
                : 'record for this torsion subgroup: smallest among curves of rank \u2265 ' + rank + ' with this torsion';
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
    // (including ">= 0", which every curve satisfies), the rank and subset
    // restrictions otherwise — same condition as the query string below.
    var restricted = hasFilter && (eq || n > 0);
    var phrases = [];
    if (restricted) phrases.push('rank lower bound ' + (eq ? '= ' : '\u2265 ') + n);
    if (option.dataset.phrase) phrases.push(option.dataset.phrase);
    var title = phrases.length || subset !== ''
      ? (option.dataset.noun || 'Curves') + (phrases.length ? ' with ' + phrases.join(' and ') : '')
      : 'All curves';
    heading.textContent = title;
    document.title = title + ' \u2014 Elliptic Curve Rank Leaderboard';
    var q = new URLSearchParams();
    if (sortKey !== 'rank' || sortDir !== -1) {
      q.set('sort', sortKey);
      if (sortDir === -1) q.set('dir', 'desc');
    }
    // Persist the value whenever it filters: any value in "=" mode, or >0 in ">=" mode.
    if (restricted) q.set('minrank', String(n));
    if (eq) q.set('rankmode', 'eq');
    if (subset !== '') q.set(kind, key);
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
  subsetSel.addEventListener('change', apply);
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
      subsetSel.value = 'torsion:' + a.closest('tr').dataset.torsion;
    }
    apply();
  });
  apply();
})();
