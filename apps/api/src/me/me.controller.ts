import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from '../sync/sync.service';
import { ServersService } from '../servers/servers.service';
import { cleanLabel, ClientsService, withSubscriptions } from '../clients/clients.service';

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
    private readonly clients: ClientsService,
  ) {}

  // Ο πελάτης και οι συνδρομές του (με πλάνο, server και paths) σε μία ερώτηση:
  // κάθε endpoint εδώ ξεκινάει από το clientId του token, ποτέ από παράμετρο του
  // caller — αυτό είναι όλο το φιλτράρισμα που στέκεται ανάμεσα σε δύο πελάτες
  // του ίδιου server.
  private mine(clientId: number | null) {
    if (!clientId) return null;
    return this.prisma.client.findUnique({
      where: { id: clientId },
      include: { ...withSubscriptions },
    });
  }

  // Χωρίς @Roles(): και ο admin περνάει (JwtAuthGuard αρκεί), αλλά δεν έχει
  // clientId — γυρίζει άδεια λίστα, δεν είναι λάθος του caller.
  @Get('streams')
  async streams(@Req() req: Request) {
    const client = await this.mine(req.user.clientId);
    if (!client) return [];

    // Ένα snapshot ανά μηχάνημα και όχι ένα για όλα: οι συνδρομές του πελάτη
    // μπορεί να είναι μοιρασμένες σε δύο servers.
    return client.subscriptions.flatMap((sub) => {
      const live = this.sync.latest(sub.server.host)?.snapshot as StreamSnapshot | undefined;
      return sub.paths.map((p) => {
      const now = live?.streams?.find((s) => s.stream === p.path);
      return {
        // Το id ταξιδεύει μόνο για την ανανέωση κλειδιού (POST /me/streams/:id/key).
        id: p.id,
        // Το host το χρειάζεται το panel για να χτίσει και το URL αναπαραγωγής
        // (https://<host><path>/index.m3u8) και το rtmp:// του OBS — χωρίς αυτό
        // ο πελάτης βλέπει κλειδί που δεν ξέρει πού να το βάλει.
        host: sub.server.host,
        path: p.path,
        key: p.key,
        streamKey: `${p.path.split('/').pop()}?key=${p.key}`,
        // Το stream ανήκει σε μία συνδρομή και το όριο είναι **της συνδρομής**:
        // το ίδιο νούμερο που παίρνει και ο stream server στο clients.json. Το
        // id ταξιδεύει για να ομαδοποιεί το panel τους θεατές ανά πλάνο — δύο
        // συνδρομές του ίδιου πλάνου δεν είναι η ίδια.
        plan: sub.plan.name,
        subscriptionId: sub.id,
        // Το φιλικό όνομα της συνδρομής, αν του το έχουν δώσει: με δύο πακέτα
        // «basic» είναι το μόνο που ξεχωρίζει ποιο stream μοιράζεται όριο με
        // ποιο. null = δεν ονομάστηκε ποτέ, το panel δείχνει το πλάνο.
        subscriptionLabel: sub.label,
        // Σε αναστολή το stream δεν εκπέμπει και δεν παίζει — φαίνεται όμως, με
        // τον λόγο του: αλλιώς ο πελάτης βλέπει το OBS να κόβεται και το stream
        // να εξαφανίζεται από το panel, χωρίς να ξέρει γιατί.
        suspended: sub.disabled,
        limit: sub.plan.maxViewers,
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
    });
  }

  // Ανανέωση του κλειδιού από τον ίδιο τον πελάτη: εκτεθειμένο κλειδί δεν περιμένει
  // τον διαχειριστή. Ίδια συνάρτηση με το admin endpoint — ο έλεγχος ιδιοκτησίας
  // ζει εκεί και εδώ το clientId βγαίνει από το token, ποτέ από τον caller.
  @Post('streams/:id/key')
  refreshKey(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    // Ο admin δεν έχει clientId — δεν έχει δικά του streams να ανανεώσει (τα κάνει
    // από το /clients).
    if (!req.user.clientId) throw new NotFoundException('path not found');
    return this.clients.refreshKey(req.user.clientId, id);
  }

  // Το φιλικό όνομα του πακέτου, από τον ίδιο τον πελάτη: εκείνος ξέρει ότι το
  // ένα basic είναι η εκκλησία και το άλλο το δημαρχείο, όχι ο διαχειριστής.
  // Μόνο το `label` — η αναστολή είναι εμπορική απόφαση και μένει στο /clients.
  @Patch('subscriptions/:id')
  setLabel(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: { label?: string | null }) {
    if (!req.user.clientId) throw new NotFoundException('subscription not found');
    if (!('label' in body)) throw new BadRequestException('label απαιτείται');
    // Ο έλεγχος ιδιοκτησίας ζει στο ClientsService (subscriptionOf): το id έρχεται
    // από τον caller, το clientId ποτέ — μόνο από το token.
    return this.clients.updateSubscription(req.user.clientId, id, { label: cleanLabel(body.label) });
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
    const hosts = [...new Set(client.subscriptions.map((s) => s.server.host))];
    // allSettled: με paths σε δύο μηχανήματα, ένα πεσμένο δεν πρέπει να σβήνει
    // και το γράφημα του άλλου.
    // ponytail: paths με το ίδιο όνομα σε δύο servers (το unique είναι ανά
    // server) συγχωνεύονται σε μία γραμμή — θέλει κλειδί host+path όταν συμβεί.
    const answers = (await Promise.allSettled(hosts.map((h) => this.servers.proxy(h, `/admin/api/series${qs}`))))
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value as Series);
    const mine = new Set(client.subscriptions.flatMap((s) => s.paths.map((p) => p.path)));

    // Χωρίς το `server` της απάντησης: CPU και μνήμη του μηχανήματος δεν αφορούν
    // τον πελάτη, και είναι πληροφορία για τους υπόλοιπους ενοίκους του.
    return {
      bucket: answers[0]?.bucket ?? 0,
      from: answers[0]?.from ?? 0,
      streams: answers.flatMap((d) => d.streams ?? []).filter((r) => mine.has(r.stream)),
    };
  }
}
