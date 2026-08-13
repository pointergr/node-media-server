import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    JwtModule.register({
      // Το ίδιο secret πρέπει να μένει σταθερό ανάμεσα σε restarts, αλλιώς κάθε
      // deploy αποσυνδέει όλους — γι' αυτό είναι env var, όχι τυχαίο στο boot
      // (διαφορετικά από το jwt secret του stream server, που είναι per-server
      // και δεν πειράζει να αλλάζει).
      secret: process.env.JWT_SECRET ?? 'dev-only-secret-ΑΛΛΑΞΕ-ΤΟ',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  // JwtModule εδώ για να το χρησιμοποιεί και το global JwtAuthGuard (app.module.ts).
  exports: [JwtModule],
})
export class AuthModule {}
