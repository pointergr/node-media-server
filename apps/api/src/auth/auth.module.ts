import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { jwtSecret } from './secret';

@Module({
  imports: [
    JwtModule.register({
      // Το ίδιο secret πρέπει να μένει σταθερό ανάμεσα σε restarts, αλλιώς κάθε
      // deploy αποσυνδέει όλους — γι' αυτό είναι env var, όχι τυχαίο στο boot
      // (διαφορετικά από το jwt secret του stream server, που είναι per-server
      // και δεν πειράζει να αλλάζει).
      // Χωρίς fallback, επίτηδες: δες secret.ts — σκάει στο boot, δεν υποβαθμίζεται.
      secret: jwtSecret(),
      signOptions: { expiresIn: '12h', algorithm: 'HS256' },
      // Καρφωμένος αλγόριθμος και στο verify (το JwtService τα συγχωνεύει σε κάθε
      // verifyAsync, οπότε ισχύει και για τον guard και για το exchange): χωρίς
      // αυτό ο έλεγχος δέχεται ό,τι λέει η κεφαλίδα του ίδιου του token.
      verifyOptions: { algorithms: ['HS256'] },
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  // JwtModule εδώ για να το χρησιμοποιεί και το global JwtAuthGuard (app.module.ts).
  exports: [JwtModule],
})
export class AuthModule {}
