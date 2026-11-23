import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { ReputationController } from './reputation.controller';
import { ReputationService } from './reputation.service';

@Module({
  imports: [DbModule],
  controllers: [ReputationController],
  providers: [ReputationService],
})
export class ReputationModule {}
