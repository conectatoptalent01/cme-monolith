import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { CreateReferralDto } from './dto/create-referral.dto';
import { UpdateReferralDto } from './dto/update-referral.dto';
import { QueryReferralsDto } from './dto/query-referrals.dto';
import { PG_POOL } from 'src/common/db/pg.constants';

type ReferralStatus =
  | 'submitted'
  | 'accepted_by_candidate'
  | 'declined_by_candidate'
  | 'reviewing'
  | 'rejected'
  | 'shortlist'
  | 'hired';

@Injectable()
export class ReferralsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) { }

  private async generateUniqueReferralCode(): Promise<string> {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const gen = () =>
      Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

    for (let i = 0; i < 5; i++) {
      const code = gen();
      const { rows } = await this.pool.query(
        `SELECT 1 FROM public.referrals WHERE referral_code = $1 LIMIT 1`,
        [code],
      );
      if (rows.length === 0) return code;
    }
    return gen();
  }

  private async _ensureNotDuplicate(input: {
    headhunterId: string;
    candidateId?: string | null;
    jobOfferId: string;
  }) {
    const { headhunterId, candidateId, jobOfferId } = input;

    const where =
      candidateId && candidateId.trim().length
        ? `headhunter_id = $1 AND candidate_id = $2 AND job_offer_id = $3`
        : `headhunter_id = $1 AND candidate_id IS NULL AND job_offer_id = $2`;

    const params =
      candidateId && candidateId.trim().length
        ? [headhunterId, candidateId, jobOfferId]
        : [headhunterId, jobOfferId];

    const { rows } = await this.pool.query(
      `SELECT id FROM public.referrals WHERE ${where} LIMIT 1`,
      params,
    );
    if (rows[0]) {
      throw new ConflictException('referral_already_exists');
    }
  }

  async create(input: CreateReferralDto) {
    await this._ensureNotDuplicate({
      headhunterId: input.headhunterId,
      candidateId: input.candidateId ?? null,
      jobOfferId: input.jobOfferId,
    });

    const referralCode = input.referralCode ?? (await this.generateUniqueReferralCode());

    const sql = `
      INSERT INTO public.referrals
        (headhunter_id, candidate_id, job_offer_id, status, referral_code)
      VALUES ($1,$2,$3,$4::referral_status,$5)
      RETURNING id, headhunter_id, candidate_id, job_offer_id, status, referral_code, created_at
    `;
    const params = [
      input.headhunterId,
      input.candidateId ?? null,
      input.jobOfferId,
      input.status ?? 'submitted',
      referralCode,
    ];

    try {
      const { rows } = await this.pool.query(sql, params);
      return rows[0];
    } catch (err: any) {
      if (err.code === '23503') throw new BadRequestException(`Invalid reference: ${err.detail}`);
      if (err.code === '22P02') throw new BadRequestException('Invalid enum or data type');
      if (err.code === '23505') {
        if (String(err.detail || '').includes('referral_code')) {
          throw new ConflictException('referral_code_conflict_try_again');
        }
        throw new ConflictException('referral_already_exists');
      }
      if (err.code === '23502') {
        const col = err.column || 'unknown_column';
        throw new BadRequestException(`null_violation: ${col}`);
      }
      throw new InternalServerErrorException('Unexpected error creating referral');
    }
  }

  async list(q: QueryReferralsDto) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q.headhunterId) { where.push(`headhunter_id = $${i++}`); params.push(q.headhunterId); }
    if (q.candidateId) { where.push(`candidate_id = $${i++}`); params.push(q.candidateId); }
    if (q.jobOfferId) { where.push(`job_offer_id = $${i++}`); params.push(q.jobOfferId); }
    if (q.status) { where.push(`status = $${i++}`); params.push(q.status); }

    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const sql = `
      SELECT id, headhunter_id, candidate_id, job_offer_id, status, referral_code, created_at, updated_at
      FROM public.referrals
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT $${i++} OFFSET $${i++}
    `;
    params.push(limit, offset);

    try {
      const { rows } = await this.pool.query(sql, params);
      return rows;
    } catch {
      throw new InternalServerErrorException('Unexpected error listing referrals');
    }
  }

  async listByHeadhunter(headhunterId: string, q: QueryReferralsDto) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const sql = `
      SELECT id, headhunter_id, candidate_id, job_offer_id, status, referral_code, created_at, updated_at,
             -- solo quien refiere ve a quién invitó (se borra al aceptar, rechazar o vencer)
             invitee_first_name, invitee_last_name, invite_expires_at
      FROM public.referrals
      WHERE headhunter_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    try {
      const { rows } = await this.pool.query(sql, [headhunterId, limit, offset]);
      return rows;
    } catch {
      throw new InternalServerErrorException('Unexpected error listing by headhunter');
    }
  }

  async listByCandidate(candidateId: string, q: QueryReferralsDto) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const sql = `
      SELECT id, headhunter_id, candidate_id, job_offer_id, status, referral_code, created_at, updated_at
      FROM public.referrals
      WHERE candidate_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    try {
      const { rows } = await this.pool.query(sql, [candidateId, limit, offset]);
      return rows;
    } catch {
      throw new InternalServerErrorException('Unexpected error listing by candidate');
    }
  }

  async findOne(id: string) {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, headhunter_id, candidate_id, job_offer_id, status, referral_code, created_at, updated_at,
                invitee_first_name, invitee_last_name, invite_expires_at
           FROM public.referrals WHERE id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException('referral_not_found');
      return rows[0];
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException('Unexpected error finding referral');
    }
  }

  async update(id: string, patch: UpdateReferralDto) {
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (patch.status !== undefined) {
      sets.push(`status = $${i++}::referral_status`);
      params.push(patch.status);
    }

    const candidate =
      (patch.candidateId && String(patch.candidateId)) ||
      (patch.candidate_id && String(patch.candidate_id)) ||
      undefined;

    if (candidate !== undefined) {
      sets.push(`candidate_id = $${i++}`);
      params.push(candidate);
    }

    if (!sets.length) return this.findOne(id);

    sets.push(`updated_at = now()`);
    params.push(id);

    const sql = `
      UPDATE public.referrals
      SET ${sets.join(', ')}
      WHERE id = $${i}
      RETURNING id, headhunter_id, candidate_id, job_offer_id, status, referral_code, updated_at
    `;
    try {
      const { rows } = await this.pool.query(sql, params);
      if (!rows[0]) throw new NotFoundException('referral_not_found');
      return rows[0];
    } catch (err: any) {
      if (err.code === '22P02') throw new BadRequestException('Invalid enum or data type');
      if (err.code === '23503') throw new BadRequestException(`Invalid reference: ${err.detail}`);
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException('Unexpected error updating referral');
    }
  }

  async updateStatus(
    id: string,
    status: ReferralStatus,
  ) {
    try {
      const { rows } = await this.pool.query(
        `
          UPDATE public.referrals
          SET status = $2::referral_status, updated_at = now()
          WHERE id = $1
          RETURNING id, headhunter_id, candidate_id, job_offer_id, status, referral_code, updated_at
        `,
        [id, status],
      );
      if (!rows[0]) throw new NotFoundException('referral_not_found');
      return rows[0];
    } catch (err: any) {
      if (err.code === '22P02') throw new BadRequestException('Invalid enum or data type');
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException('Unexpected error updating status');
    }
  }

  async remove(id: string) {
    try {
      const { rows } = await this.pool.query(
        `DELETE FROM public.referrals WHERE id = $1 RETURNING id`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException('referral_not_found');
      return { ok: true };
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException('Unexpected error deleting referral');
    }
  }

  /**
   * El candidato "canjea" un código de referido (flujo anterior a las invitaciones por WhatsApp).
   * Solo funciona sobre un referido libre y nunca para quien lo creó.
   */
  async claimByCode(code: string, userId: string) {
    const normalized = String(code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalized)) throw new BadRequestException('invalid_referral_code');

    const { rows } = await this.pool.query(
      `UPDATE public.referrals
          SET candidate_id = $2, status = 'accepted_by_candidate'::referral_status, updated_at = now()
        WHERE referral_code = $1
          AND candidate_id IS NULL
          AND headhunter_id <> $2
          AND status = 'submitted'::referral_status
      RETURNING id, headhunter_id, candidate_id, job_offer_id, status, referral_code, created_at, updated_at`,
      [normalized, userId],
    );
    if (!rows[0]) throw new NotFoundException('referral_code_not_available');
    return rows[0];
  }
}
