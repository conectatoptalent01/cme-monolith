import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './common/db/db.module';
import { AuthServiceModule } from './modules/auth/auth-service.module';
import { JobServiceModule } from './modules/jobs/job-service.module';
import { ApplicationServiceModule } from './modules/applications/application-service.module';
import { PaymentServiceModule } from './modules/payments/payment-service.module';
import { NotificationServiceModule } from './modules/notifications/notification-service.module';
import { ReferralServiceModule } from './modules/referrals/referral-service.module';
import { UploadsModule } from './modules/uploads/uploads-service.module';
import { AuthModule } from './common/auth/auth.module';
import { CompanyServiceModule } from './modules/companies/company-service.module';
import { HealthModule } from './common/health/health.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    AuthModule,
    AuthServiceModule,
    CompanyServiceModule,
    JobServiceModule,
    ApplicationServiceModule,
    PaymentServiceModule,
    NotificationServiceModule,
    ReferralServiceModule,
    InvitationsModule,
    UploadsModule,
    HealthModule,
  ],
  providers: [AppService],
  controllers: [AppController]
})
export class AppModule { }
