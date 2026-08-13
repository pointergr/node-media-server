import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

// Ξεχωριστός guard από το JWT: ο stream server δεν συνδέεται ποτέ, στέλνει
// ένα static bearer token ανά server (Server.token). Η route είναι @Public()
// ως προς το global JwtAuthGuard και προστατεύεται μόνο από αυτόν εδώ.
@Injectable()
export class ServerTokenGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const host = req.params.host as string | undefined;
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const server = host ? await this.prisma.server.findUnique({ where: { host } }) : null;

    if (!server || !token || !timingSafeEqualStrings(token, server.token)) {
      throw new UnauthorizedException('άκυρο server token');
    }
    // Ώστε ο controller να μη ξαναδιαβάζει το Server από τη βάση.
    req.server = server;
    return true;
  }
}

// timingSafeEqual σκάει αν τα μήκη διαφέρουν — συνηθισμένο όταν το token είναι
// λάθος, όχι λόγο να διαρρεύσει stack trace στο 500 αντί για καθαρό 401.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
