import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import { JwtPayload } from './jwt-payload';
import { KEY_PREFIX, hashKey } from './apikey';
import { PrismaService } from '../prisma/prisma.service';

// Global guard (βλέπε app.module.ts): κάθε route περνάει από εδώ εκτός αν
// έχει @Public(). Χωρίς passport — το JwtService αρκεί για verify.
//
// Δύο είδη bearer στην ίδια κεφαλίδα: JWT για ανθρώπους (12ωρο, από το
// /auth/login) και API key για εξωτερικές υπηρεσίες (μόνιμο, από το apikey.js).
// Ό,τι είναι κατάντη — RolesGuard, @Roles('admin'), το φιλτράρισμα του /me με το
// clientId — διαβάζει μόνο το req.user και δεν ξέρει ποιο από τα δύο ήταν.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new UnauthorizedException('λείπει το token');

    if (token.startsWith(KEY_PREFIX)) {
      req.user = await this.apiKeyUser(token);
      return true;
    }

    try {
      req.user = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('άκυρο token');
    }
    return true;
  }

  // Το key ζει hashed, οπότε η αναζήτηση γίνεται στο sha256 — δεν χρειάζεται
  // timingSafeEqual όπως στον ServerTokenGuard: εδώ δεν συγκρίνουμε μυστικά,
  // κάνουμε lookup σε unique index.
  private async apiKeyUser(token: string): Promise<JwtPayload> {
    const row = await this.prisma.apiKey.findUnique({ where: { hash: hashKey(token) } });
    if (!row) throw new UnauthorizedException('άκυρο api key');
    await this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsed: new Date() } });
    // Αρνητικό sub: δεν είναι User.id και δεν πρέπει να μπερδευτεί με κανέναν.
    // Το μόνο endpoint που το χρησιμοποιεί για lookup είναι το PATCH /auth/me,
    // που έτσι δεν βρίσκει χρήστη και απαντάει 401 — σωστό, ένα key δεν έχει
    // λογαριασμό να αλλάξει.
    return { sub: -row.id, role: 'admin', clientId: null };
  }
}
