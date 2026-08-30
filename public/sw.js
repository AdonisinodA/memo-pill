/**
 * Service Worker — recebimento de push e confirmação de dose.
 * Ver ADR-001 §2.1.
 */

const ROTA_HOJE = '/doses/hoje';

/**
 * O payload push carrega apenas o identificador da dose. O nome do medicamento
 * é buscado aqui, na própria origem, para não trafegar dado de saúde pelo push
 * service (ADR-001 §2.4).
 */
self.addEventListener('push', (event) => {
  event.waitUntil(mostrarLembrete(event));
});

async function mostrarLembrete(event) {
  let doseId = null;
  try {
    doseId = event.data ? event.data.json().doseId : null;
  } catch {
    doseId = null;
  }

  let titulo = 'Hora do seu medicamento';
  let corpo = 'Toque para ver os detalhes.';

  if (doseId) {
    try {
      const res = await fetch(`/doses/${doseId}/resumo`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const dose = await res.json();
        titulo = dose.nome;
        corpo = [dose.dosagem, dose.horario].filter(Boolean).join(' · ');
      }
    } catch {
      // Sem rede: cai no texto genérico em vez de engolir a notificação.
    }
  }

  return self.registration.showNotification(titulo, {
    body: corpo,
    tag: doseId ? `dose-${doseId}` : 'dose',
    data: { doseId },
    badge: '/icons/badge.svg',
    icon: '/icons/icon.svg',
    actions: [
      { action: 'taken', title: 'Tomei' },
      { action: 'skipped', title: 'Pular' },
    ],
  });
}

self.addEventListener('notificationclick', (event) => {
  const doseId = event.notification.data && event.notification.data.doseId;
  const action = event.action;
  event.notification.close();

  if (!doseId || (action !== 'taken' && action !== 'skipped')) {
    event.waitUntil(self.clients.openWindow(ROTA_HOJE));
    return;
  }

  event.waitUntil(registrar(doseId, action));
});

/**
 * O token CSRF é buscado sob demanda, imediatamente antes do POST: o clique
 * pode acontecer horas depois do envio, e o token precisa corresponder à
 * sessão vigente agora (ADR-001 §2.4).
 */
async function registrar(doseId, action) {
  try {
    const csrf = await fetch('/csrf', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!csrf.ok) throw new Error(`/csrf respondeu ${csrf.status}`);
    const { csrfToken } = await csrf.json();

    const res = await fetch(`/doses/${doseId}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`registro respondeu ${res.status}`);
  } catch (erro) {
    // Sessão expirada ou rede fora: abre o app para o usuário concluir à mão,
    // em vez de perder a confirmação silenciosamente.
    console.error('Falha ao registrar a dose', erro);
    await self.clients.openWindow(ROTA_HOJE);
  }
}
