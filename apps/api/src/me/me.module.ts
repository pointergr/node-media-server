import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { SyncModule } from '../sync/sync.module';
import { ServersModule } from '../servers/servers.module';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [SyncModule, ServersModule, ClientsModule],
  controllers: [MeController],
})
export class MeModule {}
