import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/password';
import { cleanDestination, DestinationDto } from './destinations';

import type { Prisma } from '@prisma/client';

// Ο client μέσα σε $transaction (χωρίς τα $connect/$transaction και τα hooks του
// Nest που έχει το PrismaService).
type PrismaTx = Prisma.TransactionClient;

export interface CreateClientDto {
  name: string;
  // Προαιρετικά: φτιάχνει και τον customer χρήστη μαζί με τον πελάτη — δεν
  // υπάρχει ξεχωριστό endpoint για users, δες README.md.
  username?: string;
  password?: string;
}

export type UpdateClientDto = Partial<Pick<CreateClientDto, 'name' | 'username' | 'password'>> & {
  disabled?: boolean;
};

// Ο server μόνο ως «πού»: όποιος διαβάζει συνδρομή ή πλάνο θέλει το host, όχι το
// bearer του sync και τον κωδικό του admin dashboard — και με API key ρόλου admin
// θα έφευγαν σε κάθε provisioning κλήση. Μόνο το /servers τα δείχνει.
export const serverBrief = { select: { id: true, host: true } } as const;

// Οι συνδρομές του πελάτη με ό,τι χρειάζεται όποιος τις διαβάζει: το πλάνο δίνει
// τα όρια (δεν αντιγράφονται στη συνδρομή), ο server το πού, τα paths το τι.
// Μία φορά, ώστε να μη διαφύγει το nested include σε κάποιον καλούντα — χωρίς το
// `plan` δεν υπάρχει όριο να επιβληθεί.
// Οι προορισμοί ταξιδεύουν μαζί με το path: όπου φαίνεται ένα stream (admin ή
// /me), φαίνεται και το πού αναμεταδίδεται. Το `key` της πλατφόρμας είναι μέσα —
// το κρύβει το panel, όπως και το δικό μας stream key (SecretKey.vue).
export const withSubscriptions = {
  subscriptions: {
    include: { plan: true, server: serverBrief, paths: { include: { destinations: true } } },
  },
} as const;

// Ρητό `select` και όχι `include`: το User κρατάει το hash του κωδικού, που δεν
// έχει λόγο να φύγει ποτέ από το API — ούτε στον admin. Μόνο εδώ (πελάτες), όχι
// στο withSubscriptions: το sync και το /me/streams δεν δείχνουν χρήστες.
const withUser = { users: { select: { id: true, username: true } } } as const;

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  // Το προαιρετικό `username` είναι αναζήτηση, όχι ταυτότητα: μερικό ταίριασμα
  // (ο admin θυμάται την αρχή του ονόματος από το τηλέφωνο) και κενό = χωρίς
  // φίλτρο, ώστε το panel να δείχνει τη λίστα και να ψάχνει από το ίδιο endpoint.
  list(username?: string) {
    return this.prisma.client.findMany({
      where: username ? { users: { some: { username: { contains: username } } } } : undefined,
      include: { ...withSubscriptions, ...withUser },
    });
  }

  async get(id: number) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { ...withSubscriptions, ...withUser },
    });
    if (!client) throw new NotFoundException('client not found');
    return client;
  }

  async create(dto: CreateClientDto) {
    // Destructuring και όχι σκέτο dto: ό,τι δεν είναι στήλη του Client (username,
    // password) θα έδινε PrismaClientValidationError, δηλαδή 500.
    const { username, password, ...clientData } = dto;
    return this.prisma.$transaction(async (tx) => {
      const client = await tx.client.create({ data: clientData });
      await this.setUser(tx, client.id, username, password);
      return client;
    });
  }

  async update(id: number, dto: UpdateClientDto) {
    await this.get(id);
    const { username, password, ...clientData } = dto;
    return this.prisma.$transaction(async (tx) => {
      await this.setUser(tx, id, username, password);
      return tx.client.update({ where: { id }, data: clientData });
    });
  }

  // Ο χρήστης σύνδεσης του πελάτη — δημιουργία ΚΑΙ αλλαγή στο ίδιο σημείο: δεν
  // υπάρχει users module (δες README#Αποφάσεις), οπότε αν το create και το update
  // το έγραφαν ξεχωριστά, το ένα από τα δύο θα ξέχναγε το hashPassword ή το 409
  // του διπλού username.
  private async setUser(tx: PrismaTx, clientId: number, username?: string, password?: string) {
    if (!username && !password) return;
    // Το σχήμα επιτρέπει πολλούς χρήστες ανά πελάτη, η πράξη έχει έναν: ο
    // παλαιότερος είναι «ο χρήστης του πελάτη».
    const user = await tx.user.findFirst({ where: { clientId }, orderBy: { id: 'asc' } });
    if (!user && !(username && password)) {
      throw new BadRequestException('ο πελάτης δεν έχει χρήστη ακόμα — δώσε username και password μαζί');
    }
    // `undefined` στο update σημαίνει «μην το αγγίξεις» για το Prisma: κενός
    // κωδικός αφήνει το username να αλλάξει μόνο του, και αντίστροφα.
    const hash = password ? hashPassword(password) : undefined;
    try {
      await (user
        ? tx.user.update({ where: { id: user.id }, data: { username, password: hash } })
        : tx.user.create({ data: { username: username!, password: hash!, role: 'customer', clientId } }));
    } catch (e) {
      // Χωρίς αυτό ένα username που υπάρχει ήδη έβγαινε ως HTTP 500.
      if (isUniqueConstraintError(e)) throw new ConflictException(`το όνομα χρήστη ${username} χρησιμοποιείται ήδη`);
      throw e;
    }
  }

  async remove(id: number) {
    await this.get(id);
    await this.prisma.client.delete({ where: { id } });
  }

  // Μία αγορά = μία γραμμή. Δεν υπάρχει ποσότητα: δύο φορές το ίδιο πλάνο είναι
  // δύο συνδρομές, με τα όριά τους χωριστά η καθεμία.
  async addSubscription(clientId: number, planId: number) {
    await this.get(clientId);
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException('άγνωστο πλάνο');
    // Ο server είναι στιγμιότυπο: ό,τι δείχνει το πλάνο **τώρα**. Αν αύριο το
    // πλάνο δείξει αλλού, αυτή η συνδρομή μένει εδώ.
    return this.prisma.subscription.create({
      data: { clientId, planId, serverId: plan.serverId },
      include: { plan: true, server: serverBrief, paths: true },
    });
  }

  // Αναστολή μόνο αυτής της συνδρομής (ο πελάτης μπορεί να έχει τρία πλάνα και να
  // έχει λήξει το ένα — το `Client.disabled` μένει για «όλα κάτω») και το φιλικό
  // της όνομα. Μία συνάρτηση για τα δύο: το `label` το αλλάζει και ο πελάτης από
  // το /me, το `disabled` ποτέ — τον έλεγχο τον κάνει ο caller, δες me.controller.
  async updateSubscription(
    clientId: number,
    subscriptionId: number,
    data: { disabled?: boolean; label?: string | null; planId?: number },
  ) {
    const sub = await this.subscriptionOf(clientId, subscriptionId);
    // Αναβάθμιση/υποβάθμιση επιτόπου, και όχι DELETE + POST: η συνδρομή κουβαλάει
    // τα paths και τα κλειδιά εκπομπής, άρα κάθε αλλαγή πλάνου θα ζητούσε νέο
    // στήσιμο OBS. Ό,τι είναι όριο (θεατές, streams, ladder) διαβάζεται ζωντανά
    // από το πλάνο, οπότε δεν υπάρχει τίποτα να αντιγραφεί εδώ.
    if (data.planId !== undefined && data.planId !== sub.planId) {
      const plan = await this.prisma.plan.findUnique({ where: { id: data.planId } });
      if (!plan) throw new BadRequestException('άγνωστο πλάνο');
      // Το μόνο σημείο που ελέγχει το όριο streams μετά την προσθήκη: το addPath
      // κοιτάει μόνο τη στιγμή του, οπότε ένα downgrade χωρίς αυτό θα άφηνε τη
      // συνδρομή μόνιμα πάνω από το πλάνο της. Ποιο stream θα έφευγε δεν είναι
      // δική μας απόφαση — το κλειδί του το ξέρει ήδη ένας encoder.
      if (sub.paths.length > plan.maxStreams) {
        throw new ConflictException(
          `το πλάνο «${plan.name}» επιτρέπει ${plan.maxStreams} streams, η συνδρομή έχει ${sub.paths.length} — σβήσε πρώτα ${sub.paths.length - plan.maxStreams}`,
        );
      }
      // Ο server **δεν** ακολουθεί το νέο πλάνο: παγώνει στην αγορά (δες
      // addSubscription) και τα paths ζουν πάνω του — αλλιώς μια αναβάθμιση θα
      // άλλαζε σιωπηλά τη διεύθυνση εκπομπής όλων των streams της συνδρομής.
    }
    return this.prisma.subscription.update({ where: { id: subscriptionId }, data });
  }

  async removeSubscription(clientId: number, subscriptionId: number) {
    const sub = await this.subscriptionOf(clientId, subscriptionId);
    // Ρητό 409 και όχι cascade: η συνδρομή κουβαλάει τα paths και τα κλειδιά
    // εκπομπής του πελάτη — να χάνονται με ένα κλικ «αφαίρεση πλάνου» είναι
    // χειρότερο από ένα σφάλμα που λέει τι να κάνεις.
    if (sub.paths.length) {
      throw new ConflictException(`το πλάνο έχει ${sub.paths.length} streams — σβήσε τα πρώτα`);
    }
    await this.prisma.subscription.delete({ where: { id: subscriptionId } });
  }

  async addPath(clientId: number, path: string | undefined, subscriptionId: number) {
    const sub = await this.subscriptionOf(clientId, subscriptionId);

    // Το όριο streams μετράει paths, όχι ταυτόχρονες εκπομπές — ο stream server
    // δεν το βλέπει καν. Ελέγχεται μόνο εδώ, τη στιγμή της προσθήκης: paths που
    // υπάρχουν ήδη δεν κόβονται αν αργότερα μικρύνει το πλάνο.
    if (sub.paths.length >= sub.plan.maxStreams) {
      throw new ConflictException(`το πλάνο «${sub.plan.name}» επιτρέπει ${sub.plan.maxStreams} streams`);
    }

    const key = newKey();
    path ||= nextPath(clientId, sub.id, sub.paths);
    try {
      // Ο server έρχεται από τη συνδρομή, ποτέ από τον caller: αλλιώς θα υπήρχε
      // path σε μηχάνημα που δεν πλήρωσε κανείς.
      return await this.prisma.path.create({
        data: { path, key, subscriptionId, serverId: sub.serverId },
      });
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new ConflictException(`το path ${path} χρησιμοποιείται ήδη σε αυτόν τον server`);
      }
      throw e;
    }
  }

  async removePath(clientId: number, pathId: number) {
    await this.pathOf(clientId, pathId);
    await this.prisma.path.delete({ where: { id: pathId } });
  }

  // Νέο κλειδί στο ίδιο path: για όταν εκτεθεί το παλιό. Το path μένει ως έχει —
  // το ξέρει ήδη το OBS και η διεύθυνση προβολής — και ο παλιός publisher πέφτει
  // στο επόμενο sync (≤10s, δες stats.js#sample). Το κάνει και ο ίδιος ο πελάτης
  // από το /me: όποιος βλέπει το κλειδί μπορεί και να το αλλάξει.
  async refreshKey(clientId: number, pathId: number) {
    await this.pathOf(clientId, pathId);
    return this.prisma.path.update({ where: { id: pathId }, data: { key: newKey() } });
  }

  // Ένας εξωτερικός προορισμός (YouTube, Facebook...) πάνω σε stream του πελάτη.
  // Το όριο είναι **του πλάνου** και μετριέται ανά stream, όχι ανά συνδρομή: κάθε
  // κάμερα πάει στο δικό της κανάλι, και δύο κάμερες με από δύο προορισμούς είναι
  // τέσσερα αντίγραφα της εκπομπής προς τα έξω — γι' αυτό το νούμερο είναι μικρό.
  // Ελέγχεται μόνο εδώ, τη στιγμή της προσθήκης: προορισμοί που υπάρχουν ήδη δεν
  // κόβονται αν αργότερα μικρύνει το πλάνο, ίδια συμπεριφορά με το maxStreams.
  async addDestination(clientId: number, pathId: number, dto: Partial<DestinationDto>) {
    const path = await this.pathOf(clientId, pathId);
    const data = cleanDestination(dto) as DestinationDto;

    // 0 σημαίνει «το πλάνο δεν πουλάει αναδιανομή» — ΟΧΙ «χωρίς όριο», αντίθετα
    // από τα maxViewers/maxStreams. Δες το σχόλιο στο schema.prisma.
    const max = path.subscription.plan.maxRelays;
    if (!max) {
      throw new ConflictException(`το πλάνο «${path.subscription.plan.name}» δεν περιλαμβάνει αναδιανομή`);
    }
    if (path.destinations.length >= max) {
      throw new ConflictException(`το πλάνο «${path.subscription.plan.name}» επιτρέπει ${max} προορισμούς ανά stream`);
    }

    return this.prisma.destination.create({ data: { ...data, pathId } });
  }

  // Αλλαγή στοιχείων ή on/off. Το `enabled: false` κρατάει το κλειδί και απλώς
  // βγάζει την εγγραφή από το clients.json — αλλά, σε αντίθεση με την αναστολή
  // συνδρομής, ΔΕΝ πέφτει σε ≤10s: οι προορισμοί διαβάζονται μία φορά, στην αρχή
  // της εκπομπής (apps/stream/app.js#postPublish).
  async updateDestination(clientId: number, pathId: number, id: number, dto: Partial<DestinationDto>) {
    await this.destinationOf(clientId, pathId, id);
    const data = cleanDestination(dto, true);
    if (!Object.keys(data).length) throw new BadRequestException('τίποτα προς αλλαγή');
    return this.prisma.destination.update({ where: { id }, data });
  }

  async removeDestination(clientId: number, pathId: number, id: number) {
    await this.destinationOf(clientId, pathId, id);
    await this.prisma.destination.delete({ where: { id } });
  }

  // Ο προορισμός **αυτού του path, αυτού του πελάτη**: το pathOf κάνει ήδη τον
  // έλεγχο ιδιοκτησίας, εδώ μένει μόνο να μην τρυπώσει id προορισμού άλλου path.
  private async destinationOf(clientId: number, pathId: number, id: number) {
    const path = await this.pathOf(clientId, pathId);
    const dest = path.destinations.find((d) => d.id === id);
    if (!dest) throw new NotFoundException('destination not found');
    return dest;
  }

  // Ίδιος έλεγχος ιδιοκτησίας με το subscriptionOf, για τα paths: ένα pathId
  // άλλου πελάτη δεν πρέπει να σβήνεται ούτε να αλλάζει κλειδί από εδώ.
  private async pathOf(clientId: number, id: number) {
    const path = await this.prisma.path.findUnique({
      where: { id },
      // Το πλάνο δίνει το όριο προορισμών και οι υπάρχοντες το τρέχον πλήθος —
      // και τα δύο τα θέλει η addDestination, που είναι ο μόνος καλών με όριο.
      include: { subscription: { include: { plan: true } }, destinations: true },
    });
    if (!path || path.subscription.clientId !== clientId) throw new NotFoundException('path not found');
    return path;
  }

  // Η συνδρομή **του συγκεκριμένου πελάτη**: ο έλεγχος ιδιοκτησίας ζει εδώ, ώστε
  // να μην μπορεί ένα id από άλλο πελάτη να τρυπώσει σε path ή σε διαγραφή.
  private async subscriptionOf(clientId: number, id: number) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: { plan: true, paths: true },
    });
    if (!sub || sub.clientId !== clientId) throw new NotFoundException('subscription not found');
    return sub;
  }
}

// Το φιλικό όνομα συνδρομής, καθαρισμένο: εδώ και όχι σε δύο controllers, γιατί
// το ίδιο πεδίο το γράφουν και ο admin και ο πελάτης. Σκέτα κενά ισοδυναμούν με
// «σβήσε το» (null) — αλλιώς το panel θα έδειχνε κενή κεφαλίδα αντί να πέσει πίσω
// στο όνομα του πλάνου. Το όριο είναι κεφαλίδα κάρτας, όχι κείμενο.
export const LABEL_MAX = 60;
export function cleanLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('label: κείμενο ή null');
  const label = value.trim();
  if (label.length > LABEL_MAX) throw new BadRequestException(`label έως ${LABEL_MAX} χαρακτήρες`);
  return label || null;
}

// Path χωρίς να το σκεφτεί κανείς: `/live/c3-s7-1`. Τα ids αντί για το όνομα του
// πελάτη γιατί το όνομα είναι ελληνικό (το path δέχεται μόνο ASCII) και αλλάζει,
// ενώ το path που ήδη το ξέρει ένα OBS δεν αλλάζει ποτέ. Η αρίθμηση συνεχίζει από
// το μεγαλύτερο υπάρχον, όχι από το πλήθος — αλλιώς μετά από διαγραφή το επόμενο
// θα έπεφτε πάνω σε path που υπάρχει (409).
function nextPath(clientId: number, subscriptionId: number, paths: { path: string }[]): string {
  const prefix = `/live/c${clientId}-s${subscriptionId}-`;
  const used = paths.filter((p) => p.path.startsWith(prefix)).map((p) => Number(p.path.slice(prefix.length)) || 0);
  return prefix + (Math.max(0, ...used) + 1);
}

// ≥16 chars base64url, δες PLAN-multitenant.md #2 — 16 bytes -> 22 χαρακτήρες.
function newKey(): string {
  return randomBytes(16).toString('base64url');
}

function isUniqueConstraintError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
