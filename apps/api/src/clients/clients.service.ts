import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/password';

export interface CreateClientDto {
  name: string;
  serverId: number;
  limit?: number;
  // Προαιρετικά: φτιάχνει και τον customer χρήστη μαζί με τον πελάτη — δεν
  // υπάρχει ξεχωριστό endpoint για users, δες README.md.
  username?: string;
  password?: string;
}

export type UpdateClientDto = Partial<Pick<CreateClientDto, 'name' | 'limit' | 'serverId'>> & {
  disabled?: boolean;
};

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.client.findMany({ include: { paths: true, server: true } });
  }

  async get(id: number) {
    const client = await this.prisma.client.findUnique({ where: { id }, include: { paths: true, server: true } });
    if (!client) throw new NotFoundException('client not found');
    return client;
  }

  async create(dto: CreateClientDto) {
    const { username, password, ...clientData } = dto;
    return this.prisma.$transaction(async (tx) => {
      const client = await tx.client.create({ data: clientData });
      if (username && password) {
        await tx.user.create({
          data: { username, password: hashPassword(password), role: 'customer', clientId: client.id },
        });
      }
      return client;
    });
  }

  async update(id: number, dto: UpdateClientDto) {
    await this.get(id);
    return this.prisma.client.update({ where: { id }, data: dto });
  }

  async remove(id: number) {
    await this.get(id);
    await this.prisma.client.delete({ where: { id } });
  }

  async addPath(clientId: number, path: string) {
    const client = await this.get(clientId);
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
