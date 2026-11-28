import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notification-service.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { AuthUser } from 'src/common/auth/auth-user.decorator';
import { AccessService } from 'src/common/auth/access.service';

function normalizeCreateBody(raw: any): CreateNotificationDto {
  const src = raw?.input ?? raw ?? {};
  const dto: CreateNotificationDto = {
    userId: src.userId ?? src.user_id,
    title: src.title,
    message: src.message,
    notificationType: src.notificationType ?? src.notification_type,
    channel: src.channel ?? 'email',
    relatedId: src.relatedId ?? src.related_id ?? undefined,
  } as any;

  if (!dto.userId || !dto.title || !dto.message || !dto.notificationType) {
    throw new BadRequestException('Missing required fields (userId, title, message, notificationType)');
  }
  return dto;
}

function normalizeQuery(q: any): QueryNotificationsDto {
  const out: QueryNotificationsDto = {
    userId: q.userId ?? q.user_id,
    status: q.status,
    notificationType: q.notificationType ?? q.type,
    offset: q.offset ? Number(q.offset) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  } as any;
  return out;
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly service: NotificationsService,
    private readonly access: AccessService,
  ) { }

  @Post()
  create(@Body() raw: any) {
    const dto = normalizeCreateBody(raw);
    return this.service.create(dto);
  }

  /** Cada usuario ve solo sus notificaciones (un admin puede filtrar por cualquiera). */
  @Get()
  async list(@AuthUser() user: any, @Query() q: any) {
    const nq = normalizeQuery(q);
    if (!(await this.access.isAdmin(user))) nq.userId = this.access.userId(user);
    return this.service.list(nq);
  }

  @Get(':id')
  async findOne(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.access.assertSelfOrAdmin(user, await this.access.notificationOwner(id));
    return this.service.findOne(id);
  }

  @Patch(':id/read')
  async markRead(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.access.assertSelfOrAdmin(user, await this.access.notificationOwner(id));
    return this.service.markRead(id);
  }

  /** Reenviar por email: solo admin (el frontend no lo usa). */
  @Post(':id/dispatch')
  async dispatch(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.access.assertAdmin(user);
    return this.service.dispatchOneById(id);
  }
}
