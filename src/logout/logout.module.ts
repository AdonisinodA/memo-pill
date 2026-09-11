import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PushModule } from '../push/push.module';
import { LogoutController } from './logout.controller';

/**
 * Módulo próprio porque sair cruza dois domínios: encerra a sessão (auth) e
 * desliga as notificações do aparelho (push).
 *
 * Pôr a rota no AuthModule obrigaria ele a importar o PushModule, que já
 * importa o AuthModule pelo SessionGuard — o ciclo que o `forwardRef` disfarça
 * em vez de resolver. Aqui a dependência é só de fora para dentro.
 */
@Module({
  imports: [AuthModule, PushModule],
  controllers: [LogoutController],
})
export class LogoutModule {}
