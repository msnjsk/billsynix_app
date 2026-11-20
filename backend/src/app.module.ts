import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ConfigModule } from './config/config.module.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { validationPipe } from './common/validation.js';
import { HealthModule } from './health/health.module.js';
import { AuditModule } from './audit/audit.module.js';
import { MailModule } from './mail/mail.module.js';
import { AccessModule } from './access/access.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { StoresModule } from './stores/stores.module.js';
import { MembershipsModule } from './memberships/memberships.module.js';
import { StorageModule } from './storage/storage.module.js';
import { CatalogueModule } from './catalogue/catalogue.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { PurchasingModule } from './purchasing/purchasing.module.js';
import { SalesModule } from './sales/sales.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SyncModule } from './sync/sync.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    AuditModule,
    MailModule,
    AccessModule,
    AuthModule,
    HealthModule,
    TenantsModule,
    StoresModule,
    MembershipsModule,
    StorageModule,
    CatalogueModule,
    InventoryModule,
    PurchasingModule,
    SalesModule,
    ReportsModule,
    SyncModule,
    SubscriptionsModule,
    FinanceModule,
    OrdersModule,
    NotificationsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useFactory: validationPipe },
  ],
})
export class AppModule {}
