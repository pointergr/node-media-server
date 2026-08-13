import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ServersService, CreateServerDto, UpdateServerDto } from './servers.service';
import { SyncService } from '../sync/sync.service';
import { Roles } from '../auth/roles.decorator';

@Roles('admin')
@Controller()
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly sync: SyncService,
  ) {}

  // Το τελευταίο snapshot όλων των servers, από τη μνήμη — άδειο αμέσως μετά
  // από restart του API (δες SyncService).
  @Get('live')
  live() {
    return this.sync.all();
  }

  @Get('servers')
  list() {
    return this.servers.list();
  }

  @Post('servers')
  create(@Body() body: Partial<CreateServerDto>) {
    if (!body.host || !body.adminUrl || !body.adminUser || !body.adminPass) {
      throw new BadRequestException('host, adminUrl, adminUser, adminPass απαιτούνται');
    }
    return this.servers.create(body as CreateServerDto);
  }

  @Get('servers/:id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.servers.get(id);
  }

  @Patch('servers/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateServerDto) {
    return this.servers.update(id, body);
  }

  @Delete('servers/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.servers.remove(id);
  }

  @Get('servers/:host/series')
  series(@Param('host') host: string, @Query('range') range?: string) {
    const qs = range ? `?range=${encodeURIComponent(range)}` : '';
    return this.servers.proxy(host, `/admin/api/series${qs}`);
  }

  @Delete('servers/:host/sessions/:id')
  killSession(@Param('host') host: string, @Param('id') id: string) {
    return this.servers.proxy(host, `/admin/api/sessions/${encodeURIComponent(id)}`, 'DELETE');
  }
}
