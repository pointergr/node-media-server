import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';
import { maxViewersOf, withPackages } from '../clients/clients.service';
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

    // Πελάτης «αυτού του server» = έχει αγορά εδώ ή (χωρίς πακέτα, άρα χωρίς
    // όριο) έχει path εδώ. Ο πελάτης ο ίδιος δεν ανήκει πουθενά — δες
    // schema.prisma. Τα paths φιλτράρονται κι αυτά: ο ίδιος πελάτης μπορεί να
    // έχει άλλα paths σε άλλο μηχάνημα, που δεν αφορούν αυτόν εδώ.
    const clients = await this.prisma.client.findMany({
      where: {
        disabled: false,
        OR: [{ packages: { some: { serverId: server.id } } }, { paths: { some: { serverId: server.id } } }],
      },
      include: { paths: { where: { serverId: server.id } }, ...withPackages },
    });

    const body: ClientsJson = {};
    for (const c of clients) {
      body[c.name] = {
        // Ο stream server δεν ξέρει τι είναι πακέτο: παίρνει έτοιμο νούμερο, όπως
        // πάντα. Το σχήμα του clients.json δεν άλλαξε ποτέ γι' αυτόν.
        limit: maxViewersOf(c.packages, server.id),
        paths: Object.fromEntries(c.paths.map((p) => [p.path, p.key])),
      };
    }
    return body;
  }
}
