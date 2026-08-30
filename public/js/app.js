// Registro do Service Worker. Em arquivo próprio para que a CSP possa manter
// script-src 'self' sem precisar de 'unsafe-inline' (ADR-001 §2.4).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((erro) => {
      console.error('Falha ao registrar o Service Worker', erro);
    });
  });
}
