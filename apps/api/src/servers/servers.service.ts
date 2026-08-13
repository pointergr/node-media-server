import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateServerDto {
  host: string;
  adminUrl: string;
  adminUser: string;
  adminPass: string;
  token?: string;
}

export type UpdateServerDto = Partial<CreateServerDto>;

@Injectable()
export class ServersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.server.findMany({ include: { _count: { select: { clients: true } } } });
  }

  async get(id: number) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('server not found');
    return server;
  }

  async byHost(host: string) {
    const server = await this.prisma.server.findUnique({ where: { host } });
    if (!server) throw new NotFoundException('server not found');
    return server;
  }

  create(dto: CreateServerDto) {
    return this.prisma.server.create({
      data: { ...dto, token: dto.token || randomBytes(24).toString('base64url') },
    });
  }

  async update(id: number, dto: UpdateServerDto) {
    await this.get(id);
    return this.prisma.server.update({ where: { id }, data: dto });
  }

  async remove(id: number) {
    await this.get(id);
    await this.prisma.server.delete({ where: { id } });
  }

  // Proxy με basic auth προς το /admin/api του stream server — το ίδιο auth
  // που χρησιμοποιεί το dashboard του (stats.js), βλέπε CLAUDE.md.
  async proxy(host: string, path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<unknown> {
    const server = await this.byHost(host);
    const auth = Buffer.from(`${server.adminUser}:${server.adminPass}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${server.adminUrl}${path}`, {
        method,
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      throw new BadGatewayException(`stream server unreachable: ${(e as Error).message}`);
    }
    if (!res.ok) throw new BadGatewayException(`stream server responded ${res.status}`);
    return res.json();
  }
}
