import { BadRequestException } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// scrypt αντί για bcrypt/argon: node:crypto είναι ήδη εδώ, καμία native
// εξάρτηση στο image (ίδια λογιστική με το Dockerfile.slim του stream server).
// **Ασύγχρονο** και όχι scryptSync: το scrypt είναι σκόπιμα ακριβό, οπότε στην
// σύγχρονη μορφή του κάθε προσπάθεια σύνδεσης κρατούσε τον event loop — δηλαδή
// μερικά αιτήματα το δευτερόλεπτο πάγωναν όλο το panel. Η αργή δουλειά τώρα
// τρέχει στο threadpool της libuv.
const scryptAsync = promisify(scrypt) as (pass: string, salt: string, len: number) => Promise<Buffer>;
const KEYLEN = 64;

// Το ελάχιστο μήκος ζει **εδώ** και όχι στους callers: κωδικό γράφουν τρία
// σημεία (admin για πελάτη, ο καθένας για τον εαυτό του, το seed) και ένας
// έλεγχος ανά σημείο σημαίνει ότι κάποιο θα τον ξεχάσει.
export const MIN_PASSWORD = 8;

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new BadRequestException(`ο κωδικός θέλει τουλάχιστον ${MIN_PASSWORD} χαρακτήρες`);
  }
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, KEYLEN);
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  // scrypt με λάθος μήκος αναμενόμενου hash θα έσκαγε στο timingSafeEqual,
  // όχι επειδή ο κωδικός είναι λάθος — προλαβαίνουμε το πριν συγκρίνουμε.
  const got = await scryptAsync(password, salt, expected.length);
  return timingSafeEqual(got, expected);
}
