// npm run seed -w apps/api — φτιάχνει τον πρώτο admin χρήστη. Ιδιαίτερα
// αρχείο (όχι Nest module): τρέχει μία φορά, δεν χρειάζεται DI container.
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from './auth/password';

async function main() {
  const prisma = new PrismaClient();
  const username = process.env.SEED_ADMIN_USER ?? 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');

  // Θετικό argument και όχι flag: ίδια σύμβαση με το `generate-passwords <host>
  // force` του stream server (apps/stream/passwords.js).
  const force = process.argv[2] === 'force';

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing && !force) {
    console.error(`ο χρήστης "${username}" υπάρχει ήδη — δεν έγινε τίποτα (πρόσθεσε "force" για νέο κωδικό)`);
    await prisma.$disconnect();
    return;
  }
  // Ο χαμένος κωδικός admin δεν είχε δρόμο μέσα από την εφαρμογή: το
  // PATCH /auth/me ζητάει τον τρέχοντα και δεν υπάρχει δεύτερος admin να κάνει
  // reset — η μόνη λύση ήταν UPDATE στη sqlite με το χέρι. Δεν είναι νέα τρύπα:
  // το `force` θέλει shell στο container, δηλαδή ό,τι ήθελε και το χειροκίνητο
  // UPDATE. Μόνο ο κωδικός γράφεται, όχι ο ρόλος: αλλιώς ένα `force` σε λάθος
  // username θα προήγαγε σιωπηλά έναν πελάτη σε admin.
  if (existing) {
    if (existing.role !== 'admin') throw new Error(`ο χρήστης "${username}" δεν είναι admin — δες apps/api/README.md`);
    await prisma.user.update({ where: { id: existing.id }, data: { password: await hashPassword(password) } });
  }
  else {
    await prisma.user.create({
      data: { username, password: await hashPassword(password), role: 'admin', clientId: null },
    });
  }

  console.log(`admin: ${username}${existing ? ' (νέος κωδικός)' : ''}`);
  if (!process.env.SEED_ADMIN_PASSWORD) console.log(`password (τυχαίος, σημείωσέ τον): ${password}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
