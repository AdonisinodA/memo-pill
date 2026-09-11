import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DateTime } from "luxon";
import {
	type DataSource,
	type EntityManager,
	IsNull,
	type Repository,
} from "typeorm";
// Import de VALOR, não `import type`: o Nest usa a classe como token de
// injeção em runtime, e `import type` a apagaria do JavaScript emitido.
import { Clock } from "../common/time/clock";
import { DoseLog } from "../doses/dose-log.entity";
import {
	horizonEnd,
	generateInstants,
	type Regimen,
} from "../doses/dose-schedule";
import { DoseStatus } from "../doses/dose-status.enum";
import type {
	UpdateMedicationDto,
	CreateMedicationDto,
} from "./dto/medication.dto";
import { Medication } from "./medication.entity";

/**
 * Situação do tratamento perante a data de hoje. Distingue o que já acabou do
 * que ainda vai começar — sem isso a lista mostra tudo como se estivesse
 * valendo, e o usuário não entende por que um remédio não gera dose.
 */
export type MedicationStatus = "SCHEDULED" | "ACTIVE" | "ENDED";

/** Modelo de view consumido por `views/medications.hbs`. */
export interface MedicationView {
	id: string;
	name: string;
	dosage: string;
	/** Horários locais "HH:mm", em ordem crescente. */
	times: string[];
	startsOn: string;
	/** Nulo = uso contínuo. */
	endsOn: string | null;
	status: MedicationStatus;
}

@Injectable()
export class MedicationsService {
	constructor(
    @InjectRepository(Medication) private readonly medications: Repository<Medication>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly clock: Clock,
  ) {}

	list(userId: string): Promise<Medication[]> {
		return this.medications.find({
			where: { userId, deletedAt: IsNull() },
			order: { name: "ASC" },
		});
	}

	/**
	 * Lista para a tela de remédios cadastrados. O status é derivado aqui, e não
	 * na view: depende da data de HOJE no fuso do usuário, que o Handlebars não
	 * tem como resolver.
	 */
	async listForView(
		userId: string,
		timezone: string,
	): Promise<MedicationView[]> {
		const today = DateTime.fromSeconds(this.clock.nowSeconds(), {
			zone: timezone,
		}).toISODate()!;

		const medications = await this.list(userId);
		return medications.map((m) => ({
			id: m.id,
			name: m.name,
			dosage: m.dosage,
			times: [...m.times].sort(),
			startsOn: m.startsOn,
			endsOn: m.endsOn,
			status: statusOn(m, today),
		}));
	}

	/**
	 * Cria o medicamento e materializa as doses do horizonte na mesma transação
	 * (ADR-001 §2.2). Medicamento sem doses seria um lembrete que nunca dispara.
	 */
	async create(
		userId: string,
		timezone: string,
		dto: CreateMedicationDto,
	): Promise<Medication> {
		return this.dataSource.transaction(async (manager) => {
			const medication = await manager.save(
				manager.create(Medication, {
					userId,
					name: dto.name,
					dosage: dto.dosage,
					times: dto.times,
					startsOn: dto.startsOn,
					endsOn: dto.endsOn ?? null,
					deletedAt: null,
				}),
			);
			await this.materialize(
				manager,
				medication,
				timezone,
				this.clock.nowSeconds(),
			);
			return medication;
		});
	}

	/**
	 * Soft delete (ADR-001 §2.2): o histórico analítico de doses já tomadas
	 * permanece acessível; apenas as doses futuras ainda pendentes são canceladas.
	 */
	async remove(userId: string, id: string): Promise<void> {
		await this.dataSource.transaction(async (manager) => {
			const medication = await this.requireOwned(manager, userId, id);
			const now = this.clock.nowSeconds();
			medication.deletedAt = now;
			await manager.save(medication);
			await this.cancelFuture(manager, medication.id, now);
		});
	}

	/**
	 * Altera a posologia. As doses futuras já materializadas ficam obsoletas,
	 * então são canceladas e regeradas — mesma mecânica da exclusão.
	 */
	async update(
		userId: string,
		timezone: string,
		id: string,
		dto: UpdateMedicationDto,
	): Promise<Medication> {
		return this.dataSource.transaction(async (manager) => {
			const medication = await this.requireOwned(manager, userId, id);
			const now = this.clock.nowSeconds();

			Object.assign(medication, {
				name: dto.name,
				dosage: dto.dosage,
				times: dto.times,
				startsOn: dto.startsOn,
				endsOn: dto.endsOn ?? null,
			});
			await manager.save(medication);

			await this.cancelFuture(manager, medication.id, now);
			await this.materialize(manager, medication, timezone, now);
			return medication;
		});
	}

	/**
	 * Job diário: empurra o horizonte dos tratamentos contínuos para frente.
	 * A folga de 90 dias garante que uma falha prolongada deste job não
	 * interrompa os lembretes.
	 *
	 * @returns quantas doses foram criadas.
	 */
	async extendHorizon(): Promise<number> {
		const now = this.clock.nowSeconds();
		const active = await this.medications.find({
			where: { deletedAt: IsNull() },
			relations: { user: true },
		});

		let created = 0;
		for (const medication of active) {
			const timezone = medication.user?.timezone ?? "UTC";
			created += await this.dataSource.transaction((manager) =>
				this.materialize(manager, medication, timezone, now),
			);
		}
		return created;
	}

	/**
	 * Gera as doses que ainda faltam entre a última já materializada e o fim do
	 * horizonte. Idempotente: chamada duas vezes seguidas, a segunda não cria nada.
	 *
	 * @returns quantas doses foram criadas.
	 */
	private async materialize(
		manager: EntityManager,
		medication: Medication,
		timezone: string,
		now: number,
	): Promise<number> {
		const regimen: Regimen = {
			times: medication.times,
			startsOn: medication.startsOn,
			endsOn: medication.endsOn,
			timezone,
		};

		const { last } = (await manager
			.createQueryBuilder(DoseLog, "d")
			.select("MAX(d.scheduled_for)", "last")
			.where("d.medication_id = :id", { id: medication.id })
			.andWhere("d.status != :canceled", { canceled: DoseStatus.CANCELED })
			.getRawOne<{ last: number | null }>()) ?? { last: null };

		const from = Math.max(now, last ?? 0);
		const instants = generateInstants(regimen, {
			from,
			to: horizonEnd(regimen, now),
		});
		if (instants.length === 0) return 0;

		await manager.insert(
			DoseLog,
			instants.map((scheduledFor) => ({
				medicationId: medication.id,
				scheduledFor,
				status: DoseStatus.PENDING,
				notifiedAt: null,
				respondedAt: null,
			})),
		);
		return instants.length;
	}

	/** Cancela apenas doses futuras ainda pendentes; o passado é histórico. */
	private async cancelFuture(
		manager: EntityManager,
		medicationId: string,
		now: number,
	): Promise<void> {
		await manager
			.createQueryBuilder()
			.update(DoseLog)
			.set({ status: DoseStatus.CANCELED })
			.where("medication_id = :medicationId", { medicationId })
			.andWhere("status = :pending", { pending: DoseStatus.PENDING })
			.andWhere("scheduled_for > :now", { now })
			.execute();
	}

	private async requireOwned(
		manager: EntityManager,
		userId: string,
		id: string,
	): Promise<Medication> {
		const medication = await manager.findOne(Medication, {
			where: { id, userId, deletedAt: IsNull() },
		});
		if (!medication) throw new NotFoundException("Medicamento não encontrado");
		return medication;
	}
}

/** Comparação lexicográfica: "YYYY-MM-DD" ordena igual à ordem cronológica. */
function statusOn(medication: Medication, today: string): MedicationStatus {
	if (medication.endsOn && medication.endsOn < today) return "ENDED";
	if (medication.startsOn > today) return "SCHEDULED";
	return "ACTIVE";
}
