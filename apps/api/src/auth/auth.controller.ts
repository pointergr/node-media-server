import { BadRequestException, Body, Controller, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

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
