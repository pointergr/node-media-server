import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
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
import { DestinationDto } from '../clients/destinations';

// Ελάχιστο σχήμα του snapshot που στέλνει ο stream server (stats.js#snapshot) —
// μόνο ό,τι χρειάζεται εδώ, όχι όλο το contract.
interface StreamSnapshot {
  streams?: {
    stream: string;
    viewers: number;
    since?: number;
    in_bps?: number;
    out_bps?: number;
    // Η κατάσταση της αναδιανομής, από τα ffmpeg jobs του stream server
    // (apps/stream/relay.js). Υπάρχει μόνο όσο εκπέμπει.
    relays?: { name: string; state: string; since: number | null }[];
  }[];
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

  // Πελάτης ή πακέτο σε **αναστολή = read-only**. Το sync έχει ήδη κόψει την
  // εκπομπή (η εγγραφή λείπει από το clients.json, άρα άγνωστο path σε ≤10s),
  // αλλά το API μέχρι τώρα δεχόταν κανονικά νέα streams, νέα κλειδιά και νέους
  // προορισμούς: η αναστολή φαινόταν παντού εκτός από εκεί που γράφεται. Οι
  // **αναγνώσεις** μένουν ανοιχτές επίτηδες — ο πελάτης πρέπει να βλέπει τι έχει
  // και γιατί δεν παίζει (`suspended`), αλλιώς το panel αδειάζει χωρίς εξήγηση.
  private async writable(
    clientId: number | null,
    match: (s: { id: number; disabled: boolean; paths: { id: number }[] }) => boolean,
    missing: string,
  ) {
    const client = await this.mine(clientId);
    if (!client) throw new NotFoundException(missing);
    if (client.disabled) throw new ForbiddenException('ο λογαριασμός είναι σε αναστολή — επικοινώνησε μαζί μας');
    const sub = client.subscriptions.find(match);
    if (!sub) throw new NotFoundException(missing);
    if (sub.disabled) throw new ForbiddenException('το πακέτο είναι σε αναστολή — επικοινώνησε μαζί μας');
    return sub;
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
        // Οι προορισμοί αναδιανομής, με τη ζωντανή τους κατάσταση κολλημένη από
        // το snapshot. Το ταίριασμα γίνεται με το όνομα — αυτό στέλνει ο stream
        // server, που δεν ξέρει τίποτα από ids της βάσης. Δύο προορισμοί με το
        // ίδιο όνομα στο ίδιο stream θα έδειχναν την ίδια κατάσταση· δεν το
        // απαγορεύουμε, γιατί η ζημιά είναι ένα λάθος badge και ο περιορισμός θα
        // ήταν πιο ενοχλητικός από το πρόβλημα.
        // `null` σημαίνει «δεν εκπέμπει τώρα», όχι «χαλασμένο»: χωρίς publisher
        // δεν υπάρχει relay να έχει κατάσταση.
        destinations: p.destinations.map((d) => ({
          id: d.id,
          name: d.name,
          url: d.url,
          key: d.key,
          enabled: d.enabled,
          state: now?.relays?.find((r) => r.name === d.name)?.state ?? null,
        })),
      };
      });
    });
  }

  // Τα πακέτα του, ακόμα κι αυτά χωρίς κανένα stream: το /me/streams γυρίζει
  // paths, οπότε μια συνδρομή που μόλις αγοράστηκε δεν φαίνεται πουθενά — και το
  // «νέο stream» δεν θα είχε πού να σταθεί. Τα όρια έρχονται ζωντανά από το
  // πλάνο, ίδια πηγή με το clients.json του stream server.
  @Get('subscriptions')
  async subscriptions(@Req() req: Request) {
    const client = await this.mine(req.user.clientId);
    if (!client) return [];
    return client.subscriptions.map((sub) => ({
      id: sub.id,
      plan: sub.plan.name,
      label: sub.label,
      host: sub.server.host,
      maxStreams: sub.plan.maxStreams,
      maxViewers: sub.plan.maxViewers,
      // Πόσους προορισμούς αναδιανομής επιτρέπει το πλάνο ανά stream. 0 = δεν
      // την πουλάει — το panel τότε δεν δείχνει καν τη φόρμα.
      maxRelays: sub.plan.maxRelays,
      streams: sub.paths.length,
      suspended: sub.disabled,
    }));
  }

  // Νέο stream από τον ίδιο τον πελάτη, μέχρι το όριο του πακέτου του. Το όριο
  // και ο έλεγχος ιδιοκτησίας ζουν στην addPath — ίδια συνάρτηση με το admin
  // endpoint, γι' αυτό δεν ξαναγράφεται τίποτα από τα δύο εδώ. Το όνομα του path
  // το βγάζει το API (nextPath): ο stream server το συγκρίνει
  // χαρακτήρα-χαρακτήρα και δεν υπάρχει λόγος να το διαλέγει ο πελάτης.
  @Post('streams')
  async create(@Req() req: Request, @Body() body: { subscriptionId?: number }) {
    if (!body.subscriptionId) throw new BadRequestException('subscriptionId απαιτείται');
    await this.writable(req.user.clientId, (s) => s.id === body.subscriptionId, 'subscription not found');
    return this.clients.addPath(req.user.clientId!, undefined, body.subscriptionId);
  }

  // Διαγραφή stream από τον ίδιο τον πελάτη — **όχι** όσο εκπέμπει: το κλειδί
  // φεύγει μαζί με το path, οπότε ένα κατά λάθος κλικ την ώρα της λειτουργίας θα
  // έκοβε τη μετάδοση χωρίς δρόμο επιστροφής. Η κατάσταση βγαίνει από το
  // τελευταίο snapshot (≤10s, ίδια πηγή με το `since` του /me/streams): αν ο
  // publisher συνδεθεί μέσα σε αυτό το παράθυρο, τον κόβει το επόμενο sync —
  // ρωτώντας ζωντανά τον stream server θα κρεμούσε το endpoint σε ένα μηχάνημα
  // που μπορεί να είναι κάτω.
  @Delete('streams/:id')
  async remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const sub = await this.writable(req.user.clientId, (s) => s.paths.some((p) => p.id === id), 'path not found');
    const path = sub.paths.find((p) => p.id === id)!;

    const live = this.sync.latest(sub.server.host)?.snapshot as StreamSnapshot | undefined;
    if (live?.streams?.find((s) => s.stream === path.path)?.since) {
      throw new ConflictException('το stream εκπέμπει — σταμάτα το πρόγραμμα εκπομπής και ξαναδοκίμασε');
    }
    // Ο έλεγχος ιδιοκτησίας ξαναγίνεται εδώ μέσα (pathOf), με το clientId του token.
    await this.clients.removePath(req.user.clientId!, id);
  }

  // Ανανέωση του κλειδιού από τον ίδιο τον πελάτη: εκτεθειμένο κλειδί δεν περιμένει
  // τον διαχειριστή. Ίδια συνάρτηση με το admin endpoint — ο έλεγχος ιδιοκτησίας
  // ζει εκεί και εδώ το clientId βγαίνει από το token, ποτέ από τον caller.
  @Post('streams/:id/key')
  async refreshKey(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    // Ο admin δεν έχει clientId — δεν έχει δικά του streams να ανανεώσει (τα κάνει
    // από το /clients). Το writable το καλύπτει: χωρίς clientId δεν υπάρχει πελάτης.
    await this.writable(req.user.clientId, (s) => s.paths.some((p) => p.id === id), 'path not found');
    return this.clients.refreshKey(req.user.clientId!, id);
  }

  // Οι προορισμοί αναδιανομής, από τον ίδιο τον πελάτη: αυτό είναι όλο το νόημα
  // του χαρακτηριστικού — ο πελάτης συνδέει το **δικό του** κανάλι, χωρίς να
  // περιμένει διαχειριστή. Ίδιες συναρτήσεις με το /clients (όριο πλάνου,
  // έλεγχος εγκυρότητας, έλεγχος ιδιοκτησίας): εδώ αλλάζει μόνο ότι το clientId
  // βγαίνει από το token και ποτέ από τον caller.
  @Post('streams/:id/destinations')
  async addDestination(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<DestinationDto>,
  ) {
    // Ο admin δεν έχει clientId — δεν έχει δικά του streams (τα κάνει από το /clients).
    await this.writable(req.user.clientId, (s) => s.paths.some((p) => p.id === id), 'path not found');
    return this.clients.addDestination(req.user.clientId!, id, body);
  }

  @Patch('streams/:id/destinations/:destId')
  async setDestination(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('destId', ParseIntPipe) destId: number,
    @Body() body: Partial<DestinationDto>,
  ) {
    await this.writable(req.user.clientId, (s) => s.paths.some((p) => p.id === id), 'destination not found');
    return this.clients.updateDestination(req.user.clientId!, id, destId, body);
  }

  @Delete('streams/:id/destinations/:destId')
  async removeDestination(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('destId', ParseIntPipe) destId: number,
  ) {
    await this.writable(req.user.clientId, (s) => s.paths.some((p) => p.id === id), 'destination not found');
    return this.clients.removeDestination(req.user.clientId!, id, destId);
  }

  // Το φιλικό όνομα του πακέτου, από τον ίδιο τον πελάτη: εκείνος ξέρει ότι το
  // ένα basic είναι η εκκλησία και το άλλο το δημαρχείο, όχι ο διαχειριστής.
  // Μόνο το `label` — η αναστολή είναι εμπορική απόφαση και μένει στο /clients.
  @Patch('subscriptions/:id')
  async setLabel(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: { label?: string | null }) {
    if (!('label' in body)) throw new BadRequestException('label απαιτείται');
    await this.writable(req.user.clientId, (s) => s.id === id, 'subscription not found');
    // Ο έλεγχος ιδιοκτησίας ζει στο ClientsService (subscriptionOf): το id έρχεται
    // από τον caller, το clientId ποτέ — μόνο από το token.
    return this.clients.updateSubscription(req.user.clientId!, id, { label: cleanLabel(body.label) });
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
