import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../common/db/pg.constants';
import { maskPhone, normalizePhone } from './phone';
import { WhatsAppSender } from './whatsapp.sender';
import { CreateInvitationDto } from './dto/create-invitation.dto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Columnas que se borran cuando la invitación se resuelve (acepta, rechaza o vence). */
const PURGE_INVITEE_SQL = `
  invitee_first_name = NULL,
  invitee_last_name = NULL,
  invitee_phone = NULL,
  invite_token_hash = NULL,
  invitee_data_purged_at = now(),
  updated_at = now()
`;

const firstWord = (s: string | null | undefined) => String(s ?? '').trim().split(/\s+/)[0] || '';

@Injectable()
export class InvitationsService {
  private readonly log = new Logger('Invitations');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly whatsapp: WhatsAppSender,
  ) {}

  private get frontend() {
    return (process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  }

  private get ttlDays() {
    const n = Number(process.env.INVITE_TTL_DAYS ?? 7);
    return Number.isFinite(n) && n > 0 ? n : 7;
  }

  inviteUrl(token: string) {
    return `${this.frontend}/invitacion/${token}`;
  }

  /* ------------------------------------------------------------------ */
  /* Crear: el referidor da nombre, apellido y teléfono                  */
  /* ------------------------------------------------------------------ */

  async create(referrerId: string, dto: CreateInvitationDto) {
    const phone = normalizePhone(dto.phone);
    if (!phone) throw new BadRequestException('invalid_phone');

    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    if (!firstName || !lastName) throw new BadRequestException('name_required');

    const { rows: [ctx] } = await this.pool.query(
      `SELECT j.id AS job_id, j.title, j.company_id, c.name AS company_name, c.admin_id,
              p.full_name AS referrer_name
         FROM public.job_offers j
         JOIN public.companies c ON c.id = j.company_id
         LEFT JOIN public.profiles p ON p.id = $2
        WHERE j.id = $1`,
      [dto.jobOfferId, referrerId],
    );
    if (!ctx) throw new NotFoundException('job_offer_not_found');
    if (String(ctx.admin_id) === referrerId) {
      throw new ForbiddenException('cannot_refer_to_own_company');
    }

    const { rows: dup } = await this.pool.query(
      `SELECT 1 FROM public.referrals
        WHERE job_offer_id = $1 AND invitee_phone = $2 AND invite_token_hash IS NOT NULL
        LIMIT 1`,
      [dto.jobOfferId, phone],
    );
    if (dup.length) throw new ConflictException('phone_already_invited_for_job');

    const token = randomBytes(24).toString('base64url');
    const code = await this.uniqueReferralCode();

    let referral: any;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO public.referrals
           (headhunter_id, candidate_id, job_offer_id, status, referral_code,
            invitee_first_name, invitee_last_name, invitee_phone, recommendation_note,
            invite_token_hash, invite_expires_at)
         VALUES ($1, NULL, $2, 'submitted'::referral_status, $3, $4, $5, $6, $7, $8,
                 now() + make_interval(days => $9))
         RETURNING id, job_offer_id, status, invite_expires_at, created_at`,
        [referrerId, dto.jobOfferId, code, firstName, lastName, phone,
         dto.note?.trim() || null, hashToken(token), this.ttlDays],
      );
      referral = rows[0];
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException('phone_already_invited_for_job');
      throw e;
    }

    const inviteUrl = this.inviteUrl(token);
    const sent = await this.whatsapp.sendReferralInvite({
      to: phone,
      inviteeFirstName: firstName,
      referrerName: ctx.referrer_name || 'Un contacto',
      jobTitle: ctx.title,
      companyName: ctx.company_name,
      token,
      inviteUrl,
    });

    await this.pool.query(
      `INSERT INTO public.whatsapp_messages
         (referral_id, to_phone_masked, template, mode, status, provider_message_id, error)
       VALUES ($1, $2, 'referral_invite', $3, $4, $5, $6)`,
      [referral.id, maskPhone(phone), sent.mode, sent.status, sent.providerMessageId ?? null, sent.error ?? null],
    );
    if (sent.status !== 'failed') {
      await this.pool.query(`UPDATE public.referrals SET invite_sent_at = now() WHERE id = $1`, [referral.id]);
    }

    // El enlace se devuelve SOLO a quien refiere: puede compartirlo también desde su propio WhatsApp.
    return {
      referralId: referral.id,
      jobOfferId: referral.job_offer_id,
      expiresAt: referral.invite_expires_at,
      inviteUrl,
      shareText: sent.previewText,
      whatsapp: { mode: sent.mode, status: sent.status, to: maskPhone(phone), error: sent.error ?? null },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Ver la invitación (pública, con el token del enlace)                */
  /* ------------------------------------------------------------------ */

  async getPublic(token: string) {
    const row = await this.findByToken(this.pool, token);
    if (new Date(row.invite_expires_at).getTime() <= Date.now()) {
      await this.expireOne(row.id);
      throw new GoneException('invitation_expired');
    }
    return {
      inviteeFirstName: row.invitee_first_name,
      referrerFirstName: firstWord(row.referrer_name) || 'Un contacto',
      recommendationNote: row.recommendation_note,
      job: { id: row.job_offer_id, title: row.title, companyName: row.company_name },
      expiresAt: row.invite_expires_at,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rechazar (pública): se borran nombre y teléfono                     */
  /* ------------------------------------------------------------------ */

  async decline(token: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.findByToken(client, token, true);
      if (new Date(row.invite_expires_at).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        await this.expireOne(row.id);
        throw new GoneException('invitation_expired');
      }
      await client.query(
        `UPDATE public.referrals
            SET status = 'declined_by_candidate'::referral_status, ${PURGE_INVITEE_SQL}
          WHERE id = $1`,
        [row.id],
      );
      await this.notify(client, row.headhunter_id, {
        title: `${row.invitee_first_name} no aceptó tu recomendación`,
        message: `Tu contacto decidió no participar en la vacante "${row.title}" de ${row.company_name}.`,
        relatedId: row.id,
      });
      await client.query('COMMIT');
      return { ok: true, status: 'declined_by_candidate' };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Aceptar (con sesión): el usuario queda como candidato y postulado    */
  /* ------------------------------------------------------------------ */

  async accept(token: string, userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.findByToken(client, token, true);

      if (new Date(row.invite_expires_at).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        await this.expireOne(row.id);
        throw new GoneException('invitation_expired');
      }
      if (String(row.headhunter_id) === userId) throw new ForbiddenException('cannot_accept_own_referral');
      if (String(row.admin_id) === userId) throw new ForbiddenException('company_admin_cannot_be_candidate');

      const { rows: already } = await client.query(
        `SELECT 1 FROM public.referrals
          WHERE job_offer_id = $1 AND candidate_id = $2 AND id <> $3 LIMIT 1`,
        [row.job_offer_id, userId, row.id],
      );
      if (already.length) throw new ConflictException('already_referred_for_job');

      await client.query(
        `UPDATE public.referrals
            SET candidate_id = $2, status = 'accepted_by_candidate'::referral_status, ${PURGE_INVITEE_SQL}
          WHERE id = $1`,
        [row.id, userId],
      );

      const { rows: app } = await client.query(
        `SELECT id FROM public.applications WHERE job_offer_id = $1 AND candidate_id = $2 LIMIT 1`,
        [row.job_offer_id, userId],
      );
      let applicationId = app[0]?.id ?? null;
      if (!applicationId) {
        const { rows: created } = await client.query(
          `INSERT INTO public.applications (job_offer_id, candidate_id, accepted, notes)
           VALUES ($1, $2, false, $3) RETURNING id`,
          [row.job_offer_id, userId, 'Postulación por recomendación'],
        );
        applicationId = created[0].id;
      }

      await this.notify(client, row.headhunter_id, {
        title: `${row.invitee_first_name} aceptó tu recomendación`,
        message: `Tu contacto ya está postulado a "${row.title}" de ${row.company_name}.`,
        relatedId: row.id,
      });
      await this.notify(client, row.admin_id, {
        title: `Nuevo candidato recomendado para "${row.title}"`,
        message: `Un candidato aceptó una recomendación y quedó postulado a tu vacante.`,
        relatedId: applicationId,
      });

      const { rows: [profile] } = await client.query(
        `SELECT full_name, phone, cv_url, document_id FROM public.profiles WHERE id = $1`,
        [userId],
      );

      await client.query('COMMIT');

      const missing = ['full_name', 'phone', 'document_id', 'cv_url'].filter((k) => !profile?.[k]);
      return {
        ok: true,
        referralId: row.id,
        applicationId,
        jobOfferId: row.job_offer_id,
        missingProfileFields: missing,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Vencimiento: cada hora se cierran las invitaciones sin respuesta     */
  /* ------------------------------------------------------------------ */

  @Cron(CronExpression.EVERY_HOUR)
  async expirePending(): Promise<number> {
    try {
      const { rows } = await this.pool.query(
        `WITH expired AS (
           UPDATE public.referrals r
              SET status = 'expired'::referral_status, ${PURGE_INVITEE_SQL}
            WHERE r.invite_token_hash IS NOT NULL AND r.invite_expires_at <= now()
          RETURNING r.id, r.headhunter_id, r.job_offer_id
         )
         SELECT e.id, e.headhunter_id, j.title
           FROM expired e JOIN public.job_offers j ON j.id = e.job_offer_id`,
      );
      for (const r of rows) {
        await this.notify(this.pool, r.headhunter_id, {
          title: 'Una recomendación venció sin respuesta',
          message: `Tu contacto no respondió a tiempo la invitación para "${r.title}". Sus datos fueron borrados.`,
          relatedId: r.id,
        }).catch(() => undefined);
      }
      if (rows.length) this.log.log(`Invitaciones vencidas: ${rows.length}`);
      return rows.length;
    } catch (e: any) {
      this.log.warn(`No se pudieron vencer invitaciones: ${e?.message}`);
      return 0;
    }
  }

  /* ------------------------------------------------------------------ */

  private async expireOne(referralId: string) {
    await this.pool.query(
      `UPDATE public.referrals
          SET status = 'expired'::referral_status, ${PURGE_INVITEE_SQL}
        WHERE id = $1 AND invite_token_hash IS NOT NULL`,
      [referralId],
    );
  }

  private async findByToken(db: Pool | PoolClient, token: string, forUpdate = false) {
    if (!token || token.length < 20 || token.length > 100) throw new NotFoundException('invitation_not_found');
    const { rows } = await db.query(
      `SELECT r.id, r.headhunter_id, r.job_offer_id, r.invitee_first_name, r.recommendation_note,
              r.invite_expires_at, j.title, c.name AS company_name, c.admin_id,
              p.full_name AS referrer_name
         FROM public.referrals r
         JOIN public.job_offers j ON j.id = r.job_offer_id
         JOIN public.companies c ON c.id = j.company_id
         LEFT JOIN public.profiles p ON p.id = r.headhunter_id
        WHERE r.invite_token_hash = $1
        ${forUpdate ? 'FOR UPDATE OF r' : ''}`,
      [hashToken(token)],
    );
    if (!rows[0]) throw new NotFoundException('invitation_not_found');
    return rows[0];
  }

  private async notify(
    db: Pool | PoolClient,
    userId: string | null | undefined,
    n: { title: string; message: string; relatedId: string | null },
  ) {
    if (!userId) return;
    await db.query(
      `INSERT INTO public.notifications (user_id, title, message, notification_type, channel, status, related_id)
       VALUES ($1, $2, $3, 'recommendation'::notification_type, 'system'::notification_channel,
               'sent'::notification_status, $4)`,
      [userId, n.title.slice(0, 180), n.message.slice(0, 5000), n.relatedId],
    );
  }

  private async uniqueReferralCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const bytes = randomBytes(6);
      const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      const { rows } = await this.pool.query(
        `SELECT 1 FROM public.referrals WHERE referral_code = $1 LIMIT 1`,
        [code],
      );
      if (!rows.length) return code;
    }
    throw new ConflictException('could_not_generate_referral_code');
  }
}
