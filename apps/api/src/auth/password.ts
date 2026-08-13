import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scryptSync αντί για bcrypt/argon: node:crypto είναι ήδη εδώ, καμία native
// εξάρτηση στο image (ίδια λογιστική με το Dockerfile.slim του stream server).
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  // scryptSync με λάθος μήκος αναμενόμενου hash θα έσκαγε στο timingSafeEqual,
  // όχι επειδή ο κωδικός είναι λάθος — προλαβαίνουμε το πριν συγκρίνουμε.
  const got = scryptSync(password, salt, expected.length);
  return timingSafeEqual(got, expected);
}
