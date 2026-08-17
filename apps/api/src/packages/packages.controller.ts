import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../auth/roles.decorator';

interface PackageDto {
  name: string;
  maxViewers: number;
  maxStreams: number;
  // Πού πέφτουν οι νέες αγορές. Αλλάζοντάς το δεν μετακομίζει καμία παλιά —
  // η αγορά κρατάει τον δικό της (schema.prisma#ClientPackage).
  serverId: number;
}

// Χωρίς service: πέντε pass-through κλήσεις στο Prisma δεν χρειάζονται τρίτο
// αρχείο — ίδιο μοτίβο με το sync.controller.ts, που κάνει inject σκέτο
// PrismaService. Ό,τι έχει λογική (το άθροισμα των ορίων) ζει στο clients.service.
@Roles('admin')
@Controller('packages')
export class PackagesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.package.findMany({
      include: { server: true, _count: { select: { clients: true } } },
      orderBy: { maxViewers: 'asc' },
    });
  }

  @Post()
  create(@Body() body: Partial<PackageDto>) {
    const { name, maxViewers, maxStreams, serverId } = valid(body, true);
    return knownServer(
      this.prisma.package.create({
        data: { name: name!, maxViewers: maxViewers!, maxStreams: maxStreams!, serverId: serverId! },
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<PackageDto>) {
    await this.byId(id);
    return knownServer(this.prisma.package.update({ where: { id }, data: valid(body, false) }));
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.byId(id);
    // Ρητός έλεγχος και όχι catch σε FK error: η διαγραφή θα άλλαζε σιωπηλά τα
    // όρια πελατών που κανείς δεν κοιτάζει εκείνη τη στιγμή. Ίδιο σκεπτικό με τον
    // server που έχει πελάτες (servers.service.ts).
    const clients = await this.prisma.clientPackage.count({ where: { packageId: id } });
    if (clients) {
      throw new ConflictException(`το πακέτο το χρησιμοποιούν ${clients} πελάτες — αφαίρεσέ το πρώτα από αυτούς`);
    }
    await this.prisma.package.delete({ where: { id } });
  }

  private async byId(id: number) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('package not found');
    return pkg;
  }
}

// Ανύπαρκτο serverId: FK constraint. Χωρίς αυτό ο admin έβλεπε «HTTP 500».
async function knownServer<T>(op: Promise<T>): Promise<T> {
  try {
    return await op;
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2003') {
      throw new BadRequestException('άγνωστος server');
    }
    throw e;
  }
}

// Τα όρια είναι ≥1: το 0 μέσα σε άθροισμα θα ζητούσε τον κανόνα «0 = απεριόριστο»
// (100 + 0 = ∞). Απεριόριστος πελάτης = πελάτης χωρίς πακέτα — δες schema.prisma.
function valid(body: Partial<PackageDto>, required: boolean) {
  if (required && !body.name) throw new BadRequestException('name απαιτείται');
  if (required && !body.serverId) throw new BadRequestException('serverId απαιτείται');
  for (const field of ['maxViewers', 'maxStreams'] as const) {
    const v = body[field];
    if (v === undefined) {
      if (required) throw new BadRequestException(`${field} απαιτείται`);
      continue;
    }
    if (!Number.isInteger(v) || v < 1) throw new BadRequestException(`${field}: ακέραιος ≥ 1`);
  }
  return body;
}
