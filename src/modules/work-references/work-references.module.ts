import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { WhatsAppSender } from '../invitations/whatsapp.sender';
import { WorkReferencesController } from './work-references.controller';
import { WorkReferencesService } from './work-references.service';

@Module({
  imports: [DbModule],
  controllers: [WorkReferencesController],
  providers: [WorkReferencesService, WhatsAppSender],
})
export class WorkReferencesModule {}
