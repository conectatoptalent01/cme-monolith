import { IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

/** Lo único que escribe quien refiere. El resto lo completa el candidato al registrarse. */
export class CreateInvitationDto {
  @IsUUID()
  jobOfferId!: string;

  @IsString() @Length(1, 80)
  firstName!: string;

  @IsString() @Length(1, 80)
  lastName!: string;

  /** Con o sin código de país. Sin código se asume Panamá (+507). */
  @IsString() @Length(7, 25)
  phone!: string;

  /** Opcional: por qué lo recomienda, en una o dos líneas. */
  @IsOptional() @IsString() @MaxLength(280)
  note?: string;
}
