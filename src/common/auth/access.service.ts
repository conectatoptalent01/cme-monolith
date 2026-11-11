import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/pg.constants';

/**
 * Reglas de acceso por dueño y por rol.
 *
 * El rol se lee SIEMPRE de public.profiles (lo escribe solo el backend).
 * Nunca de user_metadata, porque el usuario puede modificar su propio metadata en Supabase.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /* ------------------------- Identidad y rol ------------------------- */

  userId(user: any): string {
    const id = user?.id;
    if (!id) throw new ForbiddenException('auth_required');
    return String(id);
  }

  async roleOf(user: any): Promise<string | null> {
    if (!user?.id) return null;
    if (user.__dbRole !== undefined) return user.__dbRole;
    const { rows } = await this.pool.query(
      `SELECT role FROM public.profiles WHERE id = $1 LIMIT 1`,
      [user.id],
    );
    const role = rows?.[0]?.role ?? null;
    // cache por request (el objeto user vive solo durante la petición)
    user.__dbRole = role;
    return role;
  }

  async isAdmin(user: any): Promise<boolean> {
    return (await this.roleOf(user)) === 'admin';
  }

  async assertAdmin(user: any): Promise<void> {
    if (!(await this.isAdmin(user))) throw new ForbiddenException('admin_only');
  }

  /** Lanza 403 si el usuario no es él mismo (o admin). */
  async assertSelfOrAdmin(user: any, targetUserId: string | null | undefined): Promise<void> {
    if (targetUserId && this.userId(user) === String(targetUserId)) return;
    if (await this.isAdmin(user)) return;
    throw new ForbiddenException('not_allowed_for_other_user');
  }

  /* ----------------------------- Empresas ---------------------------- */

  async companyIdsAdministeredBy(userId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT id FROM public.companies WHERE admin_id = $1`,
      [userId],
    );
    return rows.map((r: any) => String(r.id));
  }

  async isCompanyAdmin(user: any, companyId: string | null | undefined): Promise<boolean> {
    if (!companyId) return false;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM public.companies WHERE id = $1 AND admin_id = $2 LIMIT 1`,
      [companyId, this.userId(user)],
    );
    return rows.length > 0;
  }

  async assertCompanyAdmin(user: any, companyId: string | null | undefined): Promise<void> {
    if (await this.isCompanyAdmin(user, companyId)) return;
    if (await this.isAdmin(user)) return;
    throw new ForbiddenException('not_company_admin');
  }

  /* ----------------------------- Vacantes ---------------------------- */

  async companyOfJob(jobId: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT company_id FROM public.job_offers WHERE id = $1 LIMIT 1`,
      [jobId],
    );
    if (!rows[0]) throw new NotFoundException('job_offer_not_found');
    return String(rows[0].company_id);
  }

  async assertJobOwner(user: any, jobId: string): Promise<void> {
    await this.assertCompanyAdmin(user, await this.companyOfJob(jobId));
  }

  /* ---------------------------- Referidos ---------------------------- */

  async referralContext(referralId: string): Promise<{
    id: string;
    headhunter_id: string | null;
    candidate_id: string | null;
    job_offer_id: string;
    company_id: string;
    status: string;
  }> {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.headhunter_id, r.candidate_id, r.job_offer_id, r.status, j.company_id
         FROM public.referrals r
         JOIN public.job_offers j ON j.id = r.job_offer_id
        WHERE r.id = $1
        LIMIT 1`,
      [referralId],
    );
    if (!rows[0]) throw new NotFoundException('referral_not_found');
    return rows[0];
  }

  /* --------------------------- Postulaciones ------------------------- */

  async applicationContext(applicationId: string): Promise<{
    id: string;
    candidate_id: string;
    job_offer_id: string;
    company_id: string;
  }> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.candidate_id, a.job_offer_id, j.company_id
         FROM public.applications a
         JOIN public.job_offers j ON j.id = a.job_offer_id
        WHERE a.id = $1
        LIMIT 1`,
      [applicationId],
    );
    if (!rows[0]) throw new NotFoundException('application_not_found');
    return rows[0];
  }

  /* ------------------------------ Pagos ------------------------------ */

  async assertPaymentParty(user: any, payment: { company_id?: string | null; headhunter_id?: string | null }) {
    const me = this.userId(user);
    if (payment.headhunter_id && String(payment.headhunter_id) === me) return;
    if (await this.isCompanyAdmin(user, payment.company_id ?? null)) return;
    if (await this.isAdmin(user)) return;
    throw new ForbiddenException('not_payment_party');
  }

  /* --------------------------- Notificaciones ------------------------ */

  async notificationOwner(notificationId: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT user_id FROM public.notifications WHERE id = $1 LIMIT 1`,
      [notificationId],
    );
    if (!rows[0]) throw new NotFoundException('notification_not_found');
    return String(rows[0].user_id);
  }
}
