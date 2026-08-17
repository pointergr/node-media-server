import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY, Role } from './roles.decorator';

// Τρέχει μετά το JwtAuthGuard (σειρά δήλωσης στο app.module.ts): διαβάζει
// req.user που έβαλε εκείνο. Routes χωρίς @Roles() περνάνε ελεύθερα —
// ο έλεγχος «authenticated ή όχι» τον κάνει ήδη το JwtAuthGuard.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (!required.includes(req.user.role)) {
      throw new ForbiddenException('δεν επιτρέπεται για αυτόν τον ρόλο');
    }
    return true;
  }
}
