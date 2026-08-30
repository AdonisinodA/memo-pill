import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Render, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CreateMedicationDto } from './dto/medication.dto';
import { MedicationsService } from './medications.service';

@Controller('medicamentos')
@UseGuards(SessionGuard)
export class MedicationsController {
  constructor(private readonly medications: MedicationsService) {}

  @Get()
  @Render('medications')
  async list(@Req() req: Request) {
    return {
      title: 'Medicamentos',
      csrfToken: req.csrfToken,
      medications: await this.medications.list(req.user!.id),
    };
  }

  @Get('novo')
  @Render('medication-new')
  newForm(@Req() req: Request) {
    return { title: 'Adicionar remédio', csrfToken: req.csrfToken };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateMedicationDto,
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user!;
    await this.medications.create(user.id, user.timezone, dto);
    res.redirect(303, '/doses/hoje');
  }

  @Post(':id/remover')
  async remove(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.medications.remove(req.user!.id, id);
    res.redirect(303, '/medicamentos');
  }
}
