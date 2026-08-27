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
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ServersService, CreateServerDto, UpdateServerDto } from './servers.service';
import { SyncService } from '../sync/sync.service';
import { Roles } from '../auth/roles.decorator';
import { humanOnly } from '../auth/human-only';

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

  // Το ιστορικό συνδέσεων ζει στο sqlite του κάθε stream server — proxy, όχι
  // αντιγραφή: server κάτω σημαίνει ούτως ή άλλως ότι δεν έχεις τι να δεις.
  @Get('servers/:host/sessions')
  sessions(@Param('host') host: string) {
    return this.servers.proxy(host, '/admin/api/sessions');
  }

  // Οι τελευταίες γραμμές της κονσόλας του stream server (ring buffer στη μνήμη
  // του, apps/stream/stats.js). Ο λόγος που υπάρχει: χωρίς αυτό το «γιατί πέθανε
  // ο ffmpeg» ζητάει ssh στο μηχάνημα — και το πού γράφεται το log έχει άλλη
  // απάντηση σε pm2 και άλλη σε docker.
  @Get('servers/:host/logs')
  logs(@Param('host') host: string) {
    return this.servers.proxy(host, '/admin/api/logs');
  }

  // Ο stream server απαντάει 202 και τερματίζει μετά· τον ξανασηκώνει ο
  // supervisor του (pm2 / restart policy), όχι εμείς.
  // humanOnly: ένα provisioning key φτιάχνει πελάτες και servers, δεν ρίχνει
  // εκπομπές που παίζουν — δες auth/human-only.ts.
  @Post('servers/:host/restart')
  restart(@Req() req: Request, @Param('host') host: string) {
    humanOnly(req);
    return this.servers.proxy(host, '/admin/api/restart', 'POST');
  }

  @Delete('servers/:host/sessions/:id')
  killSession(@Req() req: Request, @Param('host') host: string, @Param('id') id: string) {
    humanOnly(req);
    return this.servers.proxy(host, `/admin/api/sessions/${encodeURIComponent(id)}`, 'DELETE');
  }
}
