import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from 'src/common/db/pg.constants';
import { SearchProfilesDto } from '../dto/search-profiles.dto';

type UserRole = 'candidate' | 'company_admin' | 'headhunter' | 'admin';
type UserStatus = 'active' | 'inactive' | 'banned' | 'pending';

@Injectable()
export class ProfilesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) { }

  private toJsonArray(val: any): any[] {
    if (val == null) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      } catch {
        return [];
      }
    }
    return [val];
  }

  private normalizeRow<T extends Record<string, any>>(row: T): T {
    if (!row) return row;
    return {
      ...row,
      experience: this.toJsonArray(row.experience),
      education: this.toJsonArray(row.education),
    };
  }

  async upsert(
    userId: string,
    payload: {
      email?: string;
      full_name?: string;
      phone?: string;
      role?: UserRole;
      status?: UserStatus;
      profile_picture?: string | null;
      cover_photo?: string | null;
      occupation?: string | null;
      about_me?: string | null;
      skills?: string[] | null;
      experience?: any;
      education?: any;
      cv_url?: string | null;
      reputation_score?: number | null;
    },
  ) {
    const sql = `
      INSERT INTO public.profiles
        (id, email, full_name, phone, role, status,
         profile_picture, cover_photo, occupation, about_me, skills,
         experience, education, cv_url, reputation_score, created_at, updated_at)
      VALUES
        ($1,$2,NULLIF($3,''),NULLIF($4,''),$5::user_role,$6::user_status,
         NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),$11,
         $12::jsonb,$13::jsonb,NULLIF($14,''),$15, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        email = COALESCE(NULLIF(EXCLUDED.email,''), public.profiles.email),
        full_name = COALESCE(NULLIF(EXCLUDED.full_name,''), public.profiles.full_name),
        phone = COALESCE(NULLIF(EXCLUDED.phone,''), public.profiles.phone),
        role = COALESCE(EXCLUDED.role, public.profiles.role),
        status = COALESCE(EXCLUDED.status, public.profiles.status),
        profile_picture = COALESCE(NULLIF(EXCLUDED.profile_picture,''), public.profiles.profile_picture),
        cover_photo = COALESCE(NULLIF(EXCLUDED.cover_photo,''), public.profiles.cover_photo),
        occupation = COALESCE(NULLIF(EXCLUDED.occupation,''), public.profiles.occupation),
        about_me = COALESCE(NULLIF(EXCLUDED.about_me,''), public.profiles.about_me),
        skills = COALESCE(EXCLUDED.skills, public.profiles.skills),
        experience = COALESCE(EXCLUDED.experience, public.profiles.experience),
        education = COALESCE(EXCLUDED.education, public.profiles.education),
        cv_url = COALESCE(NULLIF(EXCLUDED.cv_url,''), public.profiles.cv_url),
        reputation_score = COALESCE(EXCLUDED.reputation_score, public.profiles.reputation_score),
        updated_at = now()
      RETURNING
        id, email, full_name, phone, role, status,
        profile_picture, cover_photo, occupation, about_me,
        skills,
        COALESCE(
          CASE
            WHEN jsonb_typeof(experience) = 'array' THEN experience
            WHEN experience IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(experience)
          END,
        '[]'::jsonb) AS experience,
        COALESCE(
          CASE
            WHEN jsonb_typeof(education) = 'array' THEN education
            WHEN education IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(education)
          END,
        '[]'::jsonb) AS education,
        cv_url, reputation_score, document_type, document_id, created_at, updated_at
    `;

    const params = [
      userId,
      payload.email ?? null,
      payload.full_name ?? null,
      payload.phone ?? null,
      payload.role ?? 'candidate',
      payload.status ?? 'active',
      payload.profile_picture ?? null,
      payload.cover_photo ?? null,
      payload.occupation ?? null,
      payload.about_me ?? null,
      Array.isArray(payload.skills) && payload.skills.length ? payload.skills : null,
      payload.experience == null ? null : JSON.stringify(payload.experience),
      payload.education == null ? null : JSON.stringify(payload.education),
      payload.cv_url ?? null,
      payload.reputation_score ?? null,
    ];

    const { rows } = await this.pool.query(sql, params);
    return this.normalizeRow(rows[0]);
  }

  async findOne(userId: string) {
    const { rows } = await this.pool.query(
      `
      SELECT
        id, email, full_name, phone, role, status,
        profile_picture, cover_photo, occupation, about_me,
        skills,
        COALESCE(
          CASE
            WHEN jsonb_typeof(experience) = 'array' THEN experience
            WHEN experience IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(experience)
          END,
        '[]'::jsonb) AS experience,
        COALESCE(
          CASE
            WHEN jsonb_typeof(education) = 'array' THEN education
            WHEN education IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(education)
          END,
        '[]'::jsonb) AS education,
        cv_url, reputation_score, document_type, document_id, created_at, updated_at
      FROM public.profiles
      WHERE id = $1
      `,
      [userId],
    );
    if (!rows[0]) throw new NotFoundException('profile_not_found');
    return this.normalizeRow(rows[0]);
  }

  async updatePartial(userId: string, patch: Record<string, any>) {
    const allowed = [
      'email', 'full_name', 'phone', 'role', 'status',
      'profile_picture', 'cover_photo', 'occupation', 'about_me',
      'skills', 'experience', 'education', 'cv_url', 'reputation_score',
      'document_type', 'document_id',
    ];

    if (patch.document_type !== undefined && patch.document_type !== null && patch.document_type !== ''
        && !['cedula', 'passport'].includes(String(patch.document_type))) {
      throw new BadRequestException('invalid_document_type');
    }
    if (patch.document_id !== undefined && patch.document_id !== null
        && String(patch.document_id).trim().length > 30) {
      throw new BadRequestException('invalid_document_id');
    }

    const sets: string[] = [];
    const params: any[] = [];

    for (const key of allowed) {
      if (patch[key] !== undefined) {
        if (key === 'role') {
          params.push(patch[key]);
          sets.push(`role = $${params.length}::user_role`);
        } else if (key === 'status') {
          params.push(patch[key]);
          sets.push(`status = $${params.length}::user_status`);
        } else if (key === 'skills') {
          const skills = Array.isArray(patch.skills) && patch.skills.length ? patch.skills : null;
          params.push(skills);
          sets.push(`skills = $${params.length}::text[]`);
        } else if (key === 'experience' || key === 'education') {
          const jsonVal = patch[key] == null ? null : JSON.stringify(patch[key]);
          params.push(jsonVal);
          sets.push(`${key} = $${params.length}::jsonb`);
        } else if (key === 'reputation_score') {
          params.push(patch[key]);
          sets.push(`reputation_score = $${params.length}::numeric`);
        } else {
          params.push(patch[key] === '' ? null : patch[key]);
          sets.push(`${key} = $${params.length}`);
        }
      }
    }

    if (!sets.length) {
      const { rows } = await this.pool.query(
        `
      SELECT
        id, email, full_name, phone, role, status,
        profile_picture, cover_photo, occupation, about_me, skills,
        COALESCE(
          CASE
            WHEN jsonb_typeof(experience) = 'array' THEN experience
            WHEN experience IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(experience)
          END, '[]'::jsonb
        ) AS experience,
        COALESCE(
          CASE
            WHEN jsonb_typeof(education) = 'array' THEN education
            WHEN education IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(education)
          END, '[]'::jsonb
        ) AS education,
        cv_url, reputation_score, document_type, document_id, created_at, updated_at
      FROM public.profiles
      WHERE id = $1
      `,
        [userId],
      );
      if (!rows[0]) throw new NotFoundException('profile_not_found');
      return this.normalizeRow(rows[0]);
    }

    params.push(userId);
    const sql = `
    UPDATE public.profiles
    SET ${sets.join(', ')}, updated_at = now()
    WHERE id = $${params.length}
    RETURNING
      id, email, full_name, phone, role, status,
      profile_picture, cover_photo, occupation, about_me, skills,
      COALESCE(
        CASE
          WHEN jsonb_typeof(experience) = 'array' THEN experience
          WHEN experience IS NULL THEN '[]'::jsonb
          ELSE jsonb_build_array(experience)
        END, '[]'::jsonb
      ) AS experience,
      COALESCE(
        CASE
          WHEN jsonb_typeof(education) = 'array' THEN education
          WHEN education IS NULL THEN '[]'::jsonb
          ELSE jsonb_build_array(education)
        END, '[]'::jsonb
      ) AS education,
      cv_url, reputation_score, document_type, document_id, created_at, updated_at
  `;
    const { rows } = await this.pool.query(sql, params);
    if (!rows[0]) throw new NotFoundException('profile_not_found');
    return this.normalizeRow(rows[0]);
  }

  async search(dto: SearchProfilesDto) {
    const where: string[] = [];
    const vals: any[] = [];
    const push = (frag: string, val: any, cast?: string) => {
      const i = vals.length + 1;
      where.push(`${frag} $${i}${cast ? `::${cast}` : ''}`);
      vals.push(val);
    };

    if (dto.q) {
      const i = vals.length + 1;
      const pat = `%${dto.q}%`;
      where.push(`(
        full_name ILIKE $${i}
        OR email ILIKE $${i}
        OR occupation ILIKE $${i}
        OR about_me ILIKE $${i}
      )`);
      vals.push(pat);
    }

    if (dto.role) push('role =', dto.role, 'user_role');
    if (dto.status) push('status =', dto.status, 'user_status');
    if (dto.minReputation != null) push('reputation_score >=', dto.minReputation);
    if (dto.maxReputation != null) push('reputation_score <=', dto.maxReputation);

    if (dto.skillsAny?.length) {
      push('skills &&', dto.skillsAny, 'text[]');
    }
    if (dto.skillsAll?.length) {
      push('skills @>', dto.skillsAll, 'text[]');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sortMap: Record<string, string> = {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      reputation: 'reputation_score',
      name: 'full_name',
    };
    const sortCol = sortMap[dto.sortBy || 'createdAt'] || 'created_at';
    const order =
      (dto.order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    vals.push(dto.limit ?? 50);
    vals.push(dto.offset ?? 0);

    const sql = `
      SELECT
        id, email, full_name, phone, role, status, profile_picture, cover_photo,
        occupation, about_me, skills,
        COALESCE(
          CASE
            WHEN jsonb_typeof(experience) = 'array' THEN experience
            WHEN experience IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(experience)
          END,
        '[]'::jsonb) AS experience,
        COALESCE(
          CASE
            WHEN jsonb_typeof(education) = 'array' THEN education
            WHEN education IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(education)
          END,
        '[]'::jsonb) AS education,
        cv_url, reputation_score, created_at, updated_at
      FROM public.profiles
      ${whereSql}
      ORDER BY ${sortCol} ${order}
      LIMIT $${vals.length - 1} OFFSET $${vals.length}
    `;

    const { rows } = await this.pool.query(sql, vals);
    return rows.map((r) => this.normalizeRow(r));
  }
}
