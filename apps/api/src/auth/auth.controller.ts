import { BadRequestException, Body, Controller, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @HttpCode(200)
  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    if (!body?.username || !body?.password) {
      throw new BadRequestException('username και password απαιτούνται');
    }
    return this.auth.login(body.username, body.password);
  }

  // Το billing ζητάει link για τον πελάτη του (admin, άρα και API key), ο browser
  // του πελάτη ανταλλάσσει το token με συνεδρία (@Public — δεν έχει ακόμα token).
  @Roles('admin')
  @HttpCode(200)
  @Post('login-link')
  loginLink(@Req() req: Request, @Body() body: { clientId?: number }) {
    if (!body?.clientId) throw new BadRequestException('clientId απαιτείται');
    // Panel και API μοιράζονται host (ο Caddy κόβει το `/api`), οπότε η διεύθυνση
    // του panel είναι αυτή που κάλεσε — καμία ρύθμιση να ξεχαστεί. Το PANEL_URL
    // χρειάζεται μόνο στο `npm run dev`, όπου το Nuxt είναι σε άλλη θύρα.
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0];
    return this.auth.loginLink(body.clientId, process.env.PANEL_URL ?? `${proto}://${req.headers.host}`);
  }

  @Public()
  @HttpCode(200)
  @Post('exchange')
  exchange(@Body() body: { token?: string }) {
    if (!body?.token) throw new BadRequestException('token απαιτείται');
    return this.auth.exchange(body.token);
  }

  // Χωρίς @Roles(): το JwtAuthGuard αρκεί, ο καθένας αλλάζει μόνο τον δικό του
  // λογαριασμό (το id βγαίνει από το token). Εδώ και όχι σε users module — δες
  // README#Αποφάσεις, ο admin δεν έχει άλλο τρόπο να αλλάξει κωδικό.
  @Patch('me')
  changeOwn(
    @Req() req: Request,
    @Body() body: { currentPassword?: string; username?: string; password?: string },
  ) {
    if (!body?.currentPassword) throw new BadRequestException('currentPassword απαιτείται');
    if (!body.username && !body.password) {
      throw new BadRequestException('δώσε username ή password (ή και τα δύο)');
    }
    return this.auth.changeOwn(req.user.sub, body.currentPassword, body.username, body.password);
  }
}
