import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SupabaseServer } from './supabase.server';
import { HttpAuthGuard } from './http-auth.guard';
import { AccessService } from './access.service';
import { DbModule } from '../db/db.module';

/**
 * HttpAuthGuard se registra como guard GLOBAL: toda ruta exige un token válido
 * salvo las marcadas explícitamente con @Public().
 */
@Global()
@Module({
  imports: [DbModule],
  providers: [
    SupabaseServer,
    HttpAuthGuard,
    AccessService,
    { provide: APP_GUARD, useExisting: HttpAuthGuard },
  ],
  exports: [SupabaseServer, HttpAuthGuard, AccessService],
})
export class AuthModule {}
