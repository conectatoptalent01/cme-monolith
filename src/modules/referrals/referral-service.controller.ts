import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ReferralsService } from './referral-service.service';
import { CreateReferralDto } from './dto/create-referral.dto';
import { UpdateReferralDto } from './dto/update-referral.dto';
import { QueryReferralsDto } from './dto/query-referrals.dto';
import { UpdateReferralStatusDto } from './dto/update-referral-status.dto';
import { AuthUser } from 'src/common/auth/auth-user.decorator';
import { AccessService } from 'src/common/auth/access.service';

type ReferralStatus =
  | 'submitted'
  | 'accepted_by_candidate'
  | 'declined_by_candidate'
  | 'reviewing'
  | 'rejected'
  | 'shortlist'
  | 'hired';

/** Estados que decide el candidato sobre su propio referido. */
const CANDIDATE_STATUSES: ReadonlySet<string> = new Set(['accepted_by_candidate', 'declined_by_candidate']);
/** Estados que decide la empresa dueña de la vacante. */
const COMPANY_STATUSES: ReadonlySet<string> = new Set(['reviewing', 'rejected', 'shortlist', 'hired']);

@Controller('referrals')
export class ReferralsController {
  constructor(
    private readonly service: ReferralsService,
    private readonly access: AccessService,
  ) { }

  /** Cada referidor crea referidos a su propio nombre. */
  @Post()
  async create(@AuthUser() user: any, @Body() dto: CreateReferralDto) {
    await this.access.assertSelfOrAdmin(user, dto.headhunterId);
    return this.service.create(dto);
  }

  /**
   * Listado general (por vacante / código): sigue abierto a usuarios con sesión porque
   * el flujo actual de "canjear código" lo necesita. Se restringe en la Fase 3.
   */
  @Get()
  list(@Query() q: QueryReferralsDto) {
    return this.service.list(q);
  }

  @Get('by-headhunter/:headhunterId')
  async listByHeadhunter(
    @AuthUser() user: any,
    @Param('headhunterId', new ParseUUIDPipe()) headhunterId: string,
    @Query() q: QueryReferralsDto,
  ) {
    await this.access.assertSelfOrAdmin(user, headhunterId);
    return this.service.listByHeadhunter(headhunterId, q);
  }

  @Get('by-candidate/:candidateId')
  async listByCandidate(
    @AuthUser() user: any,
    @Param('candidateId', new ParseUUIDPipe()) candidateId: string,
    @Query() q: QueryReferralsDto,
  ) {
    await this.access.assertSelfOrAdmin(user, candidateId);
    return this.service.listByCandidate(candidateId, q);
  }

  @Get(':id')
  async findOne(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const ctx = await this.access.referralContext(id);
    const me = this.access.userId(user);
    if (ctx.headhunter_id !== me && ctx.candidate_id !== me) {
      await this.access.assertCompanyAdmin(user, ctx.company_id);
    }
    return this.service.findOne(id);
  }

  @Patch(':id/status')
  async updateStatus(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReferralStatusDto,
  ) {
    await this.assertCanSetStatus(user, id, dto.status);
    return this.service.updateStatus(id, dto.status);
  }

  /**
   * Usos actuales:
   *  - el candidato "canjea" un referido libre (candidateId = él mismo) y lo acepta;
   *  - la empresa cambia el estado.
   */
  @Patch(':id')
  async update(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReferralDto,
  ) {
    const ctx = await this.access.referralContext(id);
    const me = this.access.userId(user);
    const isAdmin = await this.access.isAdmin(user);

    if (dto.candidateId !== undefined && !isAdmin) {
      const claimingForSelf = dto.candidateId === me;
      const unclaimedOrMine = !ctx.candidate_id || ctx.candidate_id === me;
      if (!claimingForSelf || !unclaimedOrMine) {
        throw new ForbiddenException('cannot_assign_candidate');
      }
    }

    if (dto.status !== undefined) {
      // si en este mismo cambio el usuario se asigna como candidato, se evalúa como candidato
      const effective = { ...ctx, candidate_id: dto.candidateId ?? ctx.candidate_id };
      await this.assertStatusAllowed(user, effective, dto.status);
    } else if (dto.candidateId === undefined && !isAdmin) {
      throw new ForbiddenException('nothing_to_update');
    }

    return this.service.update(id, dto);
  }

  @Post('update-status')
  async updateStatusLegacy(@AuthUser() user: any, @Body() body: { id: string; status: ReferralStatus }) {
    await this.assertCanSetStatus(user, body.id, body.status);
    return this.service.updateStatus(body.id, body.status);
  }

  /** Solo quien creó el referido (o un admin) puede borrarlo. */
  @Delete(':id')
  async remove(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const ctx = await this.access.referralContext(id);
    await this.access.assertSelfOrAdmin(user, ctx.headhunter_id);
    return this.service.remove(id);
  }

  /* ---------------------------------------------------------------- */

  private async assertCanSetStatus(user: any, id: string, status: string) {
    const ctx = await this.access.referralContext(id);
    await this.assertStatusAllowed(user, ctx, status);
  }

  private async assertStatusAllowed(
    user: any,
    ctx: { candidate_id: string | null; company_id: string },
    status: string,
  ) {
    if (await this.access.isAdmin(user)) return;
    const me = this.access.userId(user);
    if (CANDIDATE_STATUSES.has(status) && ctx.candidate_id === me) return;
    if (COMPANY_STATUSES.has(status) && (await this.access.isCompanyAdmin(user, ctx.company_id))) return;
    throw new ForbiddenException('status_change_not_allowed');
  }
}
