import { IsUUID, IsOptional } from 'class-validator';

/**
 * Solo se necesita el referido. El monto, la moneda y el % del reclutador los calcula el servidor.
 * Los campos amount / currency / referralPercent se aceptan por compatibilidad pero se IGNORAN.
 */
export class StartReferralCheckoutDto {
  @IsUUID()
  referralId!: string;

  @IsOptional() amount?: unknown;
  @IsOptional() currency?: unknown;
  @IsOptional() referralPercent?: unknown;
}
