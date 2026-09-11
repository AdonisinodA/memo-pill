import {
  Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Render, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { setFlash } from '../common/flash/flash';
import { CreateMedicationDto } from './dto/medication.dto';
import { MedicationsService } from './medications.service';

@Controller('medicamentos')
@UseGuards(SessionGuard)
export class MedicationsController {
  constructor(private readonly medications: MedicationsService) {}

  @Get()
  @Render('medications')
  async list(@Req() req: Request) {
    const user = req.user!;
    return {
      title: 'Meus remédios',
      csrfToken: req.csrfToken,
      medications: await this.medications.listForView(user.id, user.timezone),
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
    const medication = await this.medications.create(user.id, user.timezone, dto);
    setFlash(res, {
      type: 'success',
      message: `${medication.name} cadastrado. Os lembretes já estão agendados.`,
    });
    res.redirect(HttpStatus.SEE_OTHER, '/doses/hoje');
  }

  @Post(':id/remover')
  async remove(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.medications.remove(req.user!.id, id);
    setFlash(res, {
      type: 'success',
      message: 'Remédio removido. As doses futuras foram canceladas.',
    });
    res.redirect(HttpStatus.SEE_OTHER, '/medicamentos');
  }
}
