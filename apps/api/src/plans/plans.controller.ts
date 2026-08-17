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

interface PlanDto {
  name: string;
  maxViewers: number;
  maxStreams: number;
  // Πού πέφτουν οι νέες συνδρομές. Αλλάζοντάς το δεν μετακομίζει καμία παλιά —
  // η συνδρομή κρατάει τον δικό της (schema.prisma#Subscription).
  serverId: number;
}

// Χωρίς service: πέντε pass-through κλήσεις στο Prisma δεν χρειάζονται τρίτο
// αρχείο — ίδιο μοτίβο με το sync.controller.ts, που κάνει inject σκέτο
// PrismaService.
@Roles('admin')
@Controller('plans')
export class PlansController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.plan.findMany({
      include: { server: true, _count: { select: { subscriptions: true } } },
      orderBy: { maxViewers: 'asc' },
    });
  }

  @Post()
  create(@Body() body: Partial<PlanDto>) {
    const { name, maxViewers, maxStreams, serverId } = valid(body, true);
    return knownServer(
      this.prisma.plan.create({
        data: { name: name!, maxViewers: maxViewers!, maxStreams: maxStreams!, serverId: serverId! },
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<PlanDto>) {
    await this.byId(id);
    // Τα όρια αλλάζουν και για τις υπάρχουσες συνδρομές — τα διαβάζουν από εδώ,
    // δεν τα αντιγράφουν. Ο `serverId` όχι: αφορά μόνο τις επόμενες.
    return knownServer(this.prisma.plan.update({ where: { id }, data: valid(body, false) }));
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.byId(id);
    // Ρητός έλεγχος και όχι catch σε FK error: η διαγραφή θα άλλαζε σιωπηλά τα
    // όρια πελατών που κανείς δεν κοιτάζει εκείνη τη στιγμή. Ίδιο σκεπτικό με τον
    // server που έχει πλάνα ή paths (servers.service.ts).
    const subs = await this.prisma.subscription.count({ where: { planId: id } });
    if (subs) {
      throw new ConflictException(`το πλάνο το έχουν ${subs} συνδρομές — αφαίρεσέ το πρώτα από αυτές`);
    }
    await this.prisma.plan.delete({ where: { id } });
  }

  private async byId(id: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('plan not found');
    return plan;
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

// Τα όρια είναι ≥1: το 0 σημαίνει ήδη «χωρίς όριο» σε όλη τη διαδρομή ως τον
// stream server, και ένα πλάνο του μηδενός δεν πουλάει κανείς.
function valid(body: Partial<PlanDto>, required: boolean) {
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
