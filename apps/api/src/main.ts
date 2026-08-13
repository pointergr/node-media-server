import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Ανοιχτό CORS: το Nuxt panel (αναβάλλεται, δες PLAN-monorepo.md) θα ζει σε
  // άλλο origin/build, και η βάση παίκτη είναι λίγοι εσωτερικοί χρήστες —
  // δεν αξίζει allowlist συντήρησης πριν υπάρξει καν το panel.
  app.enableCors();
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`API listening on :${port}`);
}
bootstrap();
