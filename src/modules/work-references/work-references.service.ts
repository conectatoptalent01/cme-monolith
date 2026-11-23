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
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/db/pg.constants';
import { insertSystemNotification } from '../../common/db/notify';
import { hashToken } from '../invitations/invitations.service';
import { maskPhone, normalizePhone } from '../invitations/phone';
import { WhatsAppSender } from '../invitations/whatsapp.sender';

export const MAX_ACTIVE_REFERENCES = 3;

const firstWord = (s: string | null | undefined) => String(s ?? '').trim().split(/\s+/)[0] || '';

/** Al resolverse (confirmar, rechazar o vencer) se borran el teléfono y el enlace de la referencia. */
const RESOLVE_SQL = `phone = NULL, token_hash = NULL, resolved_at = now()`;

/** Lo que ven el candidato y las empresas: nunca el teléfono ni el enlace. */
const PUBLIC_COLUMNS = `id, candidate_id, reference_name, company_name, relationship, status,
  reference_comment, expires_at, resolved_at, created_at`;

@Injectable()
export class WorkReferencesService {
  private readonly log = new Logger('WorkReferences');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly whatsapp: WhatsAppSender,
  ) {}

  private get frontend() {
    return (process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  }

  private get ttlDays() {
    const n = Number(process.env.REFERENCE_TTL_DAYS ?? 14);
    return Number.isFinite(n) && n > 0 ? n : 14;
  }

  /* ------------------------------------------------------------------ */
  /* El candidato agrega una referencia (máximo 3 vigentes)              */
  /* ------------------------------------------------------------------ */

  async create(
    candidateId: string,
    dto: { referenceName: string; companyName: string; relationship: string; phone: string },
  ) {
    const phone = normalizePhone(dto.phone);
    if (!phone) throw new BadRequestException('invalid_phone');
    const referenceName = dto.referenceName.trim();
    const companyName = dto.companyName.trim();
    const relationship = dto.relationship.trim();
    if (!referenceName || !companyName || !relationship) throw new BadRequestException('fields_required');

    const { rows: [cand] } = await this.pool.query(
      `SELECT full_name, phone FROM public.profiles WHERE id = $1`,
      [candidateId],
    );
    if (!cand) throw new NotFoundException('profile_not_found');
    if (cand.phone && normalizePhone(cand.phone) === phone) {
      throw new BadRequestException('reference_cannot_be_yourself');
    }

    const { rows: [{ active }] } = await this.pool.query(
      `SELECT count(*)::int AS active FROM public.work_references
        WHERE candidate_id = $1 AND status IN ('pending', 'confirmed')`,
      [candidateId],
    );
    if (active >= MAX_ACTIVE_REFERENCES) throw new ConflictException('max_references_reached');

    const token = randomBytes(24).toString('base64url');
    const { rows: [ref] } = await this.pool.query(
      `INSERT INTO public.work_references
         (candidate_id, reference_name, company_name, relationship, phone, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
       RETURNING ${PUBLIC_COLUMNS}`,
      [candidateId, referenceName, companyName, relationship, phone, hashToken(token), this.ttlDays],
    );

    const confirmUrl = `${this.frontend}/referencia/${token}`;
    const sent = await this.whatsapp.sendReferenceRequest({
      to: phone,
      referenceFirstName: firstWord(referenceName),
      candidateName: cand.full_name || 'Un candidato',
      companyName,
      token,
      confirmUrl,
    });
    await this.pool.query(
      `INSERT INTO public.whatsapp_messages
         (work_reference_id, to_phone_masked, template, mode, status, provider_message_id, error)
       VALUES ($1, $2, 'work_reference', $3, $4, $5, $6)`,
      [ref.id, maskPhone(phone), sent.mode, sent.status, sent.providerMessageId ?? null, sent.error ?? null],
    );

    return {
      ...ref,
      confirmUrl,
      shareText: sent.previewText,
      whatsapp: { mode: sent.mode, status: sent.status, to: maskPhone(phone), error: sent.error ?? null },
    };
  }

  async listMine(candidateId: string) {
    const { rows } = await this.pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM public.work_references
        WHERE candidate_id = $1 ORDER BY created_at DESC`,
      [candidateId],
    );
    return rows;
  }

  /** El candidato puede retirar una referencia pendiente (por ejemplo, si se equivocó de número). */
  async removePending(candidateId: string, id: string) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM public.work_references WHERE id = $1 AND candidate_id = $2 AND status = 'pending'`,
      [id, candidateId],
    );
    if (!rowCount) throw new NotFoundException('pending_reference_not_found');
    return { ok: true };
  }

  /**
   * Referencias CONFIRMADAS de un candidato, para las empresas.
   * Las ve el propio candidato, un admin, o la empresa con una postulación o un referido de ese candidato.
   */
  async confirmedForCandidate(candidateId: string, viewer: { id: string; isAdmin: boolean }) {
    if (viewer.id !== candidateId && !viewer.isAdmin) {
      const { rows } = await this.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM public.applications a
             JOIN public.job_offers j ON j.id = a.job_offer_id
             JOIN public.companies c ON c.id = j.company_id
            WHERE a.candidate_id = $1 AND c.admin_id = $2
         ) OR EXISTS (
           SELECT 1 FROM public.referrals r
             JOIN public.job_offers j ON j.id = r.job_offer_id
             JOIN public.companies c ON c.id = j.company_id
            WHERE r.candidate_id = $1 AND c.admin_id = $2
         ) AS ok`,
        [candidateId, viewer.id],
      );
      if (!rows[0]?.ok) throw new ForbiddenException('not_a_company_with_this_candidate');
    }
    const { rows } = await this.pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM public.work_references
        WHERE candidate_id = $1 AND status = 'confirmed' ORDER BY resolved_at DESC`,
      [candidateId],
    );
    return rows;
  }

  /* ------------------------------------------------------------------ */
  /* La referencia responde (página pública del enlace)                  */
  /* ------------------------------------------------------------------ */

  private async findOpenByToken(token: string) {
    if (!token || token.length < 20 || token.length > 100) throw new NotFoundException('reference_not_found');
    const { rows: [ref] } = await this.pool.query(
      `SELECT w.id, w.candidate_id, w.reference_name, w.company_name, w.relationship, w.expires_at,
              p.full_name AS candidate_name
         FROM public.work_references w
         JOIN public.profiles p ON p.id = w.candidate_id
        WHERE w.token_hash = $1 AND w.status = 'pending'`,
      [hashToken(token)],
    );
    if (!ref) throw new NotFoundException('reference_not_found');
    if (new Date(ref.expires_at).getTime() <= Date.now()) {
      await this.pool.query(
        `UPDATE public.work_references SET status = 'expired', ${RESOLVE_SQL} WHERE id = $1`,
        [ref.id],
      );
      throw new GoneException('reference_expired');
    }
    return ref;
  }

  async getPublic(token: string) {
    const ref = await this.findOpenByToken(token);
    return {
      referenceFirstName: firstWord(ref.reference_name),
      candidateName: ref.candidate_name,
      companyName: ref.company_name,
      relationship: ref.relationship,
      expiresAt: ref.expires_at,
    };
  }

  async respond(token: string, confirm: boolean, comment?: unknown) {
    const ref = await this.findOpenByToken(token);
    const text = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 500) : null;

    const { rowCount } = await this.pool.query(
      `UPDATE public.work_references
          SET status = $2, reference_comment = $3, ${RESOLVE_SQL}
        WHERE id = $1 AND status = 'pending'`,
      [ref.id, confirm ? 'confirmed' : 'declined', confirm ? text : null],
    );
    if (!rowCount) throw new NotFoundException('reference_not_found');

    await insertSystemNotification(this.pool, ref.candidate_id, confirm
      ? {
          title: `${firstWord(ref.reference_name)} confirmó tu referencia`,
          message: `Tu referencia de ${ref.company_name} quedó validada y las empresas ya pueden verla.`,
          relatedId: ref.id,
          type: 'system_message',
        }
      : {
          title: `${firstWord(ref.reference_name)} no confirmó tu referencia`,
          message: `Tu referencia de ${ref.company_name} no fue confirmada. Puedes agregar otra.`,
          relatedId: ref.id,
          type: 'system_message',
        });
    return { ok: true, status: confirm ? 'confirmed' : 'declined' };
  }

  /* ------------------------------------------------------------------ */

  @Cron(CronExpression.EVERY_HOUR)
  async expirePending(): Promise<number> {
    try {
      const { rowCount } = await this.pool.query(
        `UPDATE public.work_references SET status = 'expired', ${RESOLVE_SQL}
          WHERE status = 'pending' AND expires_at <= now()`,
      );
      if (rowCount) this.log.log(`Referencias vencidas: ${rowCount}`);
      return rowCount ?? 0;
    } catch (e: any) {
      this.log.warn(`No se pudieron vencer referencias: ${e?.message}`);
      return 0;
    }
  }
}
