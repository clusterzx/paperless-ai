// Apply the saved theme and accent colour before the first paint to avoid flashing (kept external for the CSP).
(function () {
  try {
    var t = localStorage.getItem('pai-theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var accent = localStorage.getItem('pai-accent');
    if (accent && accent !== 'iris') document.documentElement.dataset.accent = accent;
  } catch {
    /* storage unavailable */
  }
})();
