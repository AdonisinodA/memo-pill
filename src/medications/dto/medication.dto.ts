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

export class CreateMedicationDto {
  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  dosage!: string;

  @Transform(withoutBlanks)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    each: true,
    message: 'cada horário deve estar no formato HH:mm',
  })
  times!: string[];

  @IsISO8601({ strict: true })
  startsOn!: string;

  @Transform(blankToNull)
  @IsOptional() @IsISO8601({ strict: true })
  endsOn?: string | null;
}

export class UpdateMedicationDto extends CreateMedicationDto {}
