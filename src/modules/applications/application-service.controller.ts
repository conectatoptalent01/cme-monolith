import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { ApplicationsService } from './application-service.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { QueryApplicationsDto } from './dto/query-applications.dto';
import { AuthUser } from 'src/common/auth/auth-user.decorator';
import { AccessService } from 'src/common/auth/access.service';

@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly service: ApplicationsService,
    private readonly access: AccessService,
  ) {}

  /** Un candidato solo postula por sí mismo. */
  @Post()
  async create(@AuthUser() user: any, @Body() dto: CreateApplicationDto) {
    await this.access.assertSelfOrAdmin(user, dto.candidateId);
    return this.service.create(dto);
  }

  /**
   * Listar por candidato: solo el propio candidato, la empresa dueña de la vacante filtrada o un admin.
   * Listar solo por vacante: sigue abierto a usuarios con sesión (se restringe en la Fase 3,
   * cuando se rehaga el flujo de referidos y privacidad).
   */
  @Get()
  async list(@AuthUser() user: any, @Query() q: QueryApplicationsDto) {
    if (q.candidateId && q.candidateId !== this.access.userId(user)) {
      const ownsJob = q.jobOfferId
        ? await this.access.isCompanyAdmin(user, await this.access.companyOfJob(q.jobOfferId))
        : false;
      if (!ownsJob && !(await this.access.isAdmin(user))) {
        throw new ForbiddenException('not_allowed_for_other_user');
      }
    }
    return this.service.list(q);
  }

  @Get(':id')
  async findOne(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.assertParty(user, id);
    return this.service.findOne(id);
  }

  /** Aceptar o anotar una postulación: la empresa dueña de la vacante (o admin). El candidato solo edita sus notas. */
  @Patch(':id')
  async update(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateApplicationDto,
  ) {
    const ctx = await this.access.applicationContext(id);
    const isCandidate = ctx.candidate_id === this.access.userId(user);
    const ownsJob = await this.access.isCompanyAdmin(user, ctx.company_id);
    if (ownsJob || (await this.access.isAdmin(user))) return this.service.update(id, dto);
    if (isCandidate) {
      if (dto.accepted !== undefined) throw new ForbiddenException('only_company_can_accept');
      return this.service.update(id, dto);
    }
    throw new ForbiddenException('not_application_party');
  }

  @Delete(':id')
  async remove(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.assertParty(user, id);
    return this.service.remove(id);
  }

  private async assertParty(user: any, id: string) {
    const ctx = await this.access.applicationContext(id);
    if (ctx.candidate_id === this.access.userId(user)) return;
    await this.access.assertCompanyAdmin(user, ctx.company_id);
  }
}
