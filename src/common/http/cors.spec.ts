/// <reference types="jest" />
import { buildCorsOptions, parseCorsOrigins } from './cors';

const decide = (raw: string | undefined, origin: string | undefined) =>
  new Promise<boolean>((resolve) => {
    (buildCorsOptions(raw).origin as any)(origin, (_e: any, ok: boolean) => resolve(ok));
  });

describe('CORS', () => {
  it('lee la lista de orígenes separada por comas', () => {
    expect(parseCorsOrigins(' https://a.com/ , https://b.com,, ')).toEqual(['https://a.com', 'https://b.com']);
  });

  it('sin CORS_ORIGINS no permite ningún sitio web externo', async () => {
    expect(await decide(undefined, 'https://sitio-malicioso.com')).toBe(false);
  });

  it('permite solo los orígenes configurados', async () => {
    expect(await decide('https://app.cme.com', 'https://app.cme.com')).toBe(true);
    expect(await decide('https://app.cme.com', 'https://otro.com')).toBe(false);
  });

  it('las llamadas de servidor a servidor (sin Origin) siguen funcionando', async () => {
    expect(await decide(undefined, undefined)).toBe(true);
  });
});
