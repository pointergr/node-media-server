import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Ο Caddy είναι μπροστά (apps/api/Caddyfile): χωρίς αυτό κάθε αίτημα φαίνεται
  // να έρχεται από εκείνον, δηλαδή το φρενάρισμα του login (auth/throttle.ts)
  // θα μετρούσε όλο τον κόσμο σε μία IP. Ένα άλμα, όχι `true`: με `true` ο
  // καθένας δηλώνει όποια IP θέλει στο X-Forwarded-For.
  app.set('trust proxy', 1);
  // Χωρίς CORS επίτηδες: το panel σερβίρεται από τον ίδιο Caddy με το API
  // (`/api/*` → εδώ), και στο `npm run dev` το ίδιο κάνει το dev proxy του
  // Nuxt. Δεν υπάρχει νόμιμο cross-origin κάλεσμα να επιτρέψουμε.
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`API listening on :${port}`);
}
bootstrap();
