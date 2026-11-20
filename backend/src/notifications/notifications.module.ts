import { Controller, Get, HttpCode, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowWhenReadOnly, CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { listNotificationsQuery, NotificationsService, type ListNotificationsQuery } from './notifications.service.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermissions('tenant:read')
  @ApiOperation({
    summary: 'Your notifications',
    description:
      'Alerts you can act on (by your role and branches): stock, orders, khata, drawers, payments, offline bills, supplier dues, goods received, subscription and staff. Kept in step with the data; `unread` is your unread count.',
  })
  list(@CurrentAuth() auth: AuthContext, @Query({ schema: listNotificationsQuery }) q: ListNotificationsQuery) {
    return this.notifications.list(auth, q);
  }

  @Post('read-all')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @RequirePermissions('tenant:read')
  @ApiOperation({ summary: 'Mark all your notifications read' })
  readAll(@CurrentAuth() auth: AuthContext) {
    return this.notifications.markAllRead(auth);
  }

  @Post(':id/read')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @RequirePermissions('tenant:read')
  @ApiOperation({ summary: 'Mark one notification read' })
  read(@CurrentAuth() auth: AuthContext, @Param('id', { schema: uuidParam }) id: string) {
    return this.notifications.markRead(auth, id);
  }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
