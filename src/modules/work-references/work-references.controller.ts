import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthUser } from '../../common/auth/auth-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { AccessService } from '../../common/auth/access.service';
import { WorkReferencesService } from './work-references.service';

class CreateWorkReferenceDto {
  @IsString() @Length(1, 120) referenceName!: string;
  @IsString() @Length(1, 120) companyName!: string;
  /** Ej. "Mi jefe directo", "Gerente de operaciones". */
  @IsString() @Length(1, 120) relationship!: string;
  @IsString() @Length(7, 25) phone!: string;
}

class RespondDto {
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

@Controller('work-references')
export class WorkReferencesController {
  constructor(
    private readonly service: WorkReferencesService,
    private readonly access: AccessService,
  ) {}

  /** El candidato agrega una referencia laboral (máximo 3). Se le pide confirmación por WhatsApp. */
  @Post()
  create(@AuthUser() user: any, @Body() dto: CreateWorkReferenceDto) {
    return this.service.create(this.access.userId(user), dto);
  }

  @Get('mine')
  mine(@AuthUser() user: any) {
    return this.service.listMine(this.access.userId(user));
  }

  @Delete(':id')
  remove(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.removePending(this.access.userId(user), id);
  }

  /** Referencias confirmadas de un candidato (para la empresa que lo está evaluando). */
  @Get('candidate/:candidateId')
  async forCandidate(@AuthUser() user: any, @Param('candidateId', new ParseUUIDPipe()) candidateId: string) {
    return this.service.confirmedForCandidate(candidateId, {
      id: this.access.userId(user),
      isAdmin: await this.access.isAdmin(user),
    });
  }

  /* --------- Página pública del enlace que recibe la referencia --------- */

  @Public()
  @Get('public/:token')
  getPublic(@Param('token') token: string) {
    return this.service.getPublic(token);
  }

  @Public()
  @Post('public/:token/confirm')
  confirm(@Param('token') token: string, @Body() body: RespondDto) {
    return this.service.respond(token, true, body?.comment);
  }

  @Public()
  @Post('public/:token/decline')
  decline(@Param('token') token: string) {
    return this.service.respond(token, false);
  }
}
