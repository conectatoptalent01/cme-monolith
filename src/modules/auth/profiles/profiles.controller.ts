import {
  Controller, Get, Post, Patch, Body, Query, Param,
  UseGuards, ValidationPipe, ParseUUIDPipe
} from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { SELF_ASSIGNABLE_ROLES } from '../auth-service.service';
import { SearchProfilesDto } from '../dto/search-profiles.dto';
import { HttpAuthGuard } from 'src/common/auth/http-auth.guard';
import { AuthUser } from '../../../common/auth/auth-user.decorator';

const queryPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: false,
});

const bodyPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: false,
});


/**
 * Lo que un usuario NO puede cambiarse a sí mismo: estado (activo/baneado), reputación
 * y el rol 'admin'. Antes PATCH /profiles/me aceptaba role='admin'.
 */
function sanitizeSelfProfile<T extends Record<string, any>>(body: T): T {
  const copy: any = { ...(body ?? {}) };
  delete copy.status;
  delete copy.reputation_score;
  delete copy.id;
  if (copy.role !== undefined && !(SELF_ASSIGNABLE_ROLES as readonly string[]).includes(copy.role)) {
    delete copy.role;
  }
  return copy;
}

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly svc: ProfilesService) {}

  @Get('search')
  searchGet(@Query(queryPipe) dto: SearchProfilesDto) {
    return this.svc.search(dto);
  }

  @Post('search')
  searchPost(@Body(bodyPipe) dto: SearchProfilesDto) {
    return this.svc.search(dto);
  }

  @UseGuards(HttpAuthGuard)
  @Get('me')
  getMe(@AuthUser() user: any) {
    return this.svc.findOne(user.id);
  }

  @UseGuards(HttpAuthGuard)
  @Post('me')
  upsertMe(
    @AuthUser() user: any,
    @Body() body: {
      email?: string; full_name?: string; phone?: string;
      role?: 'candidate'|'company_admin'|'headhunter'|'admin';
      status?: 'active'|'inactive'|'banned'|'pending';
      profile_picture?: string; cover_photo?: string; occupation?: string; about_me?: string;
      skills?: string[]; experience?: any; education?: any; cv_url?: string;
      reputation_score?: number;
    }
  ) {
    const payload = { ...sanitizeSelfProfile(body), email: user.email };
    return this.svc.upsert(user.id, payload);
  }

  @UseGuards(HttpAuthGuard)
  @Patch('me')
  patchMe(@AuthUser() user: any, @Body() patch: Record<string, any>) {
    return this.svc.updatePartial(user.id, sanitizeSelfProfile(patch));
  }

  /** El documento de identidad solo lo ve su dueño. */
  @Get(':id')
  async getById(@AuthUser() user: any, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const profile: any = await this.svc.findOne(id);
    if (profile && user?.id !== id) {
      delete profile.document_type;
      delete profile.document_id;
    }
    return profile;
  }
}
