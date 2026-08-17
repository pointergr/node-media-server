import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { JwtPayload } from './jwt-payload';
import { Role } from './roles.decorator';

// Δευτερόλεπτα ζωής του link: όσο χρειάζεται ένα redirect, όχι όσο κρατάει ένα
// email. Ό,τι μεγαλύτερο είναι κωδικός σε URL.
const LINK_TTL = 300;

@Injectable()
export class AuthService {
  // jti των link που ξοδεύτηκαν — μία χρήση. Στη μνήμη: restart του API τα
  // ξεχνάει, δηλαδή ένα link ξαναχρησιμοποιείται μέσα στα 5' του. Η εναλλακτική
  // είναι πίνακας στη sqlite για δεδομένα που ζουν πέντε λεπτά.
  private readonly spent = new Set<string>();

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

  // Link σύνδεσης για εξωτερικό σύστημα (billing): στέλνει τον πελάτη στο panel
  // χωρίς να ξέρει ή να εκθέτει τον κωδικό του. Το token του link **δεν** είναι
  // συνεδρία — αλλιώς θα διαλέγαμε ανάμεσα σε «η συνεδρία λήγει σε 5'» και «το
  // link ανοίγει τον λογαριασμό για 12 ώρες». Το panel το ξοδεύει αμέσως στο
  // exchange() και παίρνει κανονικό token.
  async loginLink(clientId: number, panelUrl: string) {
    // Το σχήμα επιτρέπει πολλούς χρήστες ανά πελάτη, η πράξη έχει έναν (δες
    // clients.service#setUser).
    const user = await this.prisma.user.findFirst({ where: { clientId } });
    if (!user) {
      throw new BadRequestException('ο πελάτης δεν έχει χρήστη σύνδεσης — δώσε username/password στο PATCH /clients/:id');
    }
    const payload: JwtPayload & { once: true } = {
      sub: user.id,
      role: user.role as Role,
      clientId: user.clientId,
      // Ο διαχωρισμός link/συνεδρίας: χωρίς αυτό, όποιος έχει συνεδρία θα την
      // ανανέωνε επ' άπειρον περνώντας το token του από το exchange().
      once: true,
    };
    const token = await this.jwt.signAsync(payload, {
      expiresIn: LINK_TTL,
      jwtid: randomUUID(),
    });
    // Στο fragment και όχι σε query: δεν φτάνει σε server log, ούτε σε Referer.
    return { url: `${panelUrl}/login#t=${token}`, expiresIn: LINK_TTL };
  }

  async exchange(token: string): Promise<{ access_token: string }> {
    let claims: JwtPayload & { once?: boolean; jti?: string };
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('άκυρο ή ληγμένο link');
    }
    // Ίδιο μήνυμα και για «δεν είναι link» και για «ξοδεύτηκε»: το link έχει
    // φύγει με email ή σε redirect, δεν λέμε σε τρίτο τι κρατάει.
    if (!claims.once || !claims.jti || this.spent.has(claims.jti)) {
      throw new UnauthorizedException('άκυρο ή ληγμένο link');
    }
    this.spent.add(claims.jti);
    // Το ξεχνάμε μόλις λήξει το token — από εκεί και πέρα το verify το κόβει.
    setTimeout(() => this.spent.delete(claims.jti!), LINK_TTL * 1000).unref();

    const payload: JwtPayload = { sub: claims.sub, role: claims.role, clientId: claims.clientId };
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
