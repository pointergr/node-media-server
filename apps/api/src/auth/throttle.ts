import { HttpException, HttpStatus } from '@nestjs/common';

// Μετρητής αποτυχημένων προσπαθειών σύνδεσης. Μόνο οι **αποτυχίες** μετράνε και
// η επιτυχία μηδενίζει: ένα όριο «Χ αιτήματα το λεπτό» θα έκοβε και τον πελάτη
// που δουλεύει κανονικά, ενώ αυτό που πρέπει να σταματήσει είναι το μαντεψιμο —
// και μαζί του το CPU κόστος του scrypt ανά προσπάθεια.
//
// ponytail: Map στη μνήμη ενός process (ίδια λογιστική με το `spent` του
// auth.service) — με δεύτερο instance θέλει κοινό store, π.χ. Redis.
export const MAX_FAILS = 10;
export const WINDOW_MS = 15 * 60_000;
// Πάνω από αυτό καθαρίζουμε τις ληγμένες: το κλειδί το ορίζει ο caller (IP και
// username), οπότε χωρίς κλάδεμα ένας επιτιθέμενος γεμίζει τη μνήμη με μία
// γραμμή ανά προσπάθεια.
const PRUNE_AT = 5000;

const fails = new Map<string, { n: number; until: number }>();

// Πριν από την ακριβή δουλειά (scrypt): κλειδωμένο κλειδί δεν φτάνει ποτέ εκεί.
export function checkAttempts(key: string): void {
  const hit = fails.get(key);
  if (hit && hit.n >= MAX_FAILS && hit.until > Date.now()) {
    throw new HttpException(
      'πάρα πολλές αποτυχημένες προσπάθειες — δοκίμασε ξανά σε λίγο',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export function failedAttempt(key: string): void {
  const now = Date.now();
  const hit = fails.get(key);
  if (!hit || hit.until <= now) fails.set(key, { n: 1, until: now + WINDOW_MS });
  else hit.n++;
  if (fails.size > PRUNE_AT) {
    for (const [k, v] of fails) if (v.until <= now) fails.delete(k);
  }
}

export function resetAttempts(key: string): void {
  fails.delete(key);
}
