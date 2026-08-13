import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { verifyPassword } from './password';
import { JwtPayload } from './jwt-payload';
import { Role } from './roles.decorator';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string): Promise<{ access_token: string }> {
    const user = await this.prisma.user.findUnique({ where: { username } });
    // Ίδιο μήνυμα λάθους/απόντος χρήστη — δεν αποκαλύπτουμε ποια από τα δύο ίσχυε.
    if (!user || !verifyPassword(password, user.password)) {
      throw new UnauthorizedException('λάθος στοιχεία σύνδεσης');
    }
    const payload: JwtPayload = { sub: user.id, role: user.role as Role, clientId: user.clientId };
    return { access_token: await this.jwt.signAsync(payload) };
  }
}
