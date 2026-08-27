import { Role } from './roles.decorator';

// sub = User.id. clientId null για admin.
export interface JwtPayload {
  sub: number;
  role: Role;
  clientId: number | null;
}
