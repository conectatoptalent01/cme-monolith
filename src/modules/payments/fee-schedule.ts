/**
 * Tarifas por contratación según la presentación "Plataforma CME – Diseño conceptual" (junio 2025).
 *
 *   Posición hasta US$1,000.00            → fee US$150
 *   US$1,000.01 a US$2,500.00             → fee US$250
 *   US$2,500.01 a US$3,500.00             → fee US$375
 *   US$3,500.01 a US$5,000.00             → fee US$500
 *   Desde US$5,000.01                     → 12% del monto contratado
 *
 * El reclutador recibe el 10% del monto facturado a la empresa.
 *
 * PENDIENTE (decisión de negocio): qué es exactamente el "monto de la posición"
 * (hoy se usa job_offers.salary tal como lo publica la empresa).
 */

export const RECRUITER_SHARE = 0.10;

export interface HiringFee {
  /** Monto de la posición usado como base. */
  positionAmount: number;
  /** Fee que paga la empresa, redondeado a centavos. */
  fee: number;
  /** Parte del reclutador, redondeada a centavos. */
  recruiterPayout: number;
  /** Descripción legible del tramo aplicado. */
  tier: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function calculateHiringFee(positionAmount: number, recruiterShare = RECRUITER_SHARE): HiringFee {
  if (!Number.isFinite(positionAmount) || positionAmount <= 0) {
    throw new Error('position_amount_must_be_positive');
  }
  const amount = round2(positionAmount);

  let fee: number;
  let tier: string;
  if (amount <= 1000) {
    fee = 150; tier = 'hasta US$1,000';
  } else if (amount <= 2500) {
    fee = 250; tier = 'US$1,001 a US$2,500';
  } else if (amount <= 3500) {
    fee = 375; tier = 'US$2,501 a US$3,500';
  } else if (amount <= 5000) {
    fee = 500; tier = 'US$3,501 a US$5,000';
  } else {
    fee = round2(amount * 0.12); tier = 'desde US$5,001 (12%)';
  }

  return { positionAmount: amount, fee, recruiterPayout: round2(fee * recruiterShare), tier };
}
