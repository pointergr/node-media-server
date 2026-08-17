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

    // Μία εγγραφή ανά **συνδρομή**, όχι ανά πελάτη. Ο stream server ομαδοποιεί
    // τους θεατές ανά εγγραφή του clients.json (`config.js#clientOf`,
    // `stats.js#overLimit`), οπότε έτσι το όριο του κάθε πλάνου επιβάλλεται στα
    // δικά του paths και μόνο — χωρίς να αλλάξει γραμμή εκεί. Το κλειδί είναι
    // εσωτερικό (ο stream server δεν το δείχνει πουθενά), αλλά πρέπει να είναι
    // μοναδικό: δύο συνδρομές του ίδιου πελάτη θα έγραφαν η μία πάνω στην άλλη.
    const subs = await this.prisma.subscription.findMany({
      where: { serverId: server.id, client: { disabled: false } },
      include: { plan: true, paths: true, client: true },
    });

    const body: ClientsJson = {};
    for (const sub of subs) {
      body[`${sub.client.name}#${sub.id}`] = {
        // Ο stream server δεν ξέρει τι είναι πλάνο: παίρνει έτοιμο νούμερο, όπως
        // πάντα. Το σχήμα του clients.json δεν άλλαξε ποτέ γι' αυτόν.
        limit: sub.plan.maxViewers,
        paths: Object.fromEntries(sub.paths.map((p) => [p.path, p.key])),
      };
    }
    return body;
  }
}
