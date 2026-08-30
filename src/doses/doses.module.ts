import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { MedicationsModule } from '../medications/medications.module';
import { PushModule } from '../push/push.module';
import { DoseLog } from './dose-log.entity';
import { DoseSchedulerService } from './dose-scheduler.service';
import { DosesController } from './doses.controller';
import { DosesService } from './doses.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DoseLog]),
    AuthModule,
    PushModule,
    MedicationsModule,
  ],
  controllers: [DosesController],
  providers: [DosesService, DoseSchedulerService],
  exports: [DosesService],
})
export class DosesModule {}
