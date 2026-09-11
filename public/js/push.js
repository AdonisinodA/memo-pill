/**
 * Inscrição em Web Push.
 *
 * O servidor só tem a quem enviar depois que ESTE código roda: o agendador
 * despacha a dose no horário, mas `notifyDose` percorre as inscrições do
 * usuário — sem inscrição, o disparo acontece e nada chega ao aparelho.
 *
 * Arquivo próprio, carregado pelo layout, para a CSP manter script-src 'self'
 * (ADR-001 §2.4).
 */
(function () {
  preencherEndpointDeSaida();

  const banner = document.getElementById('push-banner');
  if (!banner) return;

  const texto = document.getElementById('push-text');
  const botao = document.getElementById('push-enable');

  const SUPORTADO =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  function mostrar(mensagem, comBotao) {
    texto.textContent = mensagem;
    botao.classList.toggle('hidden', !comBotao);
    banner.classList.remove('hidden');
  }

  function esconder() {
    banner.classList.add('hidden');
  }

  /**
   * A chave VAPID trafega em base64url e o `applicationServerKey` exige bytes.
   */
  function chaveEmBytes(base64url) {
    const preenchimento = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + preenchimento).replace(/-/g, '+').replace(/_/g, '/');
    const binario = atob(base64);
    return Uint8Array.from(binario, (c) => c.charCodeAt(0));
  }

  async function json(url, options) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(options && options.headers) },
      ...options,
    });
    if (!res.ok) throw new Error(`${url} respondeu ${res.status}`);
    return res.json();
  }

  /** Envia ao servidor a inscrição achatada no formato que o DTO espera. */
  async function registrarNoServidor(subscription) {
    const { endpoint, keys } = subscription.toJSON();
    const { csrfToken } = await json('/csrf');

    await json('/push/inscrever', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth }),
    });
  }

  async function inscrever() {
    const registration = await navigator.serviceWorker.ready;
    const existente = await registration.pushManager.getSubscription();
    if (existente) {
      // Reenvia mesmo já existindo no navegador: o banco pode ter sido
      // recriado, ou a inscrição pertencer a outra conta neste aparelho.
      await registrarNoServidor(existente);
      return;
    }

    const { key } = await json('/push/chave-publica');
    const subscription = await registration.pushManager.subscribe({
      // Exigido pelos navegadores: todo push precisa virar notificação visível.
      userVisibleOnly: true,
      applicationServerKey: chaveEmBytes(key),
    });
    await registrarNoServidor(subscription);
  }

  async function ativar() {
    botao.disabled = true;
    try {
      // `requestPermission` só é aceito a partir de um gesto do usuário —
      // daí a ativação nascer no clique, e não no carregamento da página.
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') {
        mostrar('Permissão negada. Libere as notificações nas configurações do navegador para receber os lembretes.', false);
        return;
      }
      await inscrever();
      mostrar('Lembretes ativados neste aparelho.', false);
      setTimeout(esconder, 4000);
    } catch (erro) {
      console.error('Falha ao ativar os lembretes', erro);
      mostrar('Não foi possível ativar os lembretes agora. Tente de novo.', true);
    } finally {
      botao.disabled = false;
    }
  }

  async function iniciar() {
    if (!SUPORTADO) {
      mostrar('Este navegador não suporta notificações. Abra o app pelo celular para receber os lembretes.', false);
      return;
    }
    if (Notification.permission === 'denied') {
      mostrar('Notificações bloqueadas. Libere-as nas configurações do navegador para voltar a receber os lembretes.', false);
      return;
    }
    if (Notification.permission === 'default') {
      mostrar('Ative os lembretes para ser avisado na hora de cada dose.', true);
      return;
    }

    // Permissão já concedida: reinscreve em silêncio, sem pedir nada. O
    // endpoint muda sozinho (limpeza do navegador, reinstalação do PWA) e a
    // inscrição no servidor fica órfã sem que o usuário perceba.
    try {
      await inscrever();
      esconder();
    } catch (erro) {
      console.error('Falha ao registrar a inscrição push', erro);
      mostrar('Os lembretes deste aparelho não estão registrados. Toque para tentar de novo.', true);
    }
  }

  botao.addEventListener('click', ativar);
  iniciar();
})();

/**
 * Diz ao formulário de saída qual aparelho desinscrever.
 *
 * Vai num campo do próprio formulário, e não numa chamada antes do submit: se
 * o JavaScript falhar, o logout continua acontecendo — só sem desligar o push.
 * O contrário (interceptar o submit) faria uma falha aqui impedir o usuário
 * de sair, que é o pior desfecho possível para um botão de segurança.
 */
async function preencherEndpointDeSaida() {
  const campos = document.querySelectorAll('input[data-push-endpoint]');
  if (campos.length === 0) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    campos.forEach((campo) => {
      campo.value = subscription.endpoint;
    });
  } catch (erro) {
    console.error('Não foi possível identificar a inscrição deste aparelho', erro);
  }
}
