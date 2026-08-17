import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/password';

import type { Prisma } from '@prisma/client';

// Ο client μέσα σε $transaction (χωρίς τα $connect/$transaction και τα hooks του
// Nest που έχει το PrismaService).
type PrismaTx = Prisma.TransactionClient;

export interface OwnedPackage {
  packageId: number;
  qty?: number;
}

export interface CreateClientDto {
  name: string;
  serverId: number;
  // Η τελική λίστα πακέτων του πελάτη — όχι πρόσθεση: ό,τι στέλνει το panel
  // αντικαθιστά ό,τι υπάρχει (δες setPackages).
  packages?: OwnedPackage[];
  // Προαιρετικά: φτιάχνει και τον customer χρήστη μαζί με τον πελάτη — δεν
  // υπάρχει ξεχωριστό endpoint για users, δες README.md.
  username?: string;
  password?: string;
}

export type UpdateClientDto = Partial<
  Pick<CreateClientDto, 'name' | 'serverId' | 'packages' | 'username' | 'password'>
> & {
  disabled?: boolean;
};

// Τα όρια του πελάτη είναι το άθροισμα των πακέτων του επί την ποσότητα. Ο κανόνας
// ζει εδώ και μόνο εδώ: τον καλούν το sync (clients.json του stream server), το
// /me/streams και ο έλεγχος των paths. Δύο αντίγραφα θα απέκλιναν.
// Κανένα πακέτο => 0 => χωρίς όριο, ακριβώς η σημερινή σημασία του 0 σε όλη τη
// διαδρομή (stats.js#overLimit, README).
type Owned = { qty: number; package: { maxViewers: number; maxStreams: number } };
export const maxViewersOf = (ps: Owned[]) => ps.reduce((n, p) => n + p.qty * p.package.maxViewers, 0);
export const maxStreamsOf = (ps: Owned[]) => ps.reduce((n, p) => n + p.qty * p.package.maxStreams, 0);

// Ό,τι χρειάζεται όποιος υπολογίζει όρια — μία φορά, ώστε να μη διαφύγει το
// nested include σε κάποιον από τους τρεις καλούντες (χωρίς αυτό, όρια = 0).
export const withPackages = { packages: { include: { package: true } } } as const;

// Ρητό `select` και όχι `include`: το User κρατάει το hash του κωδικού, που δεν
// έχει λόγο να φύγει ποτέ από το API — ούτε στον admin. Μόνο εδώ (πελάτες), όχι
// στο withPackages: το sync και το /me/streams δεν δείχνουν χρήστες.
const withUser = { users: { select: { id: true, username: true } } } as const;

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.client.findMany({
      include: { paths: true, server: true, ...withPackages, ...withUser },
    });
  }

  async get(id: number) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { paths: true, server: true, ...withPackages, ...withUser },
    });
    if (!client) throw new NotFoundException('client not found');
    return client;
  }

  async create(dto: CreateClientDto) {
    // Destructuring και όχι σκέτο dto: ό,τι δεν είναι στήλη του Client (packages,
    // username, password) θα έδινε PrismaClientValidationError, δηλαδή 500.
    const { username, password, packages, ...clientData } = dto;
    return this.prisma.$transaction(async (tx) => {
      const client = await tx.client.create({ data: clientData });
      if (packages?.length) await this.setPackages(tx, client.id, packages);
      await this.setUser(tx, client.id, username, password);
      return client;
    });
  }

  async update(id: number, dto: UpdateClientDto) {
    await this.get(id);
    const { packages, username, password, ...clientData } = dto;
    return this.prisma.$transaction(async (tx) => {
      if (packages) await this.setPackages(tx, id, packages);
      await this.setUser(tx, id, username, password);
      return tx.client.update({ where: { id }, data: clientData });
    });
  }

  // Ο χρήστης σύνδεσης του πελάτη — δημιουργία ΚΑΙ αλλαγή στο ίδιο σημείο, όπως
  // το setPackages: δεν υπάρχει users module (δες README#Αποφάσεις), οπότε αν το
  // create και το update το έγραφαν ξεχωριστά, το ένα από τα δύο θα ξέχναγε το
  // hashPassword ή το 409 του διπλού username.
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

  // Αντικατάσταση, όχι πρόσθεση: το panel στέλνει πάντα την τελική λίστα. Σβήνει
  // και ξαναγράφει αντί για upsert ανά γραμμή — ίδιο αποτέλεσμα, το ένα τρίτο του
  // κώδικα, και μέσα σε transaction ώστε να μη μείνει ποτέ πελάτης χωρίς όρια.
  private async setPackages(tx: PrismaTx, clientId: number, packages: OwnedPackage[]) {
    await tx.clientPackage.deleteMany({ where: { clientId } });
    // qty 0 = «δεν το έχει»: το panel στέλνει όλο τον κατάλογο με ποσότητες.
    const rows = packages.filter((p) => (p.qty ?? 1) > 0);
    if (!rows.length) return;
    try {
      await tx.clientPackage.createMany({
        data: rows.map((p) => ({ clientId, packageId: p.packageId, qty: p.qty ?? 1 })),
      });
    } catch (e) {
      // Ανύπαρκτο packageId: FK constraint. Χωρίς αυτό ο admin έβλεπε «HTTP 500».
      if (isForeignKeyError(e)) throw new BadRequestException('άγνωστο πακέτο στη λίστα');
      throw e;
    }
  }

  async remove(id: number) {
    await this.get(id);
    await this.prisma.client.delete({ where: { id } });
  }

  async addPath(clientId: number, path: string) {
    const client = await this.get(clientId);

    // Το όριο των πακέτων μετράει paths, όχι ταυτόχρονες εκπομπές — ο stream
    // server δεν το βλέπει καν. Ελέγχεται μόνο εδώ, τη στιγμή της προσθήκης:
    // paths που υπάρχουν ήδη δεν κόβονται αν αργότερα μικρύνει το πακέτο.
    const max = maxStreamsOf(client.packages);
    if (max && client.paths.length >= max) {
      throw new ConflictException(`τα πακέτα του πελάτη επιτρέπουν ${max} streams`);
    }

    // ≥16 chars base64url, δες PLAN-multitenant.md #2 — 16 bytes -> 22 χαρακτήρες.
    const key = randomBytes(16).toString('base64url');
    try {
      return await this.prisma.path.create({
        data: { path, key, clientId, serverId: client.serverId },
      });
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new ConflictException(`το path ${path} χρησιμοποιείται ήδη σε αυτόν τον server`);
      }
      throw e;
    }
  }

  async removePath(clientId: number, pathId: number) {
    const path = await this.prisma.path.findUnique({ where: { id: pathId } });
    if (!path || path.clientId !== clientId) throw new NotFoundException('path not found');
    await this.prisma.path.delete({ where: { id: pathId } });
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function isForeignKeyError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2003';
}
