import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { setFlash } from './flash/flash';
import { wantsHtml } from './wants-html';

/** Para onde voltar quando o `Referer` não serve. */
const FALLBACK_ROUTE = '/doses/hoje';

/** Detalhe interno não vira texto de tela; o log guarda o que importa. */
const GENERIC_MESSAGE = 'Algo deu errado do nosso lado. Tente novamente.';

/** Mensagens de status cuja causa real não ajuda quem está na tela. */
const BY_STATUS: Readonly<Partial<Record<number, string>>> = {
  [HttpStatus.TOO_MANY_REQUESTS]:
    'Muitas tentativas em pouco tempo. Aguarde um minuto e tente de novo.',
  [HttpStatus.FORBIDDEN]:
    'Sua sessão mudou enquanto a página estava aberta. Recarregue e tente de novo.',
};

/**
 * Único ponto de tradução de exceção em resposta.
 *
 * Navegação de página e chamada de API divergem no que é um erro "tratado":
 * o Service Worker quer o JSON com o status; o navegador, que ficava com o JSON
 * cru na tela, precisa voltar para onde estava com a mensagem em um toast
 * (POST/Redirect/GET). É um filtro só, e não um por tipo de exceção, porque
 * filtros globais empilhados competem pela mesma exceção e a ordem de
 * precedência entre eles não é evidente na leitura do módulo.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const status = this.statusOf(exception);
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${req.method} ${req.originalUrl}`, exception as Error);
    }

    // Resposta já enviada (erro durante o streaming da view): só derrubar.
    if (res.headersSent) {
      res.end();
      return;
    }

    if (!wantsHtml(req)) {
      res.status(status).json(this.jsonBody(exception, status));
      return;
    }

    const message = this.messageOf(exception, status);

    if (status === HttpStatus.UNAUTHORIZED) {
      // Sessão ausente numa navegação leva ao login, não a um 401 cru. Só o
      // POST avisa: no GET, cair no login é o fluxo normal de quem não entrou.
      // A mensagem é a da exceção — num login recusado, o motivo é a senha, e
      // não a sessão.
      if (req.method !== 'GET') setFlash(res, { type: 'error', message });
      res.redirect('/login');
      return;
    }

    // Num GET não há para onde redirecionar sem risco de laço — a própria
    // página que falhou seria o destino. A página de erro fecha o fluxo.
    if (req.method === 'GET') {
      res.status(status).render('error', {
        title: 'Erro',
        status,
        message,
        csrfToken: req.csrfToken,
      });
      return;
    }

    setFlash(res, { type: 'error', message });
    res.redirect(HttpStatus.SEE_OTHER, this.backTo(req));
  }

  private statusOf(exception: unknown): number {
    return exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private jsonBody(exception: unknown, status: number): unknown {
    if (exception instanceof HttpException) return exception.getResponse();
    return {
      statusCode: status,
      message: GENERIC_MESSAGE,
      error: 'Internal Server Error',
    };
  }

  /**
   * Texto do toast. O ValidationPipe devolve `message` como lista de falhas —
   * todas entram, para o usuário não corrigir uma por vez.
   */
  private messageOf(exception: unknown, status: number): string {
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return GENERIC_MESSAGE;
    if (!(exception instanceof HttpException)) return GENERIC_MESSAGE;

    const byStatus = BY_STATUS[status];
    if (byStatus) return byStatus;

    const body = exception.getResponse();
    if (typeof body === 'string') return body;

    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      const parts = message.filter((m): m is string => typeof m === 'string');
      if (parts.length > 0) return parts.join(' · ');
    }
    return exception.message || GENERIC_MESSAGE;
  }

  /**
   * Volta para a página do formulário, e não para uma rota fixa: é lá que o
   * usuário relê o que digitou.
   *
   * O `Referer` vem do cliente e é tratado como tal: precisa ser uma URL
   * absoluta do mesmo host — é o que a especificação manda o navegador enviar —
   * e só o caminho é aproveitado. Qualquer outra coisa cai na rota padrão, para
   * que um erro não vire redirecionamento aberto para fora do app.
   */
  private backTo(req: Request): string {
    const referer = req.get('referer');
    if (!referer) return FALLBACK_ROUTE;

    try {
      const { pathname, search, host } = new URL(referer);
      if (host !== req.headers.host) return FALLBACK_ROUTE;
      return `${pathname}${search}`;
    } catch {
      return FALLBACK_ROUTE;
    }
  }
}
