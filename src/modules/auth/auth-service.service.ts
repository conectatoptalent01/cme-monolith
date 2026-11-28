import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
  // @ts-ignore: depende de tu instalación
import { createClient, SupabaseClient, AuthApiError, User } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { Inject } from '@nestjs/common';
import { PG_POOL } from 'src/common/db/pg.constants';

type UserRole = 'candidate' | 'company_admin' | 'headhunter' | 'admin';

/** Roles que un usuario puede elegir al registrarse. 'admin' solo se asigna a mano en la base de datos. */
export const SELF_ASSIGNABLE_ROLES = ['candidate', 'company_admin', 'headhunter'] as const;

/** Devuelve el rol pedido si es auto-asignable; cualquier otro valor (incluido 'admin') cae a 'candidate'. */
export function selfAssignableRole(role?: string | null): UserRole {
  return (SELF_ASSIGNABLE_ROLES as readonly string[]).includes(String(role ?? ''))
    ? (role as UserRole)
    : 'candidate';
}
type UserStatus = 'active' | 'inactive' | 'banned' | 'pending';

@Injectable()
export class AuthService {
  private admin: SupabaseClient;
  private pub: SupabaseClient;

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {
    const url = this.config.get<string>('SUPABASE_URL');
    const anon = this.config.get<string>('SUPABASE_ANON_KEY');
    const service = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!url || !anon || !service) {
      throw new InternalServerErrorException('Supabase configuration is missing');
    }

    this.pub = createClient(url, anon, { auth: { persistSession: false } });
    this.admin = createClient(url, service, { auth: { persistSession: false } });
  }

  // ---- util: mapeo de errores supabase
  private mapSupabaseError(err: any, fallbackMsg: string): never {
    if (err instanceof AuthApiError) {
      if (err.status === 400) {
        if ((err.message || '').toLowerCase().includes('invalid')) {
          throw new UnauthorizedException('invalid_credentials');
        }
        throw new BadRequestException(err.message || 'invalid_payload');
      }
      if (err.status === 401) throw new UnauthorizedException('unauthorized');
      if (err.status === 403) throw new ForbiddenException('forbidden');
      if (err.status === 409) throw new ConflictException('resource_conflict');
      throw new InternalServerErrorException(err.message || fallbackMsg);
    }

    const status = err?.response?.status;
    const msg = err?.response?.data?.message ?? err?.message ?? fallbackMsg;
    if (status) {
      if (status === 400) throw new BadRequestException(msg);
      if (status === 401) throw new UnauthorizedException(msg);
      if (status === 403) throw new ForbiddenException(msg);
      if (status === 409) throw new ConflictException(msg);
      throw new InternalServerErrorException(msg);
    }

    throw new InternalServerErrorException(fallbackMsg);
  }

  // ---- util: mapeo de errores Postgres
  private mapPgError(err: any, fallbackMsg: string): never {
    const code: string | undefined = err?.code;
    if (code === '23505') {
      throw new ConflictException('unique_violation');
    }
    if (code === '23503') {
      throw new BadRequestException('foreign_key_violation');
    }
    throw new InternalServerErrorException(fallbackMsg);
  }

  // ---- util: normalización de teléfono (opcional)
  private normalizePhone(phone?: string) {
    if (!phone) return '';
    const only = String(phone).replace(/[^\d+]/g, '');
    return only.slice(0, 20);
  }

  // ---- util: detectar si una url es de Google Photos (Google avatar)
  private isGoogleAvatar(url: string | null | undefined): boolean {
    if (!url) return false;
    return /^https:\/\/lh3\.googleusercontent\.com\//i.test(url);
  }

  // ---- util: obtener role desde public.profiles
  async getRoleFromProfiles(userId: string): Promise<string | null> {
    const sql = `SELECT role FROM public.profiles WHERE id = $1 LIMIT 1`;
    const { rows } = await this.pool.query(sql, [userId]);
    return rows?.[0]?.role ?? null;
  }

  // ---- util: obtener foto desde user / identities de supabase
  private extractAvatarFromUser(sbUser: User | null | undefined): string {
    if (!sbUser) return '';
    const meta: any = sbUser.user_metadata || {};
    const fromMeta =
      meta.avatar_url ||
      meta.picture ||
      meta.avatarUrl ||
      meta.photo_url ||
      '';

    const fromIdentities =
      (Array.isArray((sbUser as any).identities) &&
        (sbUser as any).identities.length > 0 &&
        ((sbUser as any).identities[0].identity_data?.avatar_url ||
          (sbUser as any).identities[0].identity_data?.picture ||
          (sbUser as any).identities[0].identity_data?.photo_url)) ||
      '';

    const url = String(fromMeta || fromIdentities || '').trim();
    if (!url || url.toLowerCase() === 'null' || url.toLowerCase() === 'undefined') {
      return '';
    }
    return url;
  }

  // ---- util: upsert perfil en public.profiles (con manejo de profile_picture)
  private async upsertProfile(
    userId: string,
    payload: {
      email: string;
      fullName?: string;
      phone?: string;
      role?: UserRole;
      status?: UserStatus;
      profilePicture?: string; // si viene '', no sobreescribe
    },
  ) {
    const sql = `
      INSERT INTO public.profiles
        (id, email, full_name, phone, role, status, profile_picture, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5::user_role, $6::user_status, NULLIF($7, ''), now(), now())
      ON CONFLICT (id) DO UPDATE
        SET email = EXCLUDED.email,
            full_name = EXCLUDED.full_name,
            phone = EXCLUDED.phone,
            -- un usuario nunca puede asignarse 'admin', y un admin existente no pierde su rol por un upsert
            role = CASE
              WHEN public.profiles.role = 'admin' THEN public.profiles.role
              ELSE EXCLUDED.role
            END,
            status = EXCLUDED.status,
            profile_picture = CASE
              WHEN EXCLUDED.profile_picture IS NOT NULL THEN EXCLUDED.profile_picture
              ELSE public.profiles.profile_picture
            END,
            updated_at = now()
      RETURNING id, role, profile_picture;
    `;
    const params = [
      userId,
      payload.email,
      payload.fullName ?? '',
      this.normalizePhone(payload.phone),
      selfAssignableRole(payload.role),
      payload.status ?? ('active' as UserStatus),
      (payload.profilePicture ?? '').trim(),
    ];
    const { rows } = await this.pool.query(sql, params);
    return {
      id: rows?.[0]?.id as string,
      role: rows?.[0]?.role as string,
      profile_picture: rows?.[0]?.profile_picture as string | null,
    };
  }

  // ---- util: sincronizar user_metadata.role/picture en Supabase Admin
  private async ensureUserMetadata(
    userId: string,
    patch: Partial<{ role: string; picture: string }>,
  ) {
    try {
      await this.admin.auth.admin.updateUserById(userId, {
        user_metadata: patch,
      });
    } catch {
      // no bloqueamos el flujo si falla metadata
    }
  }

  // -------------------------
  // Endpoints (llamados por controller)
  // -------------------------

  async signup(input: {
    email: string;
    password: string;
    fullName?: string;
    phone?: string;
    role?: UserRole;
  }) {
    const email = (input.email || '').trim().toLowerCase();
    const fullName = input.fullName ?? '';
    const normalizedPhone = this.normalizePhone(input.phone);
    const role = input.role ?? ('candidate' as UserRole);

    try {
      const { data, error } = await this.admin.auth.signUp({
        email,
        password: input.password,
        options: {
          data: {
            full_name: fullName ?? '',
            role: role ?? 'candidate',
            phone: normalizedPhone,
          },
        },
      });
      if (error) this.mapSupabaseError(error, 'signup_failed');
      const user = data.user!;

      const up = await this.upsertProfile(user.id, {
        email,
        fullName,
        phone: normalizedPhone,
        role,
        status: 'active',
        profilePicture: '', // vacío no sobreescribe
      });

      await this.ensureUserMetadata(user.id, { role });

      return { ok: true, user_id: up.id };
    } catch (err: any) {
      if (err?.code || err?.response) this.mapPgError(err, 'signup_profile_failed');
      if (this.isKnownHttpException(err)) throw err;
      if (err instanceof AuthApiError) this.mapSupabaseError(err, 'signup_failed');
      throw new InternalServerErrorException('signup_failed');
    }
  }

  async login(email: string, password: string) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    try {
      const { data, error } = await this.pub.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });
      if (error) this.mapSupabaseError(error, 'login_failed');

      const user = data.user!;
      const roleMeta = (user.user_metadata as any)?.role || null;
      let role = roleMeta;
      if (!role) {
        role = await this.getRoleFromProfiles(user.id);
      }
      role = role ?? 'candidate';

      return {
        user: {
          id: user.id,
          email: user.email ?? normalizedEmail,
          role,
        },
        session: {
          access_token: data.session?.access_token ?? '',
          refresh_token: data.session?.refresh_token ?? '',
          token_type: 'bearer',
          expires_in: 3600,
        },
      };
    } catch (err: any) {
      if (this.isKnownHttpException(err)) throw err;
      if (err instanceof AuthApiError) this.mapSupabaseError(err, 'login_failed');
      throw new InternalServerErrorException('login_failed');
    }
  }

  async signupDirect(input: {
    email: string;
    password: string;
    fullName?: string;
    phone?: string;
    role?: UserRole;
  }) {
    const email = (input.email || '').trim().toLowerCase();
    const fullName = input.fullName ?? '';
    const normalizedPhone = this.normalizePhone(input.phone);
    const role = input.role ?? ('candidate' as UserRole);

    try {
      const { data, error } = await this.admin.auth.signUp({
        email,
        password: input.password,
        options: {
          data: {
            full_name: fullName ?? '',
            role: role ?? 'candidate',
            phone: normalizedPhone,
          },
        },
      });
      if (error) this.mapSupabaseError(error, 'signup_direct_failed');
      const user = data.user!;

      const up = await this.upsertProfile(user.id, {
        email,
        fullName,
        phone: normalizedPhone,
        role,
        status: 'active',
        profilePicture: '', // no sobreescribe
      });

      await this.ensureUserMetadata(user.id, { role });

      return { ok: true, user_id: up.id };
    } catch (err: any) {
      if (this.isKnownHttpException(err)) throw err;
      if (err instanceof AuthApiError) this.mapSupabaseError(err, 'signup_direct_failed');
      throw new InternalServerErrorException('signup_direct_failed');
    }
  }

  // 👉 Corrigido: NO llamamos a Google aquí.
  // Usamos el access_token de Supabase para obtener el usuario,
  // y evitamos sobreescribir el avatar si en la DB ya hay uno personalizado.
  async oauthLogin(accessToken: string) {
    try {
      if (!accessToken) throw new BadRequestException('missing_access_token');

      // 1) Obtener usuario desde Supabase con el access token (de Supabase)
      const { data, error } = await this.admin.auth.getUser(accessToken);
      if (error) this.mapSupabaseError(error, 'oauth_get_user_failed');

      const sbUser = data?.user;
      if (!sbUser) throw new UnauthorizedException('invalid_oauth_token');

      const email = (sbUser.email ?? '').trim().toLowerCase();

      // 2) Resolver role
      let role: string | null = (sbUser.user_metadata as any)?.role ?? null;
      if (!role) {
        const fromProfiles = await this.getRoleFromProfiles(sbUser.id);
        role = fromProfiles ?? 'candidate';
      }

      // 3) Consultar si el usuario YA tiene avatar personalizado en DB
      const { rows } = await this.pool.query(
        `SELECT profile_picture FROM public.profiles WHERE id = $1 LIMIT 1`,
        [sbUser.id],
      );
      const currentDbAvatar: string | null = rows?.[0]?.profile_picture ?? null;
      const hasCustomAvatar =
        currentDbAvatar && !this.isGoogleAvatar(currentDbAvatar);

      // 4) Decidir foto a aplicar
      const avatarFromSupabase = this.extractAvatarFromUser(sbUser);
      const profilePictureToApply = hasCustomAvatar ? '' : avatarFromSupabase;
      //    ↑ si hay avatar custom, mandamos '' para NO sobreescribir (NULLIF('', '') ⇒ NULL ⇒ mantiene valor)

      // 5) Upsert de perfil
      const up = await this.upsertProfile(sbUser.id, {
        email,
        fullName: (sbUser.user_metadata as any)?.full_name ?? '',
        phone: (sbUser.user_metadata as any)?.phone ?? '',
        role: role as UserRole,
        status: 'active',
        profilePicture: profilePictureToApply,
      });

      // 6) Sincroniza metadata (si aplica)
      const patch: any = { role };
      if (!hasCustomAvatar && avatarFromSupabase) {
        patch.picture = avatarFromSupabase;
      }
      await this.ensureUserMetadata(sbUser.id, patch);

      // 7) Respuesta
      return {
        user: {
          id: sbUser.id,
          email: sbUser.email ?? email,
          role: up.role ?? role ?? 'candidate',
        },
        session: {
          access_token: accessToken,
          refresh_token: '',
          token_type: 'bearer',
          expires_in: 3600,
        },
      };
    } catch (err: any) {
      if (this.isKnownHttpException(err)) throw err;
      throw new InternalServerErrorException('oauth_login_failed');
    }
  }

  isKnownHttpException(err: any): boolean {
    const names = new Set([
      'BadRequestException',
      'UnauthorizedException',
      'ForbiddenException',
      'NotFoundException',
      'ConflictException',
      'InternalServerErrorException',
    ]);
    return err && names.has(err.name);
  }
}
