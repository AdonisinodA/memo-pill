import { Global, Module } from '@nestjs/common';
import { CsrfService } from './csrf/csrf.service';
import { Clock, SystemClock } from './time/clock';

@Global()
@Module({
  providers: [
    CsrfService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [CsrfService, Clock],
})
export class CommonModule {}
