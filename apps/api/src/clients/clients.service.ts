import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/password';

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

// Οι συνδρομές του πελάτη με ό,τι χρειάζεται όποιος τις διαβάζει: το πλάνο δίνει
// τα όρια (δεν αντιγράφονται στη συνδρομή), ο server το πού, τα paths το τι.
// Μία φορά, ώστε να μη διαφύγει το nested include σε κάποιον καλούντα — χωρίς το
// `plan` δεν υπάρχει όριο να επιβληθεί.
export const withSubscriptions = {
  subscriptions: { include: { plan: true, server: true, paths: true } },
} as const;

// Ρητό `select` και όχι `include`: το User κρατάει το hash του κωδικού, που δεν
// έχει λόγο να φύγει ποτέ από το API — ούτε στον admin. Μόνο εδώ (πελάτες), όχι
// στο withSubscriptions: το sync και το /me/streams δεν δείχνουν χρήστες.
const withUser = { users: { select: { id: true, username: true } } } as const;

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.client.findMany({ include: { ...withSubscriptions, ...withUser } });
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
      include: { plan: true, server: true, paths: true },
    });
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

  async addPath(clientId: number, path: string, subscriptionId: number) {
    const sub = await this.subscriptionOf(clientId, subscriptionId);

    // Το όριο streams μετράει paths, όχι ταυτόχρονες εκπομπές — ο stream server
    // δεν το βλέπει καν. Ελέγχεται μόνο εδώ, τη στιγμή της προσθήκης: paths που
    // υπάρχουν ήδη δεν κόβονται αν αργότερα μικρύνει το πλάνο.
    if (sub.paths.length >= sub.plan.maxStreams) {
      throw new ConflictException(`το πλάνο «${sub.plan.name}» επιτρέπει ${sub.plan.maxStreams} streams`);
    }

    // ≥16 chars base64url, δες PLAN-multitenant.md #2 — 16 bytes -> 22 χαρακτήρες.
    const key = randomBytes(16).toString('base64url');
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
    const path = await this.prisma.path.findUnique({ where: { id: pathId }, include: { subscription: true } });
    if (!path || path.subscription.clientId !== clientId) throw new NotFoundException('path not found');
    await this.prisma.path.delete({ where: { id: pathId } });
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

function isUniqueConstraintError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
