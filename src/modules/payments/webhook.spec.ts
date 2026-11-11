/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';

process.env.MP_ACCESS_TOKEN = 'TEST-token';
process.env.API_BASE_URL = 'https://api.example.com/api';

import { PaymentServiceService } from './payment-service.service';

/** Pool falso: responde según el texto del SQL y registra cada consulta. */
function fakePool(paymentRow: any) {
  const calls: string[] = [];
  const pool: any = {
    calls,
    query: jest.fn(async (sql: string) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM public\.payments WHERE id = \$1 AND direction/.test(sql)) return { rows: paymentRow ? [paymentRow] : [] };
      if (/FROM public\.referrals r/.test(sql)) {
        return { rows: [{ id: 'ref1', headhunter_id: 'hh', job_offer_id: 'j1', company_id: 'C', candidate_id: 'cand' }] };
      }
      if (/SELECT 1\s+FROM public\.payments/.test(sql)) return { rows: [] };
      return { rows: [] };
    }),
  };
  return pool;
}

function serviceWith(pool: any, mpPayment: any) {
  const svc = new PaymentServiceService(pool);
  (svc as any).payments = { get: jest.fn(async () => mpPayment) };
  return svc;
}

const approved = (over: any = {}) => ({
  id: 999, status: 'approved', transaction_amount: 250, currency_id: 'USD',
  metadata: { payment_id: 'p1', referral_id: 'ref1' }, ...over,
});

describe('Webhook de Mercado Pago', () => {
  it('lee el aviso desde el body (antes buscaba req.body sobre el body y nunca procesaba nada)', async () => {
    const pool = fakePool({ id: 'p1', amount: 250, status: 'pending' });
    const svc = serviceWith(pool, approved());
    await svc.handleMercadoPagoWebhook({ type: 'payment', data: { id: '999' } }, {}, 'p1');
    expect(pool.calls.some((s: string) => s.startsWith("UPDATE public.payments SET status = 'succeeded'"))).toBe(true);
    expect(pool.calls.some((s: string) => s.startsWith("UPDATE public.referrals SET status = 'hired'"))).toBe(true);
  });

  it('también acepta el aviso por query (?type=payment&data.id=…)', async () => {
    const pool = fakePool({ id: 'p1', amount: 250, status: 'pending' });
    const svc = serviceWith(pool, approved());
    await svc.handleMercadoPagoWebhook({}, { type: 'payment', 'data.id': '999' }, 'p1');
    expect(pool.calls.some((s: string) => s.startsWith("UPDATE public.payments SET status = 'succeeded'"))).toBe(true);
  });

  it('registra el 10% del fee para el reclutador', async () => {
    const pool = fakePool({ id: 'p1', amount: 250, status: 'pending' });
    const svc = serviceWith(pool, approved());
    await svc.handleMercadoPagoWebhook({ type: 'payment', data: { id: '999' } }, {}, 'p1');
    const insertCall = pool.query.mock.calls.find((c: any[]) => /INSERT INTO public\.payments/.test(c[0]));
    expect(insertCall[1][3]).toBe(25);
  });

  it('rechaza un pago de Mercado Pago que no corresponde a nuestro registro', async () => {
    const pool = fakePool({ id: 'p1', amount: 250, status: 'pending' });
    const svc = serviceWith(pool, approved({ metadata: { payment_id: 'OTRO' } }));
    await expect(svc.handleMercadoPagoWebhook({ type: 'payment', data: { id: '999' } }, {}, 'p1'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un pago por menos del monto adeudado', async () => {
    const pool = fakePool({ id: 'p1', amount: 250, status: 'pending' });
    const svc = serviceWith(pool, approved({ transaction_amount: 1 }));
    await expect(svc.handleMercadoPagoWebhook({ type: 'payment', data: { id: '999' } }, {}, 'p1'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('un aviso repetido no duplica nada', async () => {
    const pool = fakePool({ id: 'p1', amount: 250, status: 'succeeded' });
    const svc = serviceWith(pool, approved());
    const r = await svc.handleMercadoPagoWebhook({ type: 'payment', data: { id: '999' } }, {}, 'p1');
    expect(r).toEqual({ ok: true, alreadyProcessed: true });
    expect(pool.calls.some((s: string) => s.startsWith('UPDATE'))).toBe(false);
  });

  it('un pago no aprobado no cambia nada', async () => {
    const pool = fakePool({ id: 'p1', amount: 250, status: 'pending' });
    const svc = serviceWith(pool, approved({ status: 'pending' }));
    await svc.handleMercadoPagoWebhook({ type: 'payment', data: { id: '999' } }, {}, 'p1');
    expect(pool.calls.some((s: string) => s.startsWith('UPDATE'))).toBe(false);
  });
});
