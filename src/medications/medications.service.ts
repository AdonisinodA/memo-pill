import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { Clock } from '../common/time/clock';
import { DoseLog } from '../doses/dose-log.entity';
import { DoseStatus } from '../doses/dose-status.enum';
import { Posologia, fimDoHorizonte, gerarInstantes } from '../doses/dose-schedule';
import { Medication } from './medication.entity';
import { AtualizarMedicamentoDto, CriarMedicamentoDto } from './dto/medicamento.dto';

@Injectable()
export class MedicationsService {
  constructor(
    @InjectRepository(Medication) private readonly medicamentos: Repository<Medication>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly clock: Clock,
  ) {}

  listar(userId: string): Promise<Medication[]> {
    return this.medicamentos.find({
      where: { userId, deletedAt: IsNull() },
      order: { nome: 'ASC' },
    });
  }

  /**
   * Cria o medicamento e materializa as doses do horizonte na mesma transação
   * (ADR-001 §2.2). Medicamento sem doses seria um lembrete que nunca dispara.
   */
  async criar(
    userId: string,
    timezone: string,
    dto: CriarMedicamentoDto,
  ): Promise<Medication> {
    return this.dataSource.transaction(async (manager) => {
      const medicamento = await manager.save(
        manager.create(Medication, {
          userId,
          nome: dto.nome,
          dosagem: dto.dosagem,
          horarios: dto.horarios,
          inicioEm: dto.inicioEm,
          fimEm: dto.fimEm ?? null,
          deletedAt: null,
        }),
      );
      await this.materializar(manager, medicamento, timezone, this.clock.nowSeconds());
      return medicamento;
    });
  }

  /**
   * Soft delete (ADR-001 §2.2): o histórico analítico de doses já tomadas
   * permanece acessível; apenas as doses futuras ainda pendentes são canceladas.
   */
  async remover(userId: string, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const medicamento = await this.exigir(manager, userId, id);
      const agora = this.clock.nowSeconds();
      medicamento.deletedAt = agora;
      await manager.save(medicamento);
      await this.cancelarFuturas(manager, medicamento.id, agora);
    });
  }

  /**
   * Altera a posologia. As doses futuras já materializadas ficam obsoletas,
   * então são canceladas e regeradas — mesma mecânica da exclusão.
   */
  async atualizar(
    userId: string,
    timezone: string,
    id: string,
    dto: AtualizarMedicamentoDto,
  ): Promise<Medication> {
    return this.dataSource.transaction(async (manager) => {
      const medicamento = await this.exigir(manager, userId, id);
      const agora = this.clock.nowSeconds();

      Object.assign(medicamento, {
        nome: dto.nome,
        dosagem: dto.dosagem,
        horarios: dto.horarios,
        inicioEm: dto.inicioEm,
        fimEm: dto.fimEm ?? null,
      });
      await manager.save(medicamento);

      await this.cancelarFuturas(manager, medicamento.id, agora);
      await this.materializar(manager, medicamento, timezone, agora);
      return medicamento;
    });
  }

  /**
   * Job diário: empurra o horizonte dos tratamentos contínuos para frente.
   * A folga de 90 dias garante que uma falha prolongada deste job não
   * interrompa os lembretes.
   *
   * @returns quantas doses foram criadas.
   */
  async estenderHorizonte(): Promise<number> {
    const agora = this.clock.nowSeconds();
    const ativos = await this.medicamentos.find({
      where: { deletedAt: IsNull() },
      relations: { user: true },
    });

    let criadas = 0;
    for (const medicamento of ativos) {
      const timezone = medicamento.user?.timezone ?? 'UTC';
      criadas += await this.dataSource.transaction((manager) =>
        this.materializar(manager, medicamento, timezone, agora),
      );
    }
    return criadas;
  }

  /**
   * Gera as doses que ainda faltam entre a última já materializada e o fim do
   * horizonte. Idempotente: chamada duas vezes seguidas, a segunda não cria nada.
   *
   * @returns quantas doses foram criadas.
   */
  private async materializar(
    manager: EntityManager,
    medicamento: Medication,
    timezone: string,
    agora: number,
  ): Promise<number> {
    const posologia: Posologia = {
      horarios: medicamento.horarios,
      inicioEm: medicamento.inicioEm,
      fimEm: medicamento.fimEm,
      timezone,
    };

    const { ultima } = (await manager
      .createQueryBuilder(DoseLog, 'd')
      .select('MAX(d.scheduled_for)', 'ultima')
      .where('d.medication_id = :id', { id: medicamento.id })
      .andWhere('d.status != :cancelada', { cancelada: DoseStatus.CANCELED })
      .getRawOne<{ ultima: number | null }>()) ?? { ultima: null };

    const desde = Math.max(agora, ultima ?? 0);
    const instantes = gerarInstantes(posologia, {
      desde,
      ate: fimDoHorizonte(posologia, agora),
    });
    if (instantes.length === 0) return 0;

    await manager.insert(
      DoseLog,
      instantes.map((scheduledFor) => ({
        medicationId: medicamento.id,
        scheduledFor,
        status: DoseStatus.PENDING,
        notifiedAt: null,
        respondedAt: null,
      })),
    );
    return instantes.length;
  }

  /** Cancela apenas doses futuras ainda pendentes; o passado é histórico. */
  private async cancelarFuturas(
    manager: EntityManager,
    medicationId: string,
    agora: number,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(DoseLog)
      .set({ status: DoseStatus.CANCELED })
      .where('medication_id = :medicationId', { medicationId })
      .andWhere('status = :pendente', { pendente: DoseStatus.PENDING })
      .andWhere('scheduled_for > :agora', { agora })
      .execute();
  }

  private async exigir(
    manager: EntityManager,
    userId: string,
    id: string,
  ): Promise<Medication> {
    const medicamento = await manager.findOne(Medication, {
      where: { id, userId, deletedAt: IsNull() },
    });
    if (!medicamento) throw new NotFoundException('Medicamento não encontrado');
    return medicamento;
  }
}
