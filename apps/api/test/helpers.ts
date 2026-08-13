// Κοινά βοηθήματα του e2e test: φτιάχνει προσωρινό sqlite, εφαρμόζει το schema
// με `prisma db push` (χωρίς migrations — δεν αξίζουν για ένα sqlite dev/test
// db) και σηκώνει το πραγματικό Nest app σε τυχαία θύρα.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';

export async function setupTestDb(): Promise<{ dbPath: string; databaseUrl: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-test-'));
  const dbPath = path.join(dir, 'test.db');
  const databaseUrl = `file:${dbPath}`;

  // __dirname εδώ είναι dist/test — το schema ζει στο apps/api/prisma.
  const schema = path.join(__dirname, '..', '..', 'prisma', 'schema.prisma');
  const prismaCli = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'prisma', 'build', 'index.js');

  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schema], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  return { dbPath, databaseUrl };
}

export async function startTestApp(): Promise<{ app: INestApplication; base: string }> {
  // Dynamic import: χρειάζεται το process.env.DATABASE_URL/JWT_SECRET ήδη
  // ορισμένα πριν φορτωθεί το PrismaClient (διαβάζει το env στο constructor).
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, base };
}
