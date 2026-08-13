import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';
import { ServerTokenGuard } from './server-token.guard';
import { Public } from '../auth/public.decorator';

// Μορφή που περιμένει ο loader του stream server (clients.json) —
// PLAN-multitenant.md, Φάση 1.
type ClientsJson = Record<string, { limit: number; paths: Record<string, string> }>;

@Controller('servers')
export class SyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
  ) {}

  @Public()
  @UseGuards(ServerTokenGuard)
  @HttpCode(200)
  @Post(':host/sync')
  async receive(@Param('host') host: string, @Body() snapshot: unknown, @Req() req: Request) {
    const server = req.server!; // το έβαλε το ServerTokenGuard

    this.sync.record(host, snapshot);
    await this.prisma.server.update({ where: { id: server.id }, data: { lastSeen: new Date() } });

    const clients = await this.prisma.client.findMany({
      where: { serverId: server.id, disabled: false },
      include: { paths: true },
    });

    const body: ClientsJson = {};
    for (const c of clients) {
      body[c.name] = {
        limit: c.limit,
        paths: Object.fromEntries(c.paths.map((p) => [p.path, p.key])),
      };
    }
    return body;
  }
}
