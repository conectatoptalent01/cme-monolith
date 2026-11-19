import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { WhatsAppSender } from './whatsapp.sender';

@Module({
  imports: [DbModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, WhatsAppSender],
})
export class InvitationsModule {}
