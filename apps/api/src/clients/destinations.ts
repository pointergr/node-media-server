import { BadRequestException } from '@nestjs/common';

// Έλεγχος και σύνθεση των εξωτερικών προορισμών αναδιανομής. Σε δικό του αρχείο
// επειδή το ίδιο πράγμα το γράφουν δύο controllers (ο admin από το /clients, ο
// πελάτης από το /me) και επειδή είναι το μοναδικό σημείο όπου το API δέχεται
// **διεύθυνση δικτύου από τον χρήστη** και τη δίνει σε μηχάνημα δικό μας να τη
// συνδεθεί: ό,τι δεν κοπεί εδώ, θα το πάρει ο ffmpeg του stream server.

const NAME_MAX = 40;
const URL_MAX = 500;
const KEY_MAX = 500;

// Ιδιωτικά και ειδικά δίκτυα: ο πελάτης δίνει διεύθυνση, ο δικός μας server
// συνδέεται. Χωρίς αυτό, «προορισμός αναδιανομής» γίνεται σαρωτής του δικτύου
// μας — και το 169.254.169.254 είναι το metadata endpoint κάθε cloud provider.
// Δεν πιάνει hostname που *λύνεται* σε ιδιωτική IP (ούτε μπορεί: το DNS αλλάζει
// μετά τον έλεγχο). Δεν πειράζει: ο ffmpeg μιλάει μόνο RTMP και ό,τι πάρει πίσω
// δεν το βλέπει ποτέ κανείς — αυτό εδώ κόβει το προφανές λάθος και την προφανή
// κατάχρηση, όχι έναν αποφασισμένο επιτιθέμενο.
// Ρητή συνάρτηση και όχι ένα regex για όλα: το IPv6 έρχεται από το URL μέσα σε
// αγκύλες, οπότε ένα κοινό regex ή θα ξεχνούσε τις αγκύλες ή — χωρίς άγκυρα στο
// τέλος — θα έκοβε κάθε domain που τυχαίνει να αρχίζει από «fc» ή «fd».
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h.startsWith('[')) {
    const ip = h.slice(1, -1);
    // ::1 loopback, :: unspecified, fc00::/7 unique-local, fe80::/10 link-local.
    return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || ip.startsWith('fe80:');
  }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  // Καμία TLD δεν αρχίζει από ψηφίο: αν το τελευταίο κομμάτι αρχίζει, τότε αυτό
  // είναι IP και όχι όνομα — και επιτρέπεται μόνο σε κανονική δεκαδική μορφή.
  // Το `rtmp://` είναι non-special scheme για το WHATWG URL, οπότε το host μένει
  // αδιαφανές (σε αντίθεση με το http://, που θα το κανονικοποιούσε): το
  // `2130706433`, το `0177.0.0.1` και το `012.0.0.1` δεν ταιριάζουν στο regex
  // παρακάτω, αλλά ο getaddrinfo του ffmpeg τα λύνει σε 127.0.0.1 / 10.0.0.1.
  // Το μηδενικό μπροστά μετράει: το inet_aton το διαβάζει οκταδικά.
  const last = h.split('.').pop()!;
  if (/^\d/.test(last) && !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(h)) return true;
  return /^(0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

// Η πλατφόρμα δίνει URL και κλειδί χωριστά· ο stream server θέλει ένα URL. Το
// trailing slash είναι το ίδιο σφάλμα με το R2 endpoint (apps/stream/app.js):
// δίνει "//" στη μέση και η πλατφόρμα απαντάει με σκέτη αποσύνδεση, χωρίς να
// γράψει τίποτα πουθενά που να εξηγεί γιατί.
export const relayUrl = (url: string, key: string) => `${url.replace(/\/+$/, '')}/${key}`;

export interface DestinationDto {
  name: string;
  url: string;
  key: string;
  enabled?: boolean;
}

// `partial` για το PATCH: εκεί κάθε πεδίο είναι προαιρετικό, αλλά ό,τι δοθεί
// περνάει από τους ίδιους ελέγχους. Δύο συναρτήσεις θα απέκλιναν, και η μία από
// τις δύο θα ήταν αυτή που δέχεται το `http://`.
export function cleanDestination(body: Partial<DestinationDto>, partial = false) {
  const out: Partial<DestinationDto> = {};

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('name: όνομα προορισμού απαιτείται');
    }
    if (body.name.trim().length > NAME_MAX) throw new BadRequestException(`name έως ${NAME_MAX} χαρακτήρες`);
    out.name = body.name.trim();
  }

  if (body.url !== undefined || !partial) {
    out.url = cleanUrl(body.url);
  }

  if (body.key !== undefined || !partial) {
    if (typeof body.key !== 'string' || !body.key.trim()) {
      throw new BadRequestException('key: το κλειδί της πλατφόρμας απαιτείται');
    }
    const key = body.key.trim();
    if (key.length > KEY_MAX) throw new BadRequestException(`key έως ${KEY_MAX} χαρακτήρες`);
    // Κενό μέσα στο κλειδί σημαίνει κακό copy-paste (τα κλειδιά των πλατφορμών
    // δεν έχουν ποτέ): θα περνούσε ως όρισμα στον ffmpeg και θα έβγαζε αποτυχία
    // σύνδεσης που κανείς δεν συνδέει με το πεδίο που συμπλήρωσε. Οι παύλες
    // αντίθετα είναι κανονικό μέρος του κλειδιού του YouTube.
    if (/\s/.test(key)) throw new BadRequestException('key: το κλειδί δεν έχει κενά — έλεγξε την αντιγραφή');
    out.key = key;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('enabled: boolean');
    out.enabled = body.enabled;
  }

  return out;
}

function cleanUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException('url: η διεύθυνση της πλατφόρμας απαιτείται (rtmp:// ή rtmps://)');
  }
  const raw = value.trim();
  if (raw.length > URL_MAX) throw new BadRequestException(`url έως ${URL_MAX} χαρακτήρες`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(`url: «${raw}» δεν είναι διεύθυνση`);
  }
  // Μόνο RTMP: ο ffmpeg του relay βγάζει flv και τίποτα άλλο (apps/stream/relay.js).
  // Το rtmps το απαιτεί το Facebook — χρειάζεται ffmpeg με TLS στο μηχάνημα.
  if (url.protocol !== 'rtmp:' && url.protocol !== 'rtmps:') {
    throw new BadRequestException('url: μόνο rtmp:// ή rtmps://');
  }
  if (isPrivateHost(url.hostname)) {
    throw new BadRequestException('url: η διεύθυνση δείχνει σε τοπικό δίκτυο');
  }
  return raw;
}
