import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Render, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessaoGuard } from '../auth/sessao.guard';
import { CriarMedicamentoDto } from './dto/medicamento.dto';
import { MedicationsService } from './medications.service';

@Controller('medicamentos')
@UseGuards(SessaoGuard)
export class MedicationsController {
  constructor(private readonly medicamentos: MedicationsService) {}

  @Get()
  @Render('medicamentos')
  async listar(@Req() req: Request) {
    return {
      title: 'Medicamentos',
      csrfToken: req.csrfToken,
      medicamentos: await this.medicamentos.listar(req.user!.id),
    };
  }

  @Get('novo')
  @Render('medicamento-novo')
  formulario(@Req() req: Request) {
    return { title: 'Adicionar remédio', csrfToken: req.csrfToken };
  }

  @Post()
  async criar(
    @Req() req: Request,
    @Body() dto: CriarMedicamentoDto,
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user!;
    await this.medicamentos.criar(user.id, user.timezone, dto);
    res.redirect(303, '/doses/hoje');
  }

  @Post(':id/remover')
  async remover(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.medicamentos.remover(req.user!.id, id);
    res.redirect(303, '/medicamentos');
  }
}
