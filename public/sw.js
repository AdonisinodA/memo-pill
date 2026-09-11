/**
 * Service Worker — recebimento de push e confirmação de dose.
 * Ver ADR-001 §2.1.
 */

const ROTA_HOJE = '/doses/hoje';

/** Título usado quando o resumo da dose não chega ou vem incompleto. */
const TITULO_PADRAO = 'Hora do seu medicamento';
const CORPO_PADRAO = 'Toque para ver os detalhes.';

/**
 * Assume o controle assim que instala, sem esperar as abas abertas fecharem.
 *
 * O padrão do Service Worker é ficar em `waiting` enquanto a versão anterior
 * controla algum cliente — e quem renderiza a notificação é justamente o SW.
 * Sem isto, uma correção aqui só chega ao usuário quando ele fecha todas as
 * abas do app, e até lá a versão antiga segue montando as notificações.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Texto não vazio; qualquer outra coisa vira o padrão, nunca "undefined". */
function textoOu(valor, padrao) {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : padrao;
}

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

  let titulo = TITULO_PADRAO;
  let corpo = CORPO_PADRAO;

  if (doseId) {
    try {
      const res = await fetch(`/doses/${doseId}/resumo`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const dose = await res.json();
        // Os campos são os de `DoseView` (name/dosage/time). O valor passa por
        // `textoOu` porque o título vai direto para a tela de bloqueio: um
        // campo ausente escreveria "undefined" ali, sem chance de correção.
        titulo = textoOu(dose.name, TITULO_PADRAO);
        corpo = textoOu(
          [dose.dosage, dose.time].filter((v) => typeof v === 'string' && v !== '').join(' · '),
          CORPO_PADRAO,
        );
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
