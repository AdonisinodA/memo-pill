// Comportamentos da página. Em arquivo próprio para que a CSP possa manter
// script-src 'self' sem precisar de 'unsafe-inline' (ADR-001 §2.4).

// Registro do Service Worker.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((erro) => {
      console.error('Falha ao registrar o Service Worker', erro);
    });
  });
}

// Toast: o servidor já renderizou a mensagem; aqui só cuidamos de tirá-la da
// frente. Erros ficam mais tempo na tela — o usuário precisa ler o que corrigir.
(function () {
  const toast = document.getElementById('toast');
  if (!toast) return;

  const AUTO_DISMISS_MS = toast.getAttribute('role') === 'alert' ? 8000 : 4000;
  let timer = null;

  function dismiss() {
    if (timer) clearTimeout(timer);
    toast.classList.add('opacity-0');
    // Remove só depois da transição declarada na classe (duration-300), para a
    // saída não ser um corte seco.
    setTimeout(() => toast.remove(), 300);
  }

  const close = document.getElementById('toast-close');
  if (close) close.addEventListener('click', dismiss);

  document.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape') dismiss();
  });

  timer = setTimeout(dismiss, AUTO_DISMISS_MS);
})();
