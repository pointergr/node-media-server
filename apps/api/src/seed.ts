// npm run seed -w apps/api — φτιάχνει τον πρώτο admin χρήστη. Ιδιαίτερα
// αρχείο (όχι Nest module): τρέχει μία φορά, δεν χρειάζεται DI container.
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from './auth/password';

async function main() {
  const prisma = new PrismaClient();
  const username = process.env.SEED_ADMIN_USER ?? 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.error(`ο χρήστης "${username}" υπάρχει ήδη — δεν έγινε τίποτα`);
    await prisma.$disconnect();
    return;
  }

  await prisma.user.create({
    data: { username, password: hashPassword(password), role: 'admin', clientId: null },
  });

  console.log(`admin: ${username}`);
  if (!process.env.SEED_ADMIN_PASSWORD) console.log(`password (τυχαίος, σημείωσέ τον): ${password}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
