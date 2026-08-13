import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from '../sync/sync.service';

// Ελάχιστο σχήμα του snapshot που στέλνει ο stream server (stats.js#snapshot) —
// μόνο ό,τι χρειάζεται εδώ, όχι όλο το contract.
interface StreamSnapshot {
  streams?: { stream: string; viewers: number }[];
}

@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
  ) {}

  // Χωρίς @Roles(): και ο admin περνάει (JwtAuthGuard αρκεί), αλλά δεν έχει
  // clientId — γυρίζει άδεια λίστα, δεν είναι λάθος του caller.
  @Get('streams')
  async streams(@Req() req: Request) {
    const clientId = req.user.clientId;
    if (!clientId) return [];

    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: { paths: true, server: true },
    });
    if (!client) return [];

    const live = this.sync.latest(client.server.host)?.snapshot as StreamSnapshot | undefined;
    const viewersOf = (path: string) => live?.streams?.find((s) => s.stream === path)?.viewers ?? 0;

    return client.paths.map((p) => ({
      // Το host το χρειάζεται το panel για να χτίσει και το URL αναπαραγωγής
      // (https://<host><path>/index.m3u8) και το rtmp:// του OBS — χωρίς αυτό
      // ο πελάτης βλέπει κλειδί που δεν ξέρει πού να το βάλει.
      host: client.server.host,
      path: p.path,
      key: p.key,
      streamKey: `${p.path.split('/').pop()}?key=${p.key}`,
      limit: client.limit,
      viewers: viewersOf(p.path),
    }));
  }
}
