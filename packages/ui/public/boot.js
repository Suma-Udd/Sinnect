// If something breaks before the app draws, show it instead of a blank window.
function sinnectBootError(text) {
  var el = document.getElementById('boot-msg');
  if (el) { el.style.color = '#f87171'; el.style.maxWidth = '80vw'; el.style.whiteSpace = 'pre-wrap'; el.textContent = 'Sinnect could not start: ' + text; }
}
window.addEventListener('error', function (e) { sinnectBootError(e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')); });
window.addEventListener('unhandledrejection', function (e) { sinnectBootError(String(e.reason && (e.reason.stack || e.reason))); });
