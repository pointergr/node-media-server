// Το JWT_SECRET δεν έχει δρόμο αναδιπλωσης: με fallback ο server σηκώνεται
// κανονικά και υπογράφει tokens που φτιάχνει ο καθένας με το ίδιο string από το
// public source — δηλαδή admin, stream keys, restart servers, χωρίς κανένα σημάδι
// στα logs. Η αποτυχία εδώ είναι σκόπιμα θορυβώδης: η διεργασία δεν ξεκινάει.
export const MIN_SECRET = 32;

// Το μήκος από μόνο του δεν πιάνει τις τιμές που κυκλοφορούν στο ίδιο το repo,
// και ακριβώς αυτές θα δοκιμάσει πρώτος όποιος βρει τον κώδικα.
const KNOWN = ['βάλε-κάτι-τυχαίο-εδώ', 'dev-only-secret', 'changeme'];

export function jwtSecret(value = process.env.JWT_SECRET): string {
  const secret = (value ?? '').trim();
  if (secret.length < MIN_SECRET || KNOWN.some((k) => secret.includes(k))) {
    throw new Error(
      `JWT_SECRET: χρειάζεται τυχαίο μυστικό ≥${MIN_SECRET} χαρακτήρων (openssl rand -base64 32) — ο server δεν ξεκινάει χωρίς αυτό`,
    );
  }
  return secret;
}
