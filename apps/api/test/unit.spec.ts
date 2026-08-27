// Καθαρές συναρτήσεις, χωρίς Nest και χωρίς sqlite: ό,τι μπορεί να ελεγχθεί
// χωρίς να σηκωθεί το app ζει εδώ — το api.spec.ts πληρώνει ένα `prisma db push`
// ανά τρέξιμο και δεν αξίζει για έναν έλεγχο μήκους.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jwtSecret } from '../src/auth/secret';
import { cleanDestination } from '../src/clients/destinations';
import { hashPassword, verifyPassword, MIN_PASSWORD } from '../src/auth/password';
import { failedAttempt, resetAttempts, checkAttempts, MAX_FAILS } from '../src/auth/throttle';

test('JWT_SECRET: ό,τι δεν είναι πραγματικό μυστικό ρίχνει τη διεργασία', () => {
  assert.throws(() => jwtSecret(undefined), /JWT_SECRET/);
  assert.throws(() => jwtSecret(''), /JWT_SECRET/);
  // Το .env.example δεν κουβαλάει τιμή που «δουλεύει»: όποιος το αντιγράψει
  // όπως του λέει το header πρέπει να σταματήσει εδώ, όχι σε production με
  // δημόσια γνωστό secret.
  assert.throws(() => jwtSecret('βάλε-κάτι-τυχαίο-εδώ'), /JWT_SECRET/);
  assert.throws(() => jwtSecret('dev-only-secret-ΑΛΛΑΞΕ-ΤΟ'), /JWT_SECRET/);
  assert.throws(() => jwtSecret('x'.repeat(31)), /JWT_SECRET/);
  assert.equal(jwtSecret('x'.repeat(32)), 'x'.repeat(32));
});

test('προορισμοί: IPv4 σε μη δεκαδική μορφή δεν παρακάμπτει τον έλεγχο τοπικού δικτύου', () => {
  // Το WHATWG URL κρατάει το host αδιαφανές στα non-special schemes (rtmp://),
  // οπότε το 2130706433 μένει ως έχει — ο getaddrinfo του ffmpeg όμως το λύνει
  // σε 127.0.0.1. Ό,τι μοιάζει με IP χωρίς να είναι κανονικό dotted-decimal
  // κόβεται· ό,τι είναι κανονικό περνάει από τους ίδιους ελέγχους.
  for (const host of ['2130706433', '0177.0.0.1', '0x7f.1', '017700000001', '127.1']) {
    assert.throws(
      () => cleanDestination({ name: 'x', url: `rtmp://${host}/live`, key: 'k' }),
      /τοπικό δίκτυο/,
      host,
    );
  }
  assert.equal(
    cleanDestination({ name: 'x', url: 'rtmp://a.rtmp.youtube.com/live2', key: 'k' }).url,
    'rtmp://a.rtmp.youtube.com/live2',
  );
  // Δημόσια IP σε κανονική μορφή μένει επιτρεπτή — δεν κόβουμε κάθε αριθμό.
  assert.equal(
    cleanDestination({ name: 'x', url: 'rtmp://8.8.8.8/live', key: 'k' }).url,
    'rtmp://8.8.8.8/live',
  );
});

test('κωδικοί: πολιτική μήκους στο ίδιο το hashPassword, verify ασύγχρονο', async () => {
  await assert.rejects(() => hashPassword('x'.repeat(MIN_PASSWORD - 1)), /χαρακτήρες/);
  const stored = await hashPassword('σωστός-κωδικός');
  assert.equal(await verifyPassword('σωστός-κωδικός', stored), true);
  assert.equal(await verifyPassword('λάθος-κωδικός', stored), false);
  assert.equal(await verifyPassword('ό,τι να ναι', 'χωρίς-άνω-κάτω-τελεία'), false);
});

test('throttle: μετράει μόνο τις αποτυχίες, η επιτυχία μηδενίζει', () => {
  const key = 'test-key';
  resetAttempts(key);
  for (let i = 0; i < MAX_FAILS; i++) {
    checkAttempts(key); // μέχρι εδώ περνάει
    failedAttempt(key);
  }
  assert.throws(() => checkAttempts(key), /πολλές/);
  // Άλλο κλειδί (άλλος χρήστης ή άλλη IP) δεν κλειδώνεται μαζί.
  checkAttempts('other-key');
  resetAttempts(key);
  checkAttempts(key);
});
