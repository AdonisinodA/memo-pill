import {
  CallHandler, ExecutionContext, Injectable, NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * Impede que qualquer resposta da aplicação fique guardada no navegador.
 *
 * Sem isto, o botão Voltar depois do "Sair" reexibe o dashboard a partir do
 * cache — com nome de medicamento, dosagem e horários na tela, já sem sessão
 * nenhuma para autorizar aquilo. `no-store` é o único valor que impede também
 * o cache de histórico; `no-cache` apenas obriga a revalidar.
 *
 * Vale só para as rotas do Nest: CSS, ícones e JS são servidos antes, pelo
 * `useStaticAssets`, e seguem cacheáveis — não carregam dado de ninguém.
 */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store, private');
    return next.handle();
  }
}
