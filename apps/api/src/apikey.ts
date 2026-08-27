// node dist/src/apikey.js <όνομα>            — φτιάχνει κλειδί για εξωτερική υπηρεσία
// node dist/src/apikey.js list               — ποια υπάρχουν και πότε χρησιμοποιήθηκαν
// node dist/src/apikey.js revoke <id|όνομα>  — ανάκληση
//
// Ξεχωριστό αρχείο, όχι Nest module — ίδια λογική με το seed.ts: τρέχει σπάνια,
// δεν χρειάζεται DI container. Οθόνη στο /admin θα μπει αν φανεί ότι χρειάζεται·
// σήμερα τα κλειδιά τα δίνει όποιος έχει shell, όπως και το seed.
import { PrismaClient } from '@prisma/client';
import { hashKey, newKey } from './auth/apikey';

async function main() {
  const prisma = new PrismaClient();
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'list') {
    const keys = await prisma.apiKey.findMany({ orderBy: { id: 'asc' } });
    for (const k of keys) {
      console.log(`${k.id}\t${k.name}\t${k.lastUsed ? `τελευταία χρήση ${k.lastUsed.toISOString()}` : 'αχρησιμοποίητο'}`);
    }
    if (!keys.length) console.log('κανένα κλειδί');
  }
  else if (cmd === 'revoke') {
    if (!arg) throw new Error('δώσε id ή όνομα: apikey.js revoke <id|όνομα>');
    // Με id ή με όνομα: το όνομα δεν είναι unique, οπότε η ανάκληση με όνομα
    // παίρνει όλα τα κλειδιά αυτής της υπηρεσίας — αυτό ακριβώς θέλεις όταν
    // κάποιος έφυγε και δεν ξέρεις πόσα του είχες δώσει.
    const where = /^\d+$/.test(arg) ? { id: Number(arg) } : { name: arg };
    const { count } = await prisma.apiKey.deleteMany({ where });
    console.log(count ? `ανακλήθηκαν ${count}` : 'δεν βρέθηκε κλειδί');
  }
  else if (cmd) {
    const key = newKey();
    await prisma.apiKey.create({ data: { name: cmd, hash: hashKey(key) } });
    // Μία και μόνη φορά: αποθηκεύεται μόνο το sha256, δεύτερη ευκαιρία δεν υπάρχει.
    console.log(`κλειδί για «${cmd}» (σημείωσέ το τώρα, δεν ξαναφαίνεται):`);
    console.log(key);
  }
  else {
    throw new Error('χρήση: apikey.js <όνομα> | list | revoke <id|όνομα>');
  }

  await prisma.$disconnect();
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
