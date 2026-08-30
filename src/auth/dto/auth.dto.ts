import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsString, MaxLength, MinLength, Equals, IsOptional } from 'class-validator';

/**
 * Checkbox de formulário HTML chega como string ("true" pelo atributo value,
 * "on" quando ele é omitido) — e não chega de forma alguma se desmarcado.
 */
const comoBooleano = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === 'on' ? true : value;

export class RegisterDto {
  @IsEmail() @MaxLength(180)
  email!: string;

  @IsString() @MinLength(8) @MaxLength(72) // bcrypt trunca acima de 72 bytes
  password!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(64)
  timezone?: string;

  /**
   * Consentimento específico e destacado para tratamento de dado sensível de
   * saúde (LGPD, Art. 11, I — ADR-001 §2.4). Sem ele não há base legal.
   */
  @Transform(comoBooleano)
  @IsBoolean() @Equals(true, { message: 'o consentimento é obrigatório' })
  consent!: boolean;
}

export class LoginDto {
  @IsEmail() @MaxLength(180)
  email!: string;

  @IsString() @MaxLength(72)
  password!: string;
}
