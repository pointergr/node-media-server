import { createHash, randomBytes } from 'node:crypto';

// Πρόθεμα ώστε ο guard να ξεχωρίζει key από JWT χωρίς να δοκιμάζει και τα δύο —
// και ώστε ένα key που ξέφυγε σε log ή σε repo να αναγνωρίζεται με ένα grep.
export const KEY_PREFIX = 'pk_';

export const newKey = (): string => KEY_PREFIX + randomBytes(24).toString('base64url');

// sha256 και όχι scrypt: το verify τρέχει σε κάθε αίτημα, ενώ το scrypt του
// password.ts είναι σκόπιμα αργό. Δεν χρειάζεται και salt — το κλειδί είναι ήδη
// 24 τυχαία bytes, δεν υπάρχει λεξικό να το μαντέψει.
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');
