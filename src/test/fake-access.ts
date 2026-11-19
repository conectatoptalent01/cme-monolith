/// <reference types="jest" />
import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Mundo de prueba compartido por las pruebas de permisos.
 *
 *  - "admin":        administrador de CME
 *  - "empresa":      administra la empresa C (dueña de la vacante j1)
 *  - "otraEmpresa":  administra la empresa D
 *  - "cand":         candidato con la postulación a1 a j1 y la notificación n1
 *  - "referidor":    referidor que recibe la comisión del pago p1
 */
export const WORLD = {
  companies: { C: 'empresa', D: 'otraEmpresa' } as Record<string, string>,
  jobs: { j1: 'C' } as Record<string, string>,
  applications: { a1: { id: 'a1', candidate_id: 'cand', job_offer_id: 'j1', company_id: 'C' } } as Record<string, any>,
  notifications: { n1: 'cand' } as Record<string, string>,
};

export const user = (id: string) => ({ id });

export function fakeAccess(): any {
  const isAdmin = async (u: any) => u?.id === 'admin';
  const isCompanyAdmin = async (u: any, companyId: string | null | undefined) =>
    !!companyId && WORLD.companies[companyId] === u?.id;
  const deny = (msg = 'forbidden') => { throw new ForbiddenException(msg); };

  return {
    userId: (u: any) => u?.id ?? deny('auth_required'),
    isAdmin,
    assertAdmin: async (u: any) => { if (!(await isAdmin(u))) deny('admin_only'); },
    assertSelfOrAdmin: async (u: any, target: string) => {
      if (u?.id !== target && !(await isAdmin(u))) deny('not_allowed_for_other_user');
    },
    isCompanyAdmin,
    assertCompanyAdmin: async (u: any, companyId: string) => {
      if (!(await isCompanyAdmin(u, companyId)) && !(await isAdmin(u))) deny('not_company_admin');
    },
    companyOfJob: async (jobId: string) => {
      const c = WORLD.jobs[jobId];
      if (!c) throw new NotFoundException('job_offer_not_found');
      return c;
    },
    assertJobOwner: async function (this: any, u: any, jobId: string) {
      const c = WORLD.jobs[jobId];
      if (!c) throw new NotFoundException('job_offer_not_found');
      if (!(await isCompanyAdmin(u, c)) && !(await isAdmin(u))) deny('not_company_admin');
    },
    applicationContext: async (id: string) => {
      const a = WORLD.applications[id];
      if (!a) throw new NotFoundException('application_not_found');
      return a;
    },
    assertPaymentParty: async (u: any, p: any) => {
      if (p.headhunter_id === u?.id) return;
      if (await isCompanyAdmin(u, p.company_id)) return;
      if (await isAdmin(u)) return;
      deny('not_payment_party');
    },
    notificationOwner: async (id: string) => {
      const o = WORLD.notifications[id];
      if (!o) throw new NotFoundException('notification_not_found');
      return o;
    },
    referralContext: async (id: string) => ({
      id, headhunter_id: 'referidor', candidate_id: 'cand', job_offer_id: 'j1', company_id: 'C', status: 'submitted',
    }),
  };
}

/** Servicio falso: cada método devuelve {ok:true} y registra la llamada. */
export function fakeService(extra: Record<string, any> = {}): any {
  return new Proxy(extra, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      target[prop] = jest.fn(async () => ({ ok: true }));
      return target[prop];
    },
  });
}
