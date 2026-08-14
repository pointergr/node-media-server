import { Module } from '@nestjs/common';
import { ServersService } from './servers.service';
import { ServersController } from './servers.controller';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [SyncModule],
  providers: [ServersService],
  controllers: [ServersController],
  // Το /me/series κάνει το ίδιο proxy προς τον stream server, φιλτραρισμένο.
  exports: [ServersService],
})
export class ServersModule {}
