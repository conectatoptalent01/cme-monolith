import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS restringido.
 *
 * El navegador NO llama al backend directamente: todas las llamadas pasan por las rutas
 * /api del frontend (Next.js), que hablan con el backend de servidor a servidor, donde
 * CORS no aplica. Por eso, por defecto no se permite ningún origen externo.
 *
 * Si en el futuro una web o app móvil llama al backend desde el navegador, se agrega su
 * dominio en la variable CORS_ORIGINS, separado por comas:
 *   CORS_ORIGINS=https://app.conectame.com,https://www.conectame.com
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function buildCorsOptions(raw: string | undefined = process.env.CORS_ORIGINS): CorsOptions {
  const allowed = new Set(parseCorsOrigins(raw));
  return {
    credentials: true,
    origin: (origin, cb) => {
      // sin cabecera Origin = llamada de servidor a servidor (frontend Next.js, webhooks): se permite
      if (!origin) return cb(null, true);
      cb(null, allowed.has(origin.replace(/\/+$/, '')));
    },
  };
}
