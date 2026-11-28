import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './auth-service.controller';
import { AuthService } from './auth-service.service';
import { ProfilesController } from './profiles/profiles.controller';
import { ProfilesService } from './profiles/profiles.service';
import { AuthModule } from 'src/common/auth/auth.module';
import { DbModule } from 'src/common/db/db.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', 'apps/auth-service/.env'],
    }),
    AuthModule,
    DbModule,
  ],
  controllers: [AuthController, ProfilesController],
  providers: [AuthService, ProfilesService],
})
export class AuthServiceModule { }
