import {
  ArgumentsHost, Catch, ExceptionFilter, UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Numa navegação de página, sessão ausente deve levar ao login — não a um 401
 * cru. Chamadas de API seguem recebendo 401 para o cliente tratar.
 */
@Catch(UnauthorizedException)
export class UnauthenticatedFilter implements ExceptionFilter {
  catch(exception: UnauthorizedException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const isNavigation = req.method === 'GET' && req.accepts(['html', 'json']) === 'html';
    if (isNavigation) {
      res.redirect('/login');
      return;
    }
    res.status(401).json(exception.getResponse());
  }
}
