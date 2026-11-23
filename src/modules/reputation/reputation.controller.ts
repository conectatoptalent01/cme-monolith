import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser } from '../../common/auth/auth-user.decorator';
import { AccessService } from '../../common/auth/access.service';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ReputationService } from './reputation.service';

class StarsDto {
  @IsInt() @Min(1) @Max(5)
  stars!: number;

  @IsOptional() @IsString() @MaxLength(500)
  comment?: string;
}

@Controller()
export class ReputationController {
  constructor(
    private readonly service: ReputationService,
    private readonly access: AccessService,
  ) {}

  /* ---------------------- Rating del referidor ---------------------- */

  /** La empresa dueña de la vacante califica a quien recomendó (tras shortlist, rechazo o contratación). */
  @Post('referrals/:id/rating')
  async rateReferral(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: StarsDto,
  ) {
    return this.service.rateReferral(
      id,
      { id: this.access.userId(user), isAdmin: await this.access.isAdmin(user) },
      body ?? ({} as any),
    );
  }

  @Get('reputation/referrers/:userId')
  referrer(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.service.referrerSummary(userId);
  }

  @Get('reputation/me')
  me(@AuthUser() user: any) {
    return this.service.referrerSummary(this.access.userId(user));
  }

  /* ------------------------ Socio Reclutador ------------------------ */

  @Post('partner-applications')
  apply(@AuthUser() user: any, @Body() body: { message?: string }) {
    return this.service.applyForPartner(this.access.userId(user), body?.message);
  }

  @Get('partner-applications/me')
  mine(@AuthUser() user: any) {
    return this.service.myPartnerApplications(this.access.userId(user));
  }

  /** Panel de admin. */
  @Get('partner-applications')
  async list(@AuthUser() user: any, @Query('status') status?: string) {
    await this.access.assertAdmin(user);
    return this.service.listPartnerApplications(status);
  }

  @Post('partner-applications/:id/approve')
  async approve(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { note?: string },
  ) {
    await this.access.assertAdmin(user);
    return this.service.reviewPartnerApplication(id, this.access.userId(user), true, body?.note);
  }

  @Post('partner-applications/:id/reject')
  async reject(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { note?: string },
  ) {
    await this.access.assertAdmin(user);
    return this.service.reviewPartnerApplication(id, this.access.userId(user), false, body?.note);
  }

  /* ---------------------- Calificación de empresas ------------------ */

  @Get('companies/:id/rating')
  companyRating(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.companyRating(id, this.access.userId(user));
  }

  @Post('companies/:id/rating')
  rateCompany(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: StarsDto,
  ) {
    return this.service.rateCompany(id, this.access.userId(user), body ?? ({} as any));
  }
}
