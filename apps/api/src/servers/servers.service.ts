import { BadGatewayException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

// Τα μυστικά του stream server (bearer του sync, κωδικός του /admin) δεν φεύγουν
// ποτέ σε ανάγνωση: τα έδινε ολόκληρα κάθε GET /servers, δηλαδή και κάθε API key
// (jwt-auth.guard: ρόλος admin, χωρίς scopes). Το token φαίνεται **μία φορά**,
// στην απάντηση του POST — από εκεί το παίρνει το install script και το panel.
const noSecrets = { omit: { token: true, adminPass: true } } as const;

// Ρητά πεδία και όχι spread του dto: ό,τι άλλο στείλει ο caller δεν φτάνει στο
// Prisma (άγνωστο κλειδί = 500, γνωστό = αλλαγή που δεν ζήτησε κανείς).
const fields = ({ host, adminUrl, adminUser, adminPass, token }: UpdateServerDto) => ({
  host,
  adminUrl,
  adminUser,
  adminPass,
  token,
});

@Injectable()
export class ServersService {
  constructor(private readonly prisma: PrismaService) {}

  // Πλήθος πλάνων που πουλάνε εδώ, συνδρομών που κάθονται εδώ και paths που ζουν
  // εδώ — όχι πελατών: ο πελάτης δεν ανήκει σε server πια (schema.prisma), και το
  // _count δεν ξέρει distinct πάνω από τις συνδρομές.
  list() {
    return this.prisma.server.findMany({
      ...noSecrets,
      include: { _count: { select: { plans: true, subscriptions: true, paths: true } } },
    });
  }

  async get(id: number) {
    const server = await this.prisma.server.findUnique({ where: { id }, ...noSecrets });
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
      data: {
        host: dto.host,
        adminUrl: dto.adminUrl,
        adminUser: dto.adminUser,
        adminPass: dto.adminPass,
        token: dto.token || randomBytes(24).toString('base64url'),
      },
    });
  }

  async update(id: number, dto: UpdateServerDto) {
    await this.get(id);
    return this.prisma.server.update({ where: { id }, data: fields(dto), ...noSecrets });
  }

  async remove(id: number) {
    await this.get(id);
    try {
      await this.prisma.server.delete({ where: { id } });
    } catch (e) {
      // Τίποτα ΔΕΝ κάνει cascade με τον server επίτηδες: το να σβήνεις server
      // και να εξαφανίζονται σιωπηλά paths, κλειδιά και αγορές πελατών είναι
      // χειρότερο από ένα σφάλμα. Χωρίς αυτό το catch έβγαινε 500.
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2003') {
        throw new ConflictException('ο server χρησιμοποιείται από πλάνα, συνδρομές ή paths — σβήσε πρώτα αυτά');
      }
      throw e;
    }
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
