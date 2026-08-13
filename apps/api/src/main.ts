import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Χωρίς CORS επίτηδες: το panel σερβίρεται από τον ίδιο Caddy με το API
  // (`/api/*` → εδώ), και στο `npm run dev` το ίδιο κάνει το dev proxy του
  // Nuxt. Δεν υπάρχει νόμιμο cross-origin κάλεσμα να επιτρέψουμε.
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`API listening on :${port}`);
}
bootstrap();
