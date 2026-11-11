import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth-service.service';
import { AuthUser } from '../../common/auth/auth-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { SELF_ASSIGNABLE_ROLES } from './auth-service.service';

type UserRole = 'candidate' | 'company_admin' | 'headhunter' | 'admin';

/** Rechaza roles que el usuario no puede elegir (p. ej. 'admin'). */
function assertSelfAssignableRole(role?: string) {
  if (role === undefined || role === null || role === '') return;
  if (!(SELF_ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    throw new BadRequestException('role_not_allowed');
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Public()
  @Post('signup')
  signup(
    @Body()
    body: {
      email: string;
      password: string;
      full_name?: string;
      phone?: string;
      role?: UserRole;
    },
  ) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('email_and_password_required');
    }
    assertSelfAssignableRole(body.role);
    return this.svc.signup({
      email: body.email,
      password: body.password,
      fullName: body.full_name ?? '',
      phone: body.phone ?? '',
      role: (body.role as UserRole) ?? 'candidate',
    });
  }

  @Public()
  @Post('login')
  login(
    @Body()
    body: {
      email: string;
      password: string;
    },
  ) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('email_and_password_required');
    }
    return this.svc.login(body.email, body.password);
  }

  @Public()
  @Post('signup-direct')
  signupDirect(
    @Body()
    body: {
      email: string;
      password: string;
      full_name?: string;
      phone?: string;
      role?: UserRole;
    },
  ) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('email_and_password_required');
    }
    assertSelfAssignableRole(body.role);
    return this.svc.signupDirect({
      email: body.email,
      password: body.password,
      fullName: body.full_name ?? '',
      phone: body.phone ?? '',
      role: (body.role as UserRole) ?? 'candidate',
    });
  }

  @Get('me')
  async me(@AuthUser() user: any) {
    const safeEmail = user?.email ?? '';

    const metaRole: string | null =
      (user?.user_metadata && user.user_metadata.role) || null;

    let role = metaRole;
    if (!role) {
      const fromProfiles = await this.svc.getRoleFromProfiles(user.id);
      role = fromProfiles ?? 'candidate';
    }

    return {
      id: user.id,
      email: safeEmail,
      role,
    };
  }

  @Public()
  @Post('oauth')
  async oauth(@Body() body: { access_token?: string }) {
    const token = body?.access_token;
    if (!token) {
      throw new BadRequestException('access_token_required');
    }
    return this.svc.oauthLogin(token);
  }
}
