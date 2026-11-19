/// <reference types="jest" />
import { ForbiddenException } from '@nestjs/common';
import { fakeAccess, fakeService, user } from './fake-access';
import { CompaniesController } from '../modules/companies/company-service.controller';
import { JobServiceController } from '../modules/jobs/job-service.controller';
import { ApplicationsController } from '../modules/applications/application-service.controller';
import { PaymentServiceController } from '../modules/payments/payment-service.controller';
import { NotificationsController } from '../modules/notifications/notification-service.controller';

const forbidden = (p: Promise<any>) => expect(p).rejects.toBeInstanceOf(ForbiddenException);

/* ------------------------------------------------------------------ */
describe('Flujo: registro de empresa', () => {
  it('la empresa queda a nombre de quien la crea, aunque envíe otro adminId', async () => {
    const svc = fakeService();
    const ctrl = new CompaniesController(svc, fakeAccess());
    await ctrl.create(user('empresa'), { name: 'ACME', adminId: 'otro' } as any);
    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ adminId: 'empresa' }));
  });

  it('una empresa no puede marcarse como verificada ni cambiarse el plan sola', async () => {
    const svc = fakeService();
    const ctrl = new CompaniesController(svc, fakeAccess());
    await ctrl.update(user('empresa'), 'C', { description: 'x', boolVerified: true, subscriptionPlan: 'pro' } as any);
    const patch = svc.update.mock.calls[0][1];
    expect(patch).toEqual({ description: 'x' });
  });

  it('nadie edita ni borra la empresa de otro', async () => {
    const ctrl = new CompaniesController(fakeService(), fakeAccess());
    await forbidden(ctrl.update(user('otraEmpresa'), 'C', { description: 'x' } as any));
    await forbidden(ctrl.remove(user('cand'), 'C'));
  });
});

/* ------------------------------------------------------------------ */
describe('Flujo: publicar vacante', () => {
  it('el administrador de la empresa publica, edita y borra sus vacantes', async () => {
    const svc = fakeService();
    const ctrl = new JobServiceController(svc, fakeAccess());
    await ctrl.create(user('empresa'), { companyId: 'C', title: 'Dev' } as any);
    await ctrl.update(user('empresa'), 'j1', { title: 'Dev Sr' } as any);
    await ctrl.remove(user('empresa'), 'j1');
    expect(svc.create).toHaveBeenCalled();
    expect(svc.update).toHaveBeenCalled();
    expect(svc.remove).toHaveBeenCalled();
  });

  it('nadie publica a nombre de otra empresa', async () => {
    const ctrl = new JobServiceController(fakeService(), fakeAccess());
    await forbidden(ctrl.create(user('otraEmpresa'), { companyId: 'C' } as any));
    await forbidden(ctrl.create(user('cand'), { companyId: 'C' } as any));
  });

  it('nadie edita o borra la vacante de otra empresa ni la mueve a una empresa ajena', async () => {
    const ctrl = new JobServiceController(fakeService(), fakeAccess());
    await forbidden(ctrl.update(user('otraEmpresa'), 'j1', { title: 'x' } as any));
    await forbidden(ctrl.remove(user('cand'), 'j1'));
    await forbidden(ctrl.update(user('empresa'), 'j1', { companyId: 'D' } as any));
  });
});

/* ------------------------------------------------------------------ */
describe('Flujo: postular', () => {
  it('el candidato postula por sí mismo, no por otro', async () => {
    const svc = fakeService();
    const ctrl = new ApplicationsController(svc, fakeAccess());
    await ctrl.create(user('cand'), { candidateId: 'cand', jobOfferId: 'j1' } as any);
    expect(svc.create).toHaveBeenCalled();
    await forbidden(ctrl.create(user('cand'), { candidateId: 'otro', jobOfferId: 'j1' } as any));
  });

  it('solo la empresa dueña acepta una postulación; el candidato no se acepta solo', async () => {
    const svc = fakeService();
    const ctrl = new ApplicationsController(svc, fakeAccess());
    await ctrl.update(user('empresa'), 'a1', { accepted: true } as any);
    expect(svc.update).toHaveBeenCalledTimes(1);
    await forbidden(ctrl.update(user('cand'), 'a1', { accepted: true } as any));
    await forbidden(ctrl.update(user('otraEmpresa'), 'a1', { notes: 'x' } as any));
  });

  it('nadie lista las postulaciones de otro candidato, salvo la empresa dueña de la vacante', async () => {
    const svc = fakeService();
    const ctrl = new ApplicationsController(svc, fakeAccess());
    await forbidden(ctrl.list(user('otraEmpresa'), { candidateId: 'cand' } as any));
    await ctrl.list(user('empresa'), { candidateId: 'cand', jobOfferId: 'j1' } as any);
    await ctrl.list(user('cand'), { candidateId: 'cand' } as any);
    expect(svc.list).toHaveBeenCalledTimes(2);
  });

  it('ver o borrar una postulación: solo el candidato, la empresa dueña o un admin', async () => {
    const ctrl = new ApplicationsController(fakeService(), fakeAccess());
    await expect(ctrl.findOne(user('cand'), 'a1')).resolves.toBeDefined();
    await expect(ctrl.findOne(user('empresa'), 'a1')).resolves.toBeDefined();
    await forbidden(ctrl.findOne(user('otraEmpresa'), 'a1'));
    await forbidden(ctrl.remove(user('referidor'), 'a1'));
  });
});

/* ------------------------------------------------------------------ */
describe('Flujo: contratar y cobrar', () => {
  const payment = { id: 'p1', company_id: 'C', headhunter_id: 'referidor', amount: 250 };

  it('crear, editar o borrar pagos a mano: solo admin', async () => {
    const ctrl = new PaymentServiceController(fakeService(), fakeAccess());
    await forbidden(ctrl.create(user('empresa'), {} as any));
    await forbidden(ctrl.update(user('empresa'), 'p1', { status: 'succeeded' } as any));
    await forbidden(ctrl.remove(user('referidor'), 'p1'));
    await expect(ctrl.update(user('admin'), 'p1', {} as any)).resolves.toBeDefined();
  });

  it('el checkout lo inicia solo la empresa dueña de la vacante', async () => {
    const svc = fakeService();
    const ctrl = new PaymentServiceController(svc, fakeAccess());
    await ctrl.startReferralCheckout(user('empresa'), { referralId: 'r1' } as any);
    expect(svc.startReferralCheckout).toHaveBeenCalled();
    await forbidden(ctrl.startReferralCheckout(user('otraEmpresa'), { referralId: 'r1' } as any));
    await forbidden(ctrl.startReferralCheckout(user('referidor'), { referralId: 'r1' } as any));
  });

  it('un pago lo ven solo la empresa, el referidor que cobra y un admin', async () => {
    const svc = fakeService({ findOne: jest.fn(async () => payment) });
    const ctrl = new PaymentServiceController(svc, fakeAccess());
    await expect(ctrl.findOne(user('empresa'), 'p1')).resolves.toBe(payment);
    await expect(ctrl.findOne(user('referidor'), 'p1')).resolves.toBe(payment);
    await forbidden(ctrl.findOne(user('otraEmpresa'), 'p1'));
    await forbidden(ctrl.receipt(user('cand'), 'p1'));
  });

  it('nadie lista los pagos de otra empresa o de otro referidor', async () => {
    const ctrl = new PaymentServiceController(fakeService(), fakeAccess());
    await forbidden(ctrl.list({ companyId: 'C' } as any, user('otraEmpresa')));
    await forbidden(ctrl.list({ headhunterId: 'referidor' } as any, user('cand')));
  });
});

/* ------------------------------------------------------------------ */
describe('Notificaciones', () => {
  it('cada usuario lista solo las suyas, aunque pida las de otro', async () => {
    const svc = fakeService();
    const ctrl = new NotificationsController(svc, fakeAccess());
    await ctrl.list(user('cand'), { userId: 'otro' });
    expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cand' }));
  });

  it('nadie lee ni marca como leída la notificación de otro', async () => {
    const ctrl = new NotificationsController(fakeService(), fakeAccess());
    await forbidden(ctrl.findOne(user('empresa'), 'n1'));
    await forbidden(ctrl.markRead(user('empresa'), 'n1'));
    await expect(ctrl.markRead(user('cand'), 'n1')).resolves.toBeDefined();
  });

  it('reenviar por email: solo admin', async () => {
    const ctrl = new NotificationsController(fakeService(), fakeAccess());
    await forbidden(ctrl.dispatch(user('cand'), 'n1'));
  });
});
