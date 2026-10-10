// Client error reporter. Kept as an external file (not inline in index.html) because the production/desktop
// CSP is script-src 'self' and blocks inline scripts.
window.addEventListener('error', function(event) {
  var msg = event.message || '';
  if (msg.indexOf('WebSocket') !== -1 || msg.indexOf('vite') !== -1) return;
  fetch('/api/log-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, filename: event.filename, lineno: event.lineno, colno: event.colno, error: event.error ? event.error.stack : null }) });
});
window.addEventListener('unhandledrejection', function(event) {
  var reason = event.reason ? (event.reason.stack || event.reason.toString()) : 'Unhandled Rejection';
  if (reason.indexOf('WebSocket') !== -1 || reason.indexOf('vite') !== -1) return;
  fetch('/api/log-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: event.reason ? event.reason.toString() : 'Unhandled Rejection', stack: event.reason && event.reason.stack ? event.reason.stack : null }) });
});
