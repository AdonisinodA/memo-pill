import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsISO8601, IsOptional,
  IsString, Matches, MaxLength, MinLength,
} from 'class-validator';

/** O formulário envia um campo por horário; os não preenchidos vêm vazios. */
const semVazios = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.filter((v) => typeof v === 'string' && v.trim() !== '')
    : value;

/** `<input type="date">` não preenchido chega como string vazia, não ausente. */
const vazioParaNulo = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

export class CriarMedicamentoDto {
  @IsString() @MinLength(2) @MaxLength(120)
  nome!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  dosagem!: string;

  @Transform(semVazios)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    each: true,
    message: 'cada horário deve estar no formato HH:mm',
  })
  horarios!: string[];

  @IsISO8601({ strict: true })
  inicioEm!: string;

  @Transform(vazioParaNulo)
  @IsOptional() @IsISO8601({ strict: true })
  fimEm?: string | null;
}

export class AtualizarMedicamentoDto extends CriarMedicamentoDto {}
