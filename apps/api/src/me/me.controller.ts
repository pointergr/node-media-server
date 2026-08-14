import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from '../sync/sync.service';
import { ServersService } from '../servers/servers.service';

// Ελάχιστο σχήμα του snapshot που στέλνει ο stream server (stats.js#snapshot) —
// μόνο ό,τι χρειάζεται εδώ, όχι όλο το contract.
interface StreamSnapshot {
  streams?: { stream: string; viewers: number; since?: number; in_bps?: number }[];
}

// Ό,τι γυρίζει το /admin/api/series του stream server. Το `server` (CPU, μνήμη)
// υπάρχει κι αυτό στην απάντηση αλλά δεν το ζητάμε ποτέ εδώ — δες series().
interface Series {
  bucket: number;
  from: number;
  streams?: { t: number; stream: string; in_bps: number; out_bps: number; viewers: number }[];
}

@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
    private readonly servers: ServersService,
  ) {}

  // Ο πελάτης και τα paths του σε μία ερώτηση: κάθε endpoint εδώ ξεκινάει από το
  // clientId του token, ποτέ από παράμετρο του caller — αυτό είναι όλο το
  // φιλτράρισμα που στέκεται ανάμεσα σε δύο πελάτες του ίδιου server.
  private mine(clientId: number | null) {
    if (!clientId) return null;
    return this.prisma.client.findUnique({
      where: { id: clientId },
      include: { paths: true, server: true },
    });
  }

  // Χωρίς @Roles(): και ο admin περνάει (JwtAuthGuard αρκεί), αλλά δεν έχει
  // clientId — γυρίζει άδεια λίστα, δεν είναι λάθος του caller.
  @Get('streams')
  async streams(@Req() req: Request) {
    const client = await this.mine(req.user.clientId);
    if (!client) return [];

    const live = this.sync.latest(client.server.host)?.snapshot as StreamSnapshot | undefined;
    const liveOf = (path: string) => live?.streams?.find((s) => s.stream === path);

    return client.paths.map((p) => {
      const now = liveOf(p.path);
      return {
        // Το host το χρειάζεται το panel για να χτίσει και το URL αναπαραγωγής
        // (https://<host><path>/index.m3u8) και το rtmp:// του OBS — χωρίς αυτό
        // ο πελάτης βλέπει κλειδί που δεν ξέρει πού να το βάλει.
        host: client.server.host,
        path: p.path,
        key: p.key,
        streamKey: `${p.path.split('/').pop()}?key=${p.key}`,
        limit: client.limit,
        viewers: now?.viewers ?? 0,
        // Η ύπαρξη publisher ΕΙΝΑΙ η κατάσταση: `since` (πότε συνδέθηκε το OBS)
        // ή null. Χωριστό flag θα μπορούσε να διαφωνήσει με το since.
        since: now?.since ?? null,
        in_bps: now?.in_bps ?? 0,
      };
    });
  }

  // Ιστορικό μόνο των δικών του streams. Δεν ανοίγει το /servers/:host/series
  // (admin-only): εκεί ο πελάτης θα έβλεπε τα streams όλων των πελατών του ίδιου
  // μηχανήματος. Ίδιο proxy, φιλτραρισμένο με τα paths του token.
  @Get('series')
  async series(@Req() req: Request, @Query('range') range?: string) {
    const empty = { bucket: 0, from: 0, streams: [] };
    const client = await this.mine(req.user.clientId);
    if (!client) return empty;

    const qs = range ? `?range=${encodeURIComponent(range)}` : '';
    const data = (await this.servers.proxy(client.server.host, `/admin/api/series${qs}`)) as Series;
    const mine = new Set(client.paths.map((p) => p.path));

    // Χωρίς το `server` της απάντησης: CPU και μνήμη του μηχανήματος δεν αφορούν
    // τον πελάτη, και είναι πληροφορία για τους υπόλοιπους ενοίκους του.
    return {
      bucket: data.bucket,
      from: data.from,
      streams: (data.streams ?? []).filter((r) => mine.has(r.stream)),
    };
  }
}
