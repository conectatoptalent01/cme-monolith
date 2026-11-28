import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JobServiceService } from './job-service.service';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { QuerySearchJobsDto } from './dto/query-search-jobs.dto';
import { AuthUser } from 'src/common/auth/auth-user.decorator';
import { AccessService } from 'src/common/auth/access.service';



function asArray(v: any): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string' && v.length) return [v];
  return undefined;
}
function toNum(v: any): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}


@Controller('jobs')
export class JobServiceController {
  constructor(
    private readonly jobService: JobServiceService,
    private readonly access: AccessService,
  ) { }

  @Get()
  list(
    @Query('status') status?: string,
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
  ) {
    return this.jobService.list({
      status,
      limit: Number(limit),
      offset: Number(offset),
    });
  }

  @Get('search')
  async search(@Query() raw: any) {
    const skillsAny = asArray(raw.skillsAny ?? raw['skillsAny[]']);
    const skillsAll = asArray(raw.skillsAll ?? raw['skillsAll[]']);

    const q: QuerySearchJobsDto = {
      q: raw.q,
      employmentType: raw.employmentType,
      locationType: raw.locationType,
      location: raw.location,
      companyId: raw.companyId,
      status: raw.status,
      minSalary: toNum(raw.minSalary),
      maxSalary: toNum(raw.maxSalary),
      skillsAny,
      skillsAll,
      orderBy: raw.orderBy,
      limit: toNum(raw.limit) ?? 20,
      offset: toNum(raw.offset) ?? 0,
    };

    if (process.env.DEBUG_JOBS) {
      console.log('[JOBS /search] raw=', raw);
      console.log('[JOBS /search] normalized=', q);
    }

    return this.jobService.search(q);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.jobService.findOne(id);
  }

  @Post()
  async create(@AuthUser() user: any, @Body() body: CreateJobDto) {
    // Solo el administrador de la empresa publica vacantes a nombre de ella.
    await this.access.assertCompanyAdmin(user, body.companyId);
    return this.jobService.create(body);
  }

  @Patch(':id')
  async update(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() patch: UpdateJobDto,
  ) {
    await this.access.assertJobOwner(user, id);
    const anyPatch = patch as any;
    if (anyPatch?.companyId !== undefined) {
      // mover una vacante a otra empresa exige ser admin también de la empresa destino
      await this.access.assertCompanyAdmin(user, anyPatch.companyId);
    }
    return this.jobService.update(id, patch);
  }

  @Delete(':id')
  async remove(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.access.assertJobOwner(user, id);
    return this.jobService.remove(id);
  }
}
