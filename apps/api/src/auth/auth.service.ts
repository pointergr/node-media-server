import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
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

  // Ο κάθε χρήστης αλλάζει τα δικά του στοιχεία — ένα endpoint και για τον admin
  // και για τον πελάτη, γιατί ο έλεγχος είναι ο ίδιος: το `sub` του token, ποτέ
  // id από το σώμα (αλλιώς ο πελάτης θα άλλαζε τον κωδικό του admin).
  async changeOwn(userId: number, currentPassword: string, username?: string, password?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // Το token μόνο δεν αρκεί: μια συνεδρία που έμεινε ανοιχτή σε ξένο μηχάνημα
    // δεν πρέπει να μπορεί να κλειδώσει έξω τον κάτοχο του λογαριασμού.
    if (!user || !verifyPassword(currentPassword, user.password)) {
      throw new UnauthorizedException('λάθος τρέχων κωδικός');
    }
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { username, password: password ? hashPassword(password) : undefined },
      });
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new ConflictException(`το όνομα χρήστη ${username} χρησιμοποιείται ήδη`);
      }
      throw e;
    }
    // Κανένα νέο token: το payload (sub/role/clientId) δεν αλλάζει από αυτά τα
    // δύο πεδία, οπότε η συνεδρία συνεχίζει κανονικά ως τη λήξη της.
  }
}
