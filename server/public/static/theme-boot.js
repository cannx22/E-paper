// Sayfa cizilmeden once temayi uygula (koyu varsayilan) - beyaz yanip sonmesin.
(function () {
  var theme = 'dark';
  try { theme = localStorage.getItem('epaper-theme') || 'dark'; } catch (e) {}
  document.documentElement.setAttribute('data-bs-theme', theme);
})();
