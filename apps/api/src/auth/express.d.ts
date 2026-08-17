import { JwtPayload } from './jwt-payload';
import { Server } from '@prisma/client';

// Το JwtAuthGuard γράφει εδώ το verified payload· χωρίς αυτό κάθε req.user
// στους controllers/guards θα ήταν `any`. Το ServerTokenGuard γράφει το server
// (βρέθηκε ήδη εκεί) ώστε το sync controller να μην ξαναδιαβάζει τη βάση.
declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
      server?: Server;
    }
  }
}
