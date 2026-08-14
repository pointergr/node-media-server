import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { SyncModule } from '../sync/sync.module';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [SyncModule, ServersModule],
  controllers: [MeController],
})
export class MeModule {}
