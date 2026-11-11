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
  ValidationPipe,
  NotFoundException,
} from '@nestjs/common';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { SearchCompaniesDto } from './dto/search-companies.dto';
import { CompaniesService } from './company-service.service';
import { AuthUser } from 'src/common/auth/auth-user.decorator';
import { AccessService } from 'src/common/auth/access.service';

/** Campos que solo un administrador de CME puede fijar (verificación, plan, rating). */
const ADMIN_ONLY_FIELDS = ['companyRating', 'boolVerified', 'verifiedAt', 'subscriptionPlan'] as const;

function stripAdminOnly<T extends Record<string, any>>(dto: T): T {
  const copy: any = { ...dto };
  for (const k of ADMIN_ONLY_FIELDS) delete copy[k];
  return copy;
}

const bodyPipe = new ValidationPipe({
  transform: true,
  whitelist: false,
  forbidNonWhitelisted: false,
});

const queryPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: false,
});

@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly service: CompaniesService,
    private readonly access: AccessService,
  ) { }

  @Get()
  list(@Query('limit') limit = 50, @Query('offset') offset = 0) {
    return this.service.list(Number(limit), Number(offset));
  }

  @Get('search')
  async search(@Query(queryPipe) dto: SearchCompaniesDto) {
    const items = await this.service.search(dto as any);
    return Array.isArray(items) ? items : { items };
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.service.getById(id);
    if (!row) throw new NotFoundException('Company not found');
    return row;
  }

  @Post()
  async create(@AuthUser() user: any, @Body(bodyPipe) dto: CreateCompanyDto) {
    if (await this.access.isAdmin(user)) return this.service.create(dto);
    // Un usuario normal solo puede crear empresas a su propio nombre.
    return this.service.create({ ...stripAdminOnly(dto), adminId: this.access.userId(user) });
  }

  @Patch(':id')
  async update(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(bodyPipe) dto: UpdateCompanyDto,
  ) {
    await this.access.assertCompanyAdmin(user, id);
    const patch = (await this.access.isAdmin(user)) ? dto : stripAdminOnly(dto);
    return this.service.update(id, patch);
  }

  @Delete(':id')
  async remove(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.access.assertCompanyAdmin(user, id);
    return this.service.remove(id);
  }

  @Get('by-admin/:adminId')
  async byAdmin(@Param('adminId', new ParseUUIDPipe()) adminId: string) {
    const row = await this.service.findByAdminId(adminId);
    if (!row) throw new NotFoundException('Company not found for this admin');
    return row;
  }
}
