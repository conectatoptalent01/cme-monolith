/// <reference types="jest" />
import 'reflect-metadata';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { HttpAuthGuard } from './http-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';

import { AppController } from '../../app.controller';
import { HealthController } from '../health/health.controller';
import { AuthController } from '../../modules/auth/auth-service.controller';
import { ProfilesController } from '../../modules/auth/profiles/profiles.controller';
import { CompaniesController } from '../../modules/companies/company-service.controller';
import { JobServiceController } from '../../modules/jobs/job-service.controller';
import { ApplicationsController } from '../../modules/applications/application-service.controller';
import { PaymentServiceController } from '../../modules/payments/payment-service.controller';
import { NotificationsController } from '../../modules/notifications/notification-service.controller';
import { ReferralsController } from '../../modules/referrals/referral-service.controller';
import { UploadsSelfController } from '../../modules/uploads/uploads-self.controller';

const CONTROLLERS = [
  AppController, HealthController, AuthController, ProfilesController, CompaniesController,
  JobServiceController, ApplicationsController, PaymentServiceController,
  NotificationsController, ReferralsController, UploadsSelfController,
];

/** Las ÚNICAS rutas que deben responder sin login. Agregar una aquí debe ser una decisión consciente. */
const EXPECTED_PUBLIC = [
  'GET /',
  'GET /healthz',
  'POST /auth/signup',
  'POST /auth/login',
  'POST /auth/signup-direct',
  'POST /auth/oauth',
  'POST /payments/webhook',
].sort();

const METHOD_NAMES: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH' };

function publicRoutes(): string[] {
  const out: string[] = [];
  for (const ctrl of CONTROLLERS) {
    const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '').replace(/^\/|\/$/g, '');
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctrl) === true;
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = ctrl.prototype[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      if (path === undefined) continue;
      const isPublic = classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
      if (!isPublic) continue;
      const method = METHOD_NAMES[Reflect.getMetadata('method', handler)] ?? '?';
      const full = '/' + [base, String(path).replace(/^\/|\/$/g, '')].filter(Boolean).join('/');
      out.push(`${method} ${full}`);
    }
  }
  return out.sort();
}

describe('Rutas públicas', () => {
  it('solo las rutas esperadas responden sin login', () => {
    expect(publicRoutes()).toEqual(EXPECTED_PUBLIC);
  });
});

describe('HttpAuthGuard', () => {
  const ctxFor = (handler: any, headers: Record<string, string> = {}) => {
    const req: any = { headers };
    return {
      ctx: {
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext,
      req,
    };
  };

  const supabase: any = {
    getUserFromToken: jest.fn(async (t: string) => ({ user: t === 'good' ? { id: 'u1' } : null })),
  };
  const guard = new HttpAuthGuard(supabase, new Reflector());

  it('deja pasar una ruta @Public sin token', async () => {
    const { ctx } = ctxFor(PaymentServiceController.prototype.mpWebhook);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rechaza una ruta privada sin token', async () => {
    const { ctx } = ctxFor(PaymentServiceController.prototype.update);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza un token inválido', async () => {
    const { ctx } = ctxFor(PaymentServiceController.prototype.update, { authorization: 'Bearer bad' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('acepta un token válido y deja el usuario en la petición', async () => {
    const { ctx, req } = ctxFor(PaymentServiceController.prototype.update, { authorization: 'Bearer good' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'u1' });
  });
});
