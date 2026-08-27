import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';
import { ServerTokenGuard } from './server-token.guard';
import { Public } from '../auth/public.decorator';
import { relayUrl } from '../clients/destinations';

// Μορφή που περιμένει ο loader του stream server (clients.json) —
// PLAN-multitenant.md, Φάση 1. Το `ladder` (PLAN-transcoding.md) είναι array από
// ύψη και **λείπει εντελώς** όταν το πλάνο δεν πουλάει ABR: έτσι το αρχείο των
// σημερινών πελατών μένει byte-για-byte ίδιο και το `config.js#ladderOf` του
// stream server δεν χρειάζεται να ξεχωρίσει «χωρίς πεδίο» από «κενό πεδίο».
// Το `relays` (αναδιανομή σε YouTube κ.λπ.) ακολουθεί ακριβώς την ίδια σύμβαση:
// χάρτης path → προορισμοί, που **λείπει εντελώς** όταν δεν έχει κανένα stream
// της συνδρομής προορισμό. Ξεχωριστό πεδίο και όχι μέσα στο `paths`, γιατί
// εκείνο είναι path→κλειδί εκπομπής και το διαβάζει ο έλεγχος του publish
// (apps/stream/config.js#publishAllowed) — δεν αλλάζει σχήμα ο έλεγχος ασφαλείας
// για ένα προαιρετικό χαρακτηριστικό.
type ClientsJson = Record<
  string,
  {
    limit: number;
    ladder?: number[];
    paths: Record<string, string>;
    relays?: Record<string, { name: string; url: string }[]>;
  }
>;

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
    // Σε αναστολή (συνδρομής ή πελάτη) = εκτός λίστας: άγνωστο path σημαίνει
    // μπλόκο στον stream server, οπότε η εκπομπή πέφτει σε ≤10s χωρίς να ξέρει
    // εκείνος τι είναι συνδρομή.
    const subs = await this.prisma.subscription.findMany({
      where: { serverId: server.id, disabled: false, client: { disabled: false } },
      // Μόνο οι ενεργοί προορισμοί: το `enabled: false` δουλεύει με το ίδιο κόλπο
      // με την αναστολή συνδρομής — η εγγραφή απλώς λείπει, χωρίς να χαθεί το
      // κλειδί της πλατφόρμας.
      include: {
        plan: true,
        paths: { include: { destinations: { where: { enabled: true } } } },
        client: true,
      },
    });

    const body: ClientsJson = {};
    for (const sub of subs) {
      body[`${sub.client.name}#${sub.id}`] = {
        // Ο stream server δεν ξέρει τι είναι πλάνο: παίρνει έτοιμο νούμερο, όπως
        // πάντα. Το σχήμα του clients.json δεν άλλαξε ποτέ γι' αυτόν.
        limit: sub.plan.maxViewers,
        // Το ladder ζει στο πλάνο, άρα μια αλλαγή στον κατάλογο το αλλάζει και
        // για τις υπάρχουσες συνδρομές — όπως το `limit`, δεν αντιγράφεται.
        ...(sub.plan.ladder ? { ladder: sub.plan.ladder.split(',').map(Number) } : {}),
        paths: Object.fromEntries(sub.paths.map((p) => [p.path, p.key])),
        ...relaysOf(sub.paths),
      };
    }
    return body;
  }
}

// Ο stream server παίρνει έτοιμο `rtmp://.../<key>` και δεν ξέρει καν ότι
// υπάρχει «πλατφόρμα»: η σύνθεση γίνεται εδώ, μία φορά. Paths χωρίς προορισμό
// δεν μπαίνουν καθόλου στον χάρτη, και συνδρομή χωρίς κανέναν δεν αποκτά το
// πεδίο — έτσι το clients.json των σημερινών πελατών μένει byte-για-byte ίδιο.
function relaysOf(paths: { path: string; destinations: { name: string; url: string; key: string }[] }[]) {
  const relays = Object.fromEntries(
    paths
      .filter((p) => p.destinations.length)
      .map((p) => [p.path, p.destinations.map((d) => ({ name: d.name, url: relayUrl(d.url, d.key) }))]),
  );
  return Object.keys(relays).length ? { relays } : {};
}
