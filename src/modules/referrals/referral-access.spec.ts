/// <reference types="jest" />
import { ForbiddenException } from '@nestjs/common';
import { ReferralsController } from './referral-service.controller';

/**
 * Reglas de quién puede cambiar un referido.
 * Escenario: vacante de la empresa C (admin = "empresa"), referido creado por "referidor".
 */
function setup(ref: { candidate_id: string | null } = { candidate_id: null }) {
  const ctx = {
    id: 'r1', headhunter_id: 'referidor', candidate_id: ref.candidate_id,
    job_offer_id: 'j1', company_id: 'C', status: 'submitted',
  };
  const access: any = {
    userId: (u: any) => u.id,
    isAdmin: async (u: any) => u.id === 'admin',
    isCompanyAdmin: async (u: any, companyId: string) => u.id === 'empresa' && companyId === 'C',
    assertSelfOrAdmin: async (u: any, target: string) => {
      if (u.id !== target && u.id !== 'admin') throw new ForbiddenException();
    },
    referralContext: async () => ctx,
  };
  const service: any = {
    create: jest.fn(async () => ({})),
    update: jest.fn(async () => ({})),
    updateStatus: jest.fn(async () => ({})),
    remove: jest.fn(async () => ({})),
  };
  return { controller: new ReferralsController(service, access), service };
}

const u = (id: string) => ({ id });

describe('Referidos: permisos', () => {
  it('nadie crea referidos a nombre de otro', async () => {
    const { controller } = setup();
    await expect(controller.create(u('intruso'), { headhunterId: 'referidor' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.create(u('referidor'), { headhunterId: 'referidor' } as any)).resolves.toBeDefined();
  });

  it('un candidato puede canjear un referido libre a su nombre y aceptarlo', async () => {
    const { controller, service } = setup({ candidate_id: null });
    await controller.update(u('cand'), 'r1', { candidateId: 'cand', status: 'accepted_by_candidate' } as any);
    expect(service.update).toHaveBeenCalled();
  });

  it('no se puede asignar a otra persona como candidato', async () => {
    const { controller } = setup({ candidate_id: null });
    await expect(controller.update(u('cand'), 'r1', { candidateId: 'otro' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no se puede robar un referido ya tomado por otro candidato', async () => {
    const { controller } = setup({ candidate_id: 'cand' });
    await expect(controller.update(u('otro'), 'r1', { candidateId: 'otro' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el candidato no puede marcarse como contratado', async () => {
    const { controller } = setup({ candidate_id: 'cand' });
    await expect(controller.updateStatus(u('cand'), 'r1', { status: 'hired' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('la empresa dueña de la vacante sí cambia el estado; otra persona no', async () => {
    const { controller, service } = setup({ candidate_id: 'cand' });
    await controller.updateStatus(u('empresa'), 'r1', { status: 'shortlist' } as any);
    expect(service.updateStatus).toHaveBeenCalledWith('r1', 'shortlist');
    await expect(controller.updateStatus(u('referidor'), 'r1', { status: 'shortlist' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('la empresa no puede aceptar en nombre del candidato', async () => {
    const { controller } = setup({ candidate_id: 'cand' });
    await expect(controller.updateStatus(u('empresa'), 'r1', { status: 'accepted_by_candidate' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('solo quien creó el referido lo borra', async () => {
    const { controller } = setup();
    await expect(controller.remove(u('empresa'), 'r1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.remove(u('referidor'), 'r1')).resolves.toBeDefined();
  });
});
