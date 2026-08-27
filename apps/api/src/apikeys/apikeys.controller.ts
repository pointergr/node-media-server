import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../auth/roles.decorator';
import { hashKey, newKey } from '../auth/apikey';
import { humanOnly } from '../auth/human-only';

// Ό,τι κάνει το src/apikey.ts από shell, με οθόνη — ίδια βάση, ίδιο newKey/hashKey.
// Το CLI μένει: σε μηχάνημα χωρίς λειτουργικό panel (ή με χαμένο κωδικό admin)
// είναι ο μόνος δρόμος.
//
// Χωρίς service class: τρία prisma calls χωρίς λογική ανάμεσα, ένα service θα
// ήταν pass-through.
@Roles('admin')
@Controller('apikeys')
export class ApiKeysController {
  constructor(private readonly prisma: PrismaService) {}

  // Ποτέ το hash: δεν χρησιμεύει σε καμία οθόνη και είναι ό,τι ακριβώς χρειάζεται
  // κάποιος για να δοκιμάσει κλειδιά εκτός σύνδεσης.
  @Get()
  async list(@Req() req: Request) {
    humanOnly(req);
    return this.prisma.apiKey.findMany({
      select: { id: true, name: true, lastUsed: true },
      orderBy: { id: 'asc' },
    });
  }

  @Post()
  async create(@Req() req: Request, @Body() body: { name?: string }) {
    humanOnly(req);
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('το όνομα είναι υποχρεωτικό');
    const key = newKey();
    const row = await this.prisma.apiKey.create({ data: { name, hash: hashKey(key) } });
    // Η μόνη φορά που φεύγει η τιμή από εδώ — αποθηκεύεται μόνο το sha256.
    return { id: row.id, name: row.name, key };
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    humanOnly(req);
    const { count } = await this.prisma.apiKey.deleteMany({ where: { id } });
    if (!count) throw new NotFoundException('το κλειδί δεν βρέθηκε');
    return { ok: true };
  }
}
