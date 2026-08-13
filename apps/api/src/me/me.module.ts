import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [SyncModule],
  controllers: [MeController],
})
export class MeModule {}
