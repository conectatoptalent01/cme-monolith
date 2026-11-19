import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AuthUser } from '../../common/auth/auth-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { AccessService } from '../../common/auth/access.service';
import { InvitationsService } from './invitations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly service: InvitationsService,
    private readonly access: AccessService,
  ) {}

  /** Referir a alguien sin cuenta: nombre, apellido y teléfono. Se le invita por WhatsApp. */
  @Post()
  create(@AuthUser() user: any, @Body() dto: CreateInvitationDto) {
    return this.service.create(this.access.userId(user), dto);
  }

  /** Página pública del enlace: muestra la vacante y quién recomienda (sin datos personales). */
  @Public()
  @Get(':token')
  getPublic(@Param('token') token: string) {
    return this.service.getPublic(token);
  }

  /** Rechazar no requiere cuenta. Se borran nombre y teléfono del invitado. */
  @Public()
  @Post(':token/decline')
  decline(@Param('token') token: string) {
    return this.service.decline(token);
  }

  /** Aceptar requiere iniciar sesión o registrarse. */
  @Post(':token/accept')
  accept(@AuthUser() user: any, @Param('token') token: string) {
    return this.service.accept(token, this.access.userId(user));
  }
}
