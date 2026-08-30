import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { MedicationsController } from './medications.controller';
import { MedicationsService } from './medications.service';
import { Medication } from './medication.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Medication]), AuthModule],
  controllers: [MedicationsController],
  providers: [MedicationsService],
  exports: [MedicationsService],
})
export class MedicationsModule {}
