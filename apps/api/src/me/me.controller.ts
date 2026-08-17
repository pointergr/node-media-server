import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from '../sync/sync.service';
import { ServersService } from '../servers/servers.service';
import { maxViewersOf, withPackages, withPaths } from '../clients/clients.service';

// Ελάχιστο σχήμα του snapshot που στέλνει ο stream server (stats.js#snapshot) —
// μόνο ό,τι χρειάζεται εδώ, όχι όλο το contract.
interface StreamSnapshot {
  streams?: { stream: string; viewers: number; since?: number; in_bps?: number; out_bps?: number }[];
  // Με R2 ενεργό το out_bps είναι εκτίμηση (bytes segment × θεατές): τα .ts
  // σερβίρονται από το CDN και δεν περνάνε ποτέ από τον stream server.
  r2Estimate?: boolean;
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
      include: { ...withPaths, ...withPackages },
    });
  }

  // Χωρίς @Roles(): και ο admin περνάει (JwtAuthGuard αρκεί), αλλά δεν έχει
  // clientId — γυρίζει άδεια λίστα, δεν είναι λάθος του caller.
  @Get('streams')
  async streams(@Req() req: Request) {
    const client = await this.mine(req.user.clientId);
    if (!client) return [];

    // Ένα snapshot ανά μηχάνημα και όχι ένα για όλα: τα paths του πελάτη μπορεί
    // να είναι μοιρασμένα σε δύο servers (μία αγορά στον καθένα).
    return client.paths.map((p) => {
      const live = this.sync.latest(p.server.host)?.snapshot as StreamSnapshot | undefined;
      const now = live?.streams?.find((s) => s.stream === p.path);
      return {
        // Το host το χρειάζεται το panel για να χτίσει και το URL αναπαραγωγής
        // (https://<host><path>/index.m3u8) και το rtmp:// του OBS — χωρίς αυτό
        // ο πελάτης βλέπει κλειδί που δεν ξέρει πού να το βάλει.
        host: p.server.host,
        path: p.path,
        key: p.key,
        streamKey: `${p.path.split('/').pop()}?key=${p.key}`,
        // Άθροισμα των πακέτων του πελάτη **σε αυτόν τον server** — το ίδιο
        // νούμερο που παίρνει και ο stream server στο clients.json. 0 = χωρίς
        // όριο, όπως πάντα.
        limit: maxViewersOf(client.packages, p.serverId),
        viewers: now?.viewers ?? 0,
        // Η ύπαρξη publisher ΕΙΝΑΙ η κατάσταση: `since` (πότε συνδέθηκε το OBS)
        // ή null. Χωριστό flag θα μπορούσε να διαφωνήσει με το since.
        since: now?.since ?? null,
        in_bps: now?.in_bps ?? 0,
        out_bps: now?.out_bps ?? 0,
        // Ταξιδεύει μαζί με το out_bps και μόνο γι' αυτό: χωρίς αυτό ο πελάτης
        // διαβάζει μια εκτίμηση σαν μετρημένη κίνηση (ίδιος αστερίσκος με το
        // /admin — δες apps/stream/stats.js#addR2Out).
        r2Estimate: live?.r2Estimate ?? false,
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
    const hosts = [...new Set(client.paths.map((p) => p.server.host))];
    // allSettled: με paths σε δύο μηχανήματα, ένα πεσμένο δεν πρέπει να σβήνει
    // και το γράφημα του άλλου.
    // ponytail: paths με το ίδιο όνομα σε δύο servers (το unique είναι ανά
    // server) συγχωνεύονται σε μία γραμμή — θέλει κλειδί host+path όταν συμβεί.
    const answers = (await Promise.allSettled(hosts.map((h) => this.servers.proxy(h, `/admin/api/series${qs}`))))
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value as Series);
    const mine = new Set(client.paths.map((p) => p.path));

    // Χωρίς το `server` της απάντησης: CPU και μνήμη του μηχανήματος δεν αφορούν
    // τον πελάτη, και είναι πληροφορία για τους υπόλοιπους ενοίκους του.
    return {
      bucket: answers[0]?.bucket ?? 0,
      from: answers[0]?.from ?? 0,
      streams: answers.flatMap((d) => d.streams ?? []).filter((r) => mine.has(r.stream)),
    };
  }
}
