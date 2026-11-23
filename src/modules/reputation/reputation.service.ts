import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/db/pg.constants';
import { insertSystemNotification } from '../../common/db/notify';

/** Estados en los que la empresa ya decidió sobre el candidato y puede calificar a quien lo recomendó. */
export const RATEABLE_REFERRAL_STATUSES = ['shortlist', 'rejected', 'hired'] as const;

/** Requisitos para solicitar ser Socio Reclutador (presentación CME: 15 referencias con 4+ estrellas). */
export function partnerRequirements() {
  const minRated = Number(process.env.PARTNER_MIN_RATED ?? 15);
  const minAvg = Number(process.env.PARTNER_MIN_AVG ?? 4);
  return {
    minRated: Number.isFinite(minRated) && minRated > 0 ? minRated : 15,
    minAvg: Number.isFinite(minAvg) && minAvg > 0 ? minAvg : 4,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function cleanComment(c: unknown): string | null {
  const s = typeof c === 'string' ? c.trim() : '';
  if (!s) return null;
  if (s.length > 500) throw new BadRequestException('comment_too_long');
  return s;
}

function assertStars(stars: unknown): number {
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new BadRequestException('stars_must_be_1_to_5');
  return n;
}

@Injectable()
export class ReputationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /* ================================================================ */
  /* Rating del referidor                                              */
  /* ================================================================ */

  /**
   * La empresa califica a quien recomendó al candidato. Se permite una calificación por referido
   * (se puede corregir) y solo cuando la empresa ya decidió: shortlist, rechazado o contratado.
   */
  async rateReferral(
    referralId: string,
    rater: { id: string; isAdmin: boolean },
    input: { stars: unknown; comment?: unknown },
  ) {
    const stars = assertStars(input.stars);
    const comment = cleanComment(input.comment);

    const { rows: [ref] } = await this.pool.query(
      `SELECT r.id, r.status, r.headhunter_id, r.candidate_id, j.company_id, j.title, c.admin_id
         FROM public.referrals r
         JOIN public.job_offers j ON j.id = r.job_offer_id
         JOIN public.companies c ON c.id = j.company_id
        WHERE r.id = $1`,
      [referralId],
    );
    if (!ref) throw new NotFoundException('referral_not_found');
    if (!rater.isAdmin && String(ref.admin_id) !== rater.id) throw new ForbiddenException('not_company_admin');
    if (!ref.headhunter_id) throw new BadRequestException('referral_without_referrer');
    if (!(RATEABLE_REFERRAL_STATUSES as readonly string[]).includes(ref.status)) {
      throw new BadRequestException('decide_on_candidate_before_rating');
    }

    const { rows: [rating] } = await this.pool.query(
      `INSERT INTO public.referral_ratings (referral_id, headhunter_id, company_id, rated_by, stars, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (referral_id) DO UPDATE
         SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, rated_by = EXCLUDED.rated_by, updated_at = now()
       RETURNING id, referral_id, stars, comment, created_at, updated_at, (xmax = 0) AS is_new`,
      [ref.id, ref.headhunter_id, ref.company_id, rater.id, stars, comment],
    );

    await this.refreshReferrerScore(ref.headhunter_id);

    if (rating.is_new) {
      await insertSystemNotification(this.pool, ref.headhunter_id, {
        title: `Recibiste ${stars} ${stars === 1 ? 'estrella' : 'estrellas'} por tu recomendación`,
        message: `La empresa calificó tu recomendación para "${ref.title}".`,
        relatedId: ref.id,
      });
    }

    const { is_new, ...out } = rating;
    return out;
  }

  private async refreshReferrerScore(headhunterId: string) {
    await this.pool.query(
      `UPDATE public.profiles
          SET reputation_score = (SELECT round(avg(stars)::numeric, 2) FROM public.referral_ratings WHERE headhunter_id = $1),
              updated_at = now()
        WHERE id = $1`,
      [headhunterId],
    );
  }

  /** Reputación de un referidor y si puede pedir ser Socio Reclutador. */
  async referrerSummary(userId: string) {
    const { rows: [p] } = await this.pool.query(
      `SELECT id, partner_status, partner_since FROM public.profiles WHERE id = $1`,
      [userId],
    );
    if (!p) throw new NotFoundException('profile_not_found');

    const { rows: [agg] } = await this.pool.query(
      `SELECT count(*)::int AS rated_count,
              coalesce(round(avg(stars)::numeric, 2), 0)::float AS avg_stars,
              count(*) FILTER (WHERE stars >= 4)::int AS four_plus_count
         FROM public.referral_ratings WHERE headhunter_id = $1`,
      [userId],
    );
    const req = partnerRequirements();
    const ratedCount = agg.rated_count as number;
    const average = round2(Number(agg.avg_stars));
    const meets = ratedCount >= req.minRated && average >= req.minAvg;

    return {
      userId,
      ratedCount,
      average,
      fourPlusCount: agg.four_plus_count as number,
      partnerStatus: p.partner_status as 'none' | 'pending' | 'certified',
      partnerSince: p.partner_since,
      requirements: req,
      meetsRequirements: meets,
      canApply: meets && p.partner_status === 'none',
    };
  }

  /* ================================================================ */
  /* Socio Reclutador                                                  */
  /* ================================================================ */

  async applyForPartner(userId: string, message?: unknown) {
    const msg = typeof message === 'string' && message.trim() ? message.trim().slice(0, 1000) : null;
    const summary = await this.referrerSummary(userId);
    if (summary.partnerStatus === 'certified') throw new ConflictException('already_certified');
    if (summary.partnerStatus === 'pending') throw new ConflictException('application_already_pending');
    if (!summary.meetsRequirements) {
      throw new ForbiddenException('partner_requirements_not_met');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [app] } = await client.query(
        `INSERT INTO public.partner_applications (user_id, message, rated_count, avg_stars)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, status, message, rated_count, avg_stars, created_at`,
        [userId, msg, summary.ratedCount, summary.average],
      );
      await client.query(
        `UPDATE public.profiles SET partner_status = 'pending', updated_at = now() WHERE id = $1`,
        [userId],
      );
      const { rows: admins } = await client.query(`SELECT id FROM public.profiles WHERE role = 'admin'`);
      for (const a of admins) {
        await insertSystemNotification(client, a.id, {
          title: 'Nueva solicitud de Socio Reclutador',
          message: `Un referidor con ${summary.ratedCount} referidos calificados y ${summary.average} estrellas de promedio pidió la certificación.`,
          relatedId: app.id,
          type: 'system_message',
        });
      }
      await client.query('COMMIT');
      return app;
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (e?.code === '23505') throw new ConflictException('application_already_pending');
      throw e;
    } finally {
      client.release();
    }
  }

  async myPartnerApplications(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, status, message, rated_count, avg_stars, review_note, reviewed_at, created_at
         FROM public.partner_applications WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  }

  async listPartnerApplications(status?: string) {
    const st = ['pending', 'approved', 'rejected'].includes(String(status)) ? status : 'pending';
    const { rows } = await this.pool.query(
      `SELECT a.id, a.user_id, a.status, a.message, a.rated_count, a.avg_stars, a.review_note,
              a.reviewed_at, a.created_at, p.full_name, p.email
         FROM public.partner_applications a
         JOIN public.profiles p ON p.id = a.user_id
        WHERE a.status = $1
        ORDER BY a.created_at ASC`,
      [st],
    );
    return rows;
  }

  /** Un admin aprueba o rechaza. Aprobado = sello "Socio Reclutador certificado CME". */
  async reviewPartnerApplication(applicationId: string, adminId: string, approve: boolean, note?: unknown) {
    const reviewNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [app] } = await client.query(
        `UPDATE public.partner_applications
            SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
          WHERE id = $1 AND status = 'pending'
        RETURNING id, user_id, status, review_note, reviewed_at`,
        [applicationId, approve ? 'approved' : 'rejected', adminId, reviewNote],
      );
      if (!app) throw new NotFoundException('pending_application_not_found');

      await client.query(
        approve
          ? `UPDATE public.profiles SET partner_status = 'certified', partner_since = now(), updated_at = now() WHERE id = $1`
          : `UPDATE public.profiles SET partner_status = 'none', updated_at = now() WHERE id = $1`,
        [app.user_id],
      );
      await insertSystemNotification(client, app.user_id, approve
        ? {
            title: '¡Ya eres Socio Reclutador certificado CME!',
            message: 'Tu solicitud fue aprobada. Tu perfil ahora muestra el sello de certificación.',
            relatedId: app.id,
            type: 'system_message',
          }
        : {
            title: 'Tu solicitud de Socio Reclutador no fue aprobada',
            message: reviewNote
              ? `Comentario del equipo CME: ${reviewNote}`
              : 'Puedes volver a solicitarla más adelante.',
            relatedId: app.id,
            type: 'system_message',
          });
      await client.query('COMMIT');
      return app;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /* ================================================================ */
  /* Calificación de empresas                                          */
  /* ================================================================ */

  /** Puede calificar quien postuló a una vacante de la empresa o le recomendó a alguien. */
  private async interactedWithCompany(companyId: string, userId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM public.applications a JOIN public.job_offers j ON j.id = a.job_offer_id
          WHERE j.company_id = $1 AND a.candidate_id = $2
       ) OR EXISTS (
         SELECT 1 FROM public.referrals r JOIN public.job_offers j ON j.id = r.job_offer_id
          WHERE j.company_id = $1 AND r.headhunter_id = $2
       ) AS ok`,
      [companyId, userId],
    );
    return !!rows[0]?.ok;
  }

  async companyRating(companyId: string, userId: string) {
    const { rows: [c] } = await this.pool.query(`SELECT id, admin_id FROM public.companies WHERE id = $1`, [companyId]);
    if (!c) throw new NotFoundException('company_not_found');
    const { rows: [agg] } = await this.pool.query(
      `SELECT count(*)::int AS count, coalesce(round(avg(stars)::numeric, 2), 0)::float AS average
         FROM public.company_ratings WHERE company_id = $1`,
      [companyId],
    );
    const { rows: mine } = await this.pool.query(
      `SELECT stars, comment FROM public.company_ratings WHERE company_id = $1 AND user_id = $2`,
      [companyId, userId],
    );
    const isOwner = String(c.admin_id) === userId;
    return {
      companyId,
      average: Number(agg.average),
      count: agg.count as number,
      myRating: mine[0] ?? null,
      canRate: !isOwner && (await this.interactedWithCompany(companyId, userId)),
    };
  }

  async rateCompany(companyId: string, userId: string, input: { stars: unknown; comment?: unknown }) {
    const stars = assertStars(input.stars);
    const comment = cleanComment(input.comment);
    const { rows: [c] } = await this.pool.query(`SELECT id, admin_id FROM public.companies WHERE id = $1`, [companyId]);
    if (!c) throw new NotFoundException('company_not_found');
    if (String(c.admin_id) === userId) throw new ForbiddenException('cannot_rate_own_company');
    if (!(await this.interactedWithCompany(companyId, userId))) {
      throw new ForbiddenException('only_applicants_or_referrers_can_rate');
    }

    await this.pool.query(
      `INSERT INTO public.company_ratings (company_id, user_id, stars, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, user_id) DO UPDATE
         SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, updated_at = now()`,
      [companyId, userId, stars, comment],
    );
    // companies.company_rating es lo que ya muestran las pantallas: se mantiene como promedio.
    await this.pool.query(
      `UPDATE public.companies
          SET company_rating = (SELECT round(avg(stars)::numeric, 2) FROM public.company_ratings WHERE company_id = $1)
        WHERE id = $1`,
      [companyId],
    );
    return this.companyRating(companyId, userId);
  }
}
