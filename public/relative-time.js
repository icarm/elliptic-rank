// Show the page's <time datetime> elements (rendered by utcTime in
// src/pages.ts as an absolute UTC time, which stays as the tooltip) relative
// to now: "just now", "5 minutes ago", "yesterday", "4 days ago". Anything a
// month or more old shows its date instead. Refreshed every minute so the
// text keeps up with a page left open. No JS: the absolute times remain.
(function () {
  var times = Array.prototype.slice.call(document.querySelectorAll('time[datetime]'));
  if (times.length === 0) return;
  var fmt = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
    ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
    : null;
  if (!fmt) return;
  var MINUTE = 60, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  function relative(t, now) {
    var s = Math.max(0, Math.round((now - t) / 1000)); // clock skew: never "in 2 minutes"
    if (s < MINUTE) return 'just now';
    if (s < HOUR) return fmt.format(-Math.floor(s / MINUTE), 'minute');
    if (s < DAY) return fmt.format(-Math.floor(s / HOUR), 'hour');
    if (s < 30 * DAY) return fmt.format(-Math.floor(s / DAY), 'day');
    return 'on ' + new Date(t).toISOString().slice(0, 10);
  }
  function update() {
    var now = Date.now();
    times.forEach(function (el) {
      var t = Date.parse(el.getAttribute('datetime'));
      if (!isNaN(t)) el.textContent = relative(t, now);
    });
  }
  update();
  setInterval(update, 60 * 1000);
})();
