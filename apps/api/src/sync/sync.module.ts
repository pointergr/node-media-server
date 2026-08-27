import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { ServerTokenGuard } from './server-token.guard';

@Module({
  providers: [SyncService, ServerTokenGuard],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
