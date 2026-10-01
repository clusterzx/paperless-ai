// Apply the saved theme before the first paint to avoid flashing (kept external for the CSP).
(function () {
  try {
    var t = localStorage.getItem('pai-theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch {
    /* storage unavailable */
  }
})();
