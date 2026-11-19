/**
 * Normaliza teléfonos a formato E.164 (+<código país><número>), que es lo que pide WhatsApp.
 *
 *  "6123-4567"         → +50761234567   (sin código de país: se asume DEFAULT_COUNTRY_CODE, Panamá = 507)
 *  "+507 6123 4567"    → +50761234567
 *  "00 57 300 1234567" → +573001234567
 *  "573001234567"      → +573001234567  (ya trae código de país)
 */
export function normalizePhone(
  input: string | null | undefined,
  defaultCountryCode: string = process.env.DEFAULT_COUNTRY_CODE || '507',
): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);

  let e164: string;
  if (digits.startsWith('+')) {
    e164 = '+' + digits.slice(1).replace(/\D/g, '');
  } else {
    const only = digits.replace(/\D/g, '');
    // Número local (7 u 8 dígitos en Panamá): se antepone el código de país por defecto.
    e164 = only.length <= 8 ? `+${defaultCountryCode}${only}` : `+${only}`;
  }

  // E.164: entre 8 y 15 dígitos en total, sin empezar en 0.
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** "+50761234567" → "+507 ****4567" (para registros y pantallas). */
export function maskPhone(e164: string | null | undefined): string {
  const p = String(e164 ?? '');
  if (p.length < 6) return '****';
  const last4 = p.slice(-4);
  const cc = p.startsWith('+507') ? '+507' : p.slice(0, Math.min(4, p.length - 4));
  return `${cc} ****${last4}`;
}
