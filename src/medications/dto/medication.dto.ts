import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsISO8601, IsOptional,
  IsString, Matches, MaxLength, MinLength,
} from 'class-validator';

/** O formulário envia um campo por horário; os não preenchidos vêm vazios. */
const withoutBlanks = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.filter((v) => typeof v === 'string' && v.trim() !== '')
    : value;

/** `<input type="date">` não preenchido chega como string vazia, não ausente. */
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

/**
 * As mensagens são escritas em português porque não param no log: o filtro
 * global de erro as devolve ao usuário dentro do toast da página.
 */
export class CreateMedicationDto {
  @IsString({ message: 'Informe o nome do remédio.' })
  @MinLength(2, { message: 'O nome precisa ter ao menos 2 caracteres.' })
  @MaxLength(120, { message: 'O nome pode ter no máximo 120 caracteres.' })
  name!: string;

  @IsString({ message: 'Informe a dosagem.' })
  @MinLength(1, { message: 'Informe a dosagem.' })
  @MaxLength(120, { message: 'A dosagem pode ter no máximo 120 caracteres.' })
  dosage!: string;

  @Transform(withoutBlanks)
  @IsArray({ message: 'Informe ao menos um horário.' })
  @ArrayMinSize(1, { message: 'Preencha ao menos um horário.' })
  @ArrayMaxSize(12, { message: 'São no máximo 12 horários por remédio.' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    each: true,
    message: 'Cada horário deve estar no formato HH:mm.',
  })
  times!: string[];

  @IsISO8601({ strict: true }, { message: 'Informe a data de início.' })
  startsOn!: string;

  @Transform(blankToNull)
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'A data de fim é inválida.' })
  endsOn?: string | null;
}

export class UpdateMedicationDto extends CreateMedicationDto {}
