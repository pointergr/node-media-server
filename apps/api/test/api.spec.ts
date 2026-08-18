// e2e: node --test dist/test (μετά από `nest build`) — πραγματικό app.listen(0),
// πραγματικό sqlite σε temp αρχείο, χωρίς jest/supertest/nock.
// Ένα αρχείο, ένα setup: το `prisma db push` κοστίζει ένα spawn — δεν αξίζει
// να το πληρώσουμε ξανά ανά test-case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, startTestApp } from './helpers';

process.env.JWT_SECRET = 'test-secret-only-for-tests';

let base: string;
let closeApp: () => Promise<void>;
let ids: {
  serverA: number;
  serverB: number;
  clientA: number;
  clientB: number;
  clientDisabled: number;
  subA: number;
};

before(async () => {
  const { databaseUrl } = await setupTestDb();
  process.env.DATABASE_URL = databaseUrl;

  // Δικό μας PrismaClient για το seeding — ίδιο DATABASE_URL, ξεχωριστό από
  // αυτό που θα φτιάξει το Nest app παρακάτω (PrismaService).
  const { PrismaClient } = await import('@prisma/client');
  const { hashPassword } = await import('../src/auth/password');
  const prisma = new PrismaClient();

  const serverA = await prisma.server.create({
    data: { host: 'server-a', token: 'tok-a', adminUrl: 'http://127.0.0.1:1', adminUser: 'u', adminPass: 'p' },
  });
  const serverB = await prisma.server.create({
    data: { host: 'server-b', token: 'tok-b', adminUrl: 'http://127.0.0.1:2', adminUser: 'u', adminPass: 'p' },
  });

  // Τρία πλάνα, δύο μηχανήματα. Τα νούμερα είναι μικρά και ΔΙΑΦΟΡΕΤΙΚΑ μεταξύ
  // τους: κάθε assert παρακάτω που περιμένει «3» ελέγχει ότι το όριο ήρθε από τη
  // σωστή συνδρομή και δεν αθροίστηκε με καμία άλλη.
  const basic = await prisma.plan.create({
    data: { name: 'basic', maxViewers: 3, maxStreams: 1, serverId: serverA.id },
  });
  await prisma.plan.create({
    data: { name: 'extra', maxViewers: 2, maxStreams: 2, serverId: serverA.id },
  });
  const beta = await prisma.plan.create({
    data: { name: 'beta', maxViewers: 7, maxStreams: 1, serverId: serverB.id },
  });

  // Το path κρέμεται από τη ΣΥΝΔΡΟΜΗ — από εκεί παίρνει server και όριο.
  const clientA = await prisma.client.create({
    data: {
      name: 'pelatis-a',
      subscriptions: {
        create: [{
          planId: basic.id,
          serverId: serverA.id,
          paths: { create: [{ path: '/live/kamera1', key: 'KEYA1', serverId: serverA.id }] },
        }],
      },
    },
    include: { subscriptions: true },
  });
  const clientB = await prisma.client.create({
    data: {
      name: 'pelatis-b',
      subscriptions: {
        create: [{
          planId: beta.id,
          serverId: serverB.id,
          paths: { create: [{ path: '/live/kamerab', key: 'KEYB1', serverId: serverB.id }] },
        }],
      },
    },
  });
  const clientDisabled = await prisma.client.create({
    data: {
      name: 'pelatis-anenergos',
      disabled: true,
      subscriptions: {
        create: [{
          planId: basic.id,
          serverId: serverA.id,
          paths: { create: [{ path: '/live/kamerax', key: 'KEYX1', serverId: serverA.id }] },
        }],
      },
    },
  });

  await prisma.user.create({
    data: { username: 'admin', password: hashPassword('adminpass'), role: 'admin', clientId: null },
  });
  await prisma.user.create({
    data: { username: 'usera', password: hashPassword('passa'), role: 'customer', clientId: clientA.id },
  });
  await prisma.user.create({
    data: { username: 'userb', password: hashPassword('passb'), role: 'customer', clientId: clientB.id },
  });

  await prisma.$disconnect();

  ids = {
    serverA: serverA.id, serverB: serverB.id,
    clientA: clientA.id, clientB: clientB.id, clientDisabled: clientDisabled.id,
    // Το κλειδί του clients.json είναι «όνομα#idΣυνδρομής» — δες sync.controller.ts.
    subA: clientA.subscriptions[0]!.id,
  };

  const started = await startTestApp();
  base = started.base;
  closeApp = () => started.app.close();
});

after(async () => {
  await closeApp();
});

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username} έπρεπε να πετύχει`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

test('login: λάθος κωδικός -> 401', async () => {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'λάθος' }),
  });
  assert.equal(res.status, 401);
});

test('login: σωστός κωδικός -> token', async () => {
  const token = await login('admin', 'adminpass');
  assert.ok(token.length > 10);
});

test('sync: χωρίς token -> 401', async () => {
  const res = await fetch(`${base}/servers/server-a/sync`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
});

test('sync: λάθος token -> 401', async () => {
  const res = await fetch(`${base}/servers/server-a/sync`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 401);
});

test('sync: σωστό token -> μόνο οι μη-disabled πελάτες αυτού του server, μορφή clients.json', async () => {
  const res = await fetch(`${base}/servers/server-a/sync`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-a', 'content-type': 'application/json' },
    body: JSON.stringify({ streams: [] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // Μία εγγραφή ανά ΣΥΝΔΡΟΜΗ, με το όριο του πλάνου της — έτσι ο stream server,
  // που ομαδοποιεί ανά εγγραφή, επιβάλλει όριο ανά πλάνο χωρίς να ξέρει τι είναι
  // πλάνο. Το σχήμα του clients.json μένει ακριβώς ίδιο.
  assert.deepEqual(body, {
    [`pelatis-a#${ids.subA}`]: { limit: 3, paths: { '/live/kamera1': 'KEYA1' } },
  });
  assert.ok(!Object.keys(body).some((k) => k.startsWith('pelatis-anenergos')), 'ο disabled πελάτης δεν εμφανίζεται');
  assert.ok(!Object.keys(body).some((k) => k.startsWith('pelatis-b')), 'συνδρομή άλλου server δεν εμφανίζεται');
});

test('roles: customer σε admin endpoint -> 403', async () => {
  const token = await login('usera', 'passa');
  const res = await fetch(`${base}/clients`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test('roles: admin σε admin endpoint -> 200', async () => {
  const token = await login('admin', 'adminpass');
  const res = await fetch(`${base}/clients`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test('/me/streams: ο πελάτης Α δεν βλέπει τα paths του Β', async () => {
  const tokenA = await login('usera', 'passa');
  const resA = await fetch(`${base}/me/streams`, { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(resA.status, 200);
  const streamsA = (await resA.json()) as { host: string; path: string; key: string; streamKey: string; limit: number }[];
  assert.equal(streamsA.length, 1);
  assert.equal(streamsA[0].path, '/live/kamera1');
  assert.equal(streamsA[0].key, 'KEYA1');
  assert.equal(streamsA[0].streamKey, 'kamera1?key=KEYA1');
  assert.equal(streamsA[0].limit, 3, 'το όριο είναι της συνδρομής, όχι άθροισμα του πελάτη');
  assert.equal(streamsA[0].host, 'server-a', 'το panel χτίζει από αυτό τα URL αναπαραγωγής/OBS');
  assert.ok(!streamsA.some((s) => s.path === '/live/kamerab'), 'δεν βλέπει το path του πελάτη Β');

  const tokenB = await login('userb', 'passb');
  const resB = await fetch(`${base}/me/streams`, { headers: { authorization: `Bearer ${tokenB}` } });
  const streamsB = (await resB.json()) as { path: string }[];
  assert.equal(streamsB.length, 1);
  assert.equal(streamsB[0].path, '/live/kamerab');
});

// Τα ζωντανά νούμερα του πελάτη βγαίνουν από το snapshot του τελευταίου sync, όχι
// από τη βάση: χωρίς αυτό, ένα πεδίο που ξεχνιέται στο mapping (όπως έλειπε το
// out_bps) φαίνεται μόνο ως μόνιμο μηδέν στην οθόνη του πελάτη.
test('/me/streams: τα νούμερα του τελευταίου sync φτάνουν στον πελάτη', async () => {
  const since = Date.now() - 60_000;
  await fetch(`${base}/servers/server-a/sync`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-a', 'content-type': 'application/json' },
    body: JSON.stringify({
      streams: [{ stream: '/live/kamera1', viewers: 3, since, in_bps: 4_000_000, out_bps: 12_000_000 }],
      r2Estimate: true,
    }),
  });

  const token = await login('usera', 'passa');
  const res = await fetch(`${base}/me/streams`, { headers: { authorization: `Bearer ${token}` } });
  const [mine] = (await res.json()) as {
    viewers: number; since: number; in_bps: number; out_bps: number; r2Estimate: boolean;
  }[];

  assert.equal(mine.viewers, 3);
  assert.equal(mine.since, since);
  assert.equal(mine.in_bps, 4_000_000);
  assert.equal(mine.out_bps, 12_000_000, 'το bitrate εξόδου το δείχνει και το panel του πελάτη');
  assert.equal(mine.r2Estimate, true, 'με R2 η έξοδος είναι εκτίμηση — ο αστερίσκος θέλει τη σημαία');
});

test('/me/streams: χωρίς token -> 401', async () => {
  const res = await fetch(`${base}/me/streams`);
  assert.equal(res.status, 401);
});

// Το proxy είναι το μοναδικό μονοπάτι του panel προς το ιστορικό και το restart
// ενός stream server: αν σπάσει το basic auth ή το method, δεν το πιάνει τίποτα
// άλλο. Στη θέση του stream server ένας σκέτος http server.
test('proxy: περνάει basic auth και method στον stream server', async () => {
  const seen: { url: string; method: string; auth?: string }[] = [];
  const { createServer } = await import('node:http');
  const stub = createServer((req, res) => {
    seen.push({ url: req.url!, method: req.method!, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 'abc' }]));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as { port: number }).port;

  const token = await login('admin', 'adminpass');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.server.update({
    where: { host: 'server-a' },
    data: { adminUrl: `http://127.0.0.1:${port}`, adminUser: 'u', adminPass: 'p' },
  });

  const sessions = await fetch(`${base}/servers/server-a/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(sessions.status, 200);
  assert.deepEqual(await sessions.json(), [{ id: 'abc' }]);
  assert.equal(seen[0].url, '/admin/api/sessions');
  assert.equal(seen[0].auth, `Basic ${Buffer.from('u:p').toString('base64')}`);

  await fetch(`${base}/servers/server-a/restart`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(seen[1].method, 'POST', 'το restart φτάνει ως POST');
  assert.equal(seen[1].url, '/admin/api/restart');

  await new Promise<void>((r) => stub.close(() => r()));
});

// Διαγραφή πελάτη που έχει paths: χωρίς cascade το FK constraint έβγαζε 500 —
// δηλαδή δεν σβηνόταν ποτέ κανένας πραγματικός πελάτης.
test('DELETE /clients/:id: σβήνει και τα paths του', async () => {
  const token = await login('admin', 'adminpass');
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const client = await mkClient(auth, 'προς-διαγραφή');
  const sub = await mkSub(auth, client.id, await planId(auth, 'extra'));
  const path = await fetch(`${base}/clients/${client.id}/paths`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ path: '/live/prosdiagrafi', subscriptionId: sub.id }),
  });
  assert.equal(path.status, 201);

  // Ο πελάτης σβήνει με ένα request: cascade Client -> Subscription -> Path.
  const del = await fetch(`${base}/clients/${client.id}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200, 'ο πελάτης σβήνει παρότι έχει συνδρομή με path');

  // Το path πρέπει να έχει φύγει μαζί, αλλιώς κρατάει το unique (serverId, path)
  // δεσμευμένο για πάντα.
  const other = await mkClient(auth, 'προς-διαγραφή-2');
  const otherSub = await mkSub(auth, other.id, await planId(auth, 'extra'));
  const reuse = await fetch(`${base}/clients/${other.id}/paths`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ path: '/live/prosdiagrafi', subscriptionId: otherSub.id }),
  });
  assert.equal(reuse.status, 201, 'το path ελευθερώθηκε');
});

// --- Πλάνα και συνδρομές ---------------------------------------------------
// Όλα τα παρακάτω φτιάχνουν δικά τους πλάνα/πελάτες: ο pelatis-a διαβάζεται από
// τα προηγούμενα asserts και δεν πρέπει να μεταλλαχθεί.

async function adminAuth() {
  const token = await login('admin', 'adminpass');
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

type Auth = Record<string, string>;
const post = async (auth: Auth, url: string, body: unknown) =>
  fetch(`${base}${url}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

async function mkPlan(auth: Auth, name: string, maxViewers: number, maxStreams: number, serverId: number) {
  const res = await post(auth, '/plans', { name, maxViewers, maxStreams, serverId });
  assert.equal(res.status, 201, `το πλάνο ${name} έπρεπε να φτιαχτεί`);
  return (await res.json()) as { id: number };
}

async function planId(auth: Auth, name: string) {
  const plans = (await (await fetch(`${base}/plans`, { headers: auth })).json()) as { id: number; name: string }[];
  return plans.find((p) => p.name === name)!.id;
}

async function mkClient(auth: Auth, name: string) {
  const res = await post(auth, '/clients', { name });
  assert.equal(res.status, 201, `ο πελάτης ${name} έπρεπε να φτιαχτεί`);
  return (await res.json()) as { id: number };
}

async function mkSub(auth: Auth, clientId: number, planIdValue: number) {
  const res = await post(auth, `/clients/${clientId}/subscriptions`, { planId: planIdValue });
  assert.equal(res.status, 201, 'η συνδρομή έπρεπε να φτιαχτεί');
  return (await res.json()) as { id: number; serverId: number };
}

const syncOf = async (host: string, token: string) => {
  const res = await fetch(`${base}/servers/${host}/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ streams: [] }),
  });
  return (await res.json()) as Record<string, { limit: number; ladder?: number[]; paths: Record<string, string> }>;
};

// Ο πυρήνας του μοντέλου: δύο συνδρομές του ΙΔΙΟΥ πλάνου δεν φτιάχνουν έναν
// πελάτη με διπλό όριο — φτιάχνουν δύο ξεχωριστά πλάνα με το δικό του όριο το
// καθένα. Αν κάποτε ξαναμπεί άθροισμα, εδώ θα φανεί.
test('συνδρομές: κάθε πλάνο κρατάει το δικό του όριο, χωρίς άθροισμα', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'diplo', 50, 1, ids.serverA);
  const client = await mkClient(auth, 'me-dio-plana');
  const first = await mkSub(auth, client.id, plan.id);
  const second = await mkSub(auth, client.id, plan.id);
  assert.notEqual(first.id, second.id, 'δύο αγορές = δύο γραμμές, χωρίς ποσότητα');

  await post(auth, `/clients/${client.id}/paths`, { path: '/live/proto', subscriptionId: first.id });
  await post(auth, `/clients/${client.id}/paths`, { path: '/live/deftero', subscriptionId: second.id });

  const body = await syncOf('server-a', 'tok-a');
  assert.deepEqual(body[`me-dio-plana#${first.id}`], { limit: 50, paths: { '/live/proto': body[`me-dio-plana#${first.id}`]!.paths['/live/proto']! } });
  assert.equal(body[`me-dio-plana#${second.id}`]!.limit, 50, 'όχι 100 — το όριο είναι της συνδρομής');
  assert.deepEqual(Object.keys(body[`me-dio-plana#${second.id}`]!.paths), ['/live/deftero'], 'κάθε πλάνο βλέπει μόνο τα δικά του paths');
});

// Το όριο θεατών αλλάζει από τον κατάλογο (σκόπιμα: δες README) — ο server όχι.
test('πλάνα: αλλάζοντας τα όρια, οι υπάρχουσες συνδρομές ακολουθούν· ο server όχι', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'metavalomeno', 10, 1, ids.serverA);
  const client = await mkClient(auth, 'akolouthei');
  const sub = await mkSub(auth, client.id, plan.id);
  assert.equal(sub.serverId, ids.serverA);

  const patched = await fetch(`${base}/plans/${plan.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ maxViewers: 80, serverId: ids.serverB }),
  });
  assert.equal(patched.status, 200);

  assert.equal((await syncOf('server-a', 'tok-a'))[`akolouthei#${sub.id}`]!.limit, 80, 'το όριο ακολουθεί τον κατάλογο');
  assert.equal((await syncOf('server-b', 'tok-b'))[`akolouthei#${sub.id}`], undefined, 'ο server της συνδρομής δεν άλλαξε');

  // ...και η επόμενη αγορά πάει στον νέο server, με την παλιά να μένει.
  const next = await mkSub(auth, client.id, plan.id);
  assert.equal(next.serverId, ids.serverB);
  assert.equal((await syncOf('server-a', 'tok-a'))[`akolouthei#${sub.id}`]!.limit, 80);
  assert.equal((await syncOf('server-b', 'tok-b'))[`akolouthei#${next.id}`]!.limit, 80);
});

// Εδώ ζει ολόκληρο το όριο streams — πουθενά αλλού δεν επιβάλλεται.
test('συνδρομές: path πάνω από το maxStreams -> 409, με χώρο στην άλλη συνδρομή', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'ena-stream', 10, 1, ids.serverA);
  const client = await mkClient(auth, 'me-ena-stream');
  const sub = await mkSub(auth, client.id, plan.id);

  assert.equal((await post(auth, `/clients/${client.id}/paths`, { path: '/live/ena', subscriptionId: sub.id })).status, 201);

  const second = await post(auth, `/clients/${client.id}/paths`, { path: '/live/dio', subscriptionId: sub.id });
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { message: string }).message, /1 streams/);

  // Δεύτερη συνδρομή = δεύτερη θέση. Το όριο δεν είναι του πελάτη.
  const extra = await mkSub(auth, client.id, plan.id);
  assert.equal((await post(auth, `/clients/${client.id}/paths`, { path: '/live/dio', subscriptionId: extra.id })).status, 201);
});

// Path χωρίς path: η αρίθμηση δεν πρέπει να ξαναδώσει ό,τι υπάρχει ήδη — μετά από
// διαγραφή, ένα «πλήθος+1» θα έπεφτε πάνω στο τελευταίο.
test('paths: χωρίς path -> αυτόματο ανά συνδρομή, χωρίς σύγκρουση μετά από διαγραφή', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'auto-path', 10, 5, ids.serverA);
  const client = await mkClient(auth, 'auto-path-pelatis');
  const sub = await mkSub(auth, client.id, plan.id);

  const mk = async () => (await (await post(auth, `/clients/${client.id}/paths`, { subscriptionId: sub.id })).json()) as { id: number; path: string };
  const first = await mk();
  const second = await mk();
  assert.equal(first.path, `/live/c${client.id}-s${sub.id}-1`);
  assert.equal(second.path, `/live/c${client.id}-s${sub.id}-2`);

  await fetch(`${base}/clients/${client.id}/paths/${first.id}`, { method: 'DELETE', headers: auth });
  assert.equal((await mk()).path, `/live/c${client.id}-s${sub.id}-3`);
});

// Η συνδρομή άλλου πελάτη δεν είναι δρόμος για path: χωρίς τον έλεγχο, ένα id
// από άλλον πελάτη θα έγραφε path μέσα στο πλάνο του.
test('συνδρομές: id άλλου πελάτη -> 404', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'xenos', 10, 2, ids.serverA);
  const owner = await mkClient(auth, 'idioktitis');
  const sub = await mkSub(auth, owner.id, plan.id);
  const stranger = await mkClient(auth, 'perastikos');

  assert.equal((await post(auth, `/clients/${stranger.id}/paths`, { path: '/live/klemeno', subscriptionId: sub.id })).status, 404);
  const del = await fetch(`${base}/clients/${stranger.id}/subscriptions/${sub.id}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 404);
});

// Εκτεθειμένο κλειδί: αλλάζει από τα δύο σημεία (admin και ο ίδιος ο πελάτης),
// χωρίς να χαθεί το path — και το ξένο pathId δεν είναι δρόμος για το /me.
test('ανανέωση κλειδιού: νέο κλειδί στο ίδιο path, από admin και από πελάτη', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'ananeosi', 10, 2, ids.serverA);
  const created = await post(auth, '/clients', { name: 'diarroi', username: 'diarroi', password: 'passd' });
  const client = (await created.json()) as { id: number };
  const sub = await mkSub(auth, client.id, plan.id);
  const path = (await (
    await post(auth, `/clients/${client.id}/paths`, { path: '/live/diarroi', subscriptionId: sub.id })
  ).json()) as { id: number; key: string };

  const byAdmin = await post(auth, `/clients/${client.id}/paths/${path.id}/key`, {});
  assert.equal(byAdmin.status, 201);
  const fresh = (await byAdmin.json()) as { path: string; key: string };
  assert.equal(fresh.path, '/live/diarroi', 'το path δεν αλλάζει — το ξέρουν ήδη το OBS και ο player');
  assert.notEqual(fresh.key, path.key);
  assert.equal(
    (await syncOf('server-a', 'tok-a'))[`diarroi#${sub.id}`]!.paths['/live/diarroi'],
    fresh.key,
    'ο stream server παίρνει το νέο κλειδί στο επόμενο sync',
  );

  const token = await login('diarroi', 'passd');
  const asCustomer = (headers: Auth, id: number) =>
    fetch(`${base}/me/streams/${id}/key`, { method: 'POST', headers });
  const mine = (await (
    await fetch(`${base}/me/streams`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { id: number }[];

  const own = await asCustomer({ authorization: `Bearer ${token}` }, mine[0].id);
  assert.equal(own.status, 201);
  assert.notEqual(((await own.json()) as { key: string }).key, fresh.key, 'ο πελάτης το αλλάζει μόνος του');

  const other = await login('usera', 'passa');
  const foreign = await asCustomer({ authorization: `Bearer ${other}` }, mine[0].id);
  assert.equal(foreign.status, 404, 'ξένο path δεν αλλάζει κλειδί');
});

// Συνδρομή με paths: το κλειδί εκπομπής δεν χάνεται με ένα κλικ «αφαίρεση».
test('DELETE συνδρομής με streams -> 409, άδεια -> 200', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'pros-afairesi', 10, 2, ids.serverA);
  const client = await mkClient(auth, 'afairei-plano');
  const sub = await mkSub(auth, client.id, plan.id);
  const path = (await (await post(auth, `/clients/${client.id}/paths`, { path: '/live/kratao', subscriptionId: sub.id })).json()) as { id: number };

  const busy = await fetch(`${base}/clients/${client.id}/subscriptions/${sub.id}`, { method: 'DELETE', headers: auth });
  assert.equal(busy.status, 409);

  await fetch(`${base}/clients/${client.id}/paths/${path.id}`, { method: 'DELETE', headers: auth });
  const free = await fetch(`${base}/clients/${client.id}/subscriptions/${sub.id}`, { method: 'DELETE', headers: auth });
  assert.equal(free.status, 200);
});

// Διαγραφή πλάνου εν χρήσει: αλλάζει σιωπηλά τα όρια πελατών που κανείς δεν
// κοιτάζει εκείνη τη στιγμή. Το FK δεν το πιάνει (cascade προς τον πελάτη).
test('DELETE /plans/:id με συνδρομές -> 409, μετά την αποδέσμευση -> 200', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'pros-diagrafi', 5, 5, ids.serverA);
  const client = await mkClient(auth, 'kratos-plano');
  const sub = await mkSub(auth, client.id, plan.id);

  const busy = await fetch(`${base}/plans/${plan.id}`, { method: 'DELETE', headers: auth });
  assert.equal(busy.status, 409);

  await fetch(`${base}/clients/${client.id}/subscriptions/${sub.id}`, { method: 'DELETE', headers: auth });
  const free = await fetch(`${base}/plans/${plan.id}`, { method: 'DELETE', headers: auth });
  assert.equal(free.status, 200);
});

test('πλάνα: όρια < 1 -> 400, άγνωστο πλάνο -> 400 (όχι 500)', async () => {
  const auth = await adminAuth();
  const zero = await post(auth, '/plans', { name: 'miden', maxViewers: 0, maxStreams: 1, serverId: ids.serverA });
  assert.equal(zero.status, 400, 'το «πλάνο του μηδενός» θα ζητούσε κανόνα 0 = απεριόριστο');

  const client = await mkClient(auth, 'me-agnosto');
  assert.equal((await post(auth, `/clients/${client.id}/subscriptions`, { planId: 9999 })).status, 400);
});

// --- Ladder (ABR) ----------------------------------------------------------
// Το ladder ζει στο πλάνο γιατί είναι κάτι που πουλιέται (PLAN-transcoding.md),
// και κανονικοποιείται πριν την αποθήκευση: αλλιώς το «720, 480» και το
// «720,480» θα ήταν δύο διαφορετικές γραφές της ίδιας σκάλας.
test('πλάνα: ladder έγκυρο — κανονικοποίηση στη δημιουργία και στην ενημέρωση', async () => {
  const auth = await adminAuth();
  const res = await post(auth, '/plans', {
    name: 'abr', maxViewers: 10, maxStreams: 1, serverId: ids.serverA, ladder: '720, 480',
  });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { ladder: string }).ladder, '720,480');

  const id = await planId(auth, 'abr');
  const patched = await fetch(`${base}/plans/${id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ ladder: '1080,720,480' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as { ladder: string }).ladder, '1080,720,480');

  // Κενό = «καθόλου transcoding», και μπαίνει ως null: μία αναπαράσταση του
  // τίποτα, όχι δύο, ώστε ο stream server να μην ελέγχει και τα δύο.
  const cleared = await fetch(`${base}/plans/${id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ ladder: '' }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as { ladder: string | null }).ladder, null);
});

// Ο stream server έχει σταθερό bitrate ανά ύψος και το -var_stream_map βγαίνει
// με τη σειρά του ladder: άγνωστο ύψος ή άτακτη σειρά θα έσκαγαν εκεί — δηλαδή
// την ώρα της εκπομπής — αντί για εδώ.
test('πλάνα: ladder άκυρο — άγνωστο ύψος, αύξουσα σειρά, διπλότυπο -> 400', async () => {
  const auth = await adminAuth();
  const mk = (name: string, ladder: string) =>
    post(auth, '/plans', { name, maxViewers: 10, maxStreams: 1, serverId: ids.serverA, ladder });

  assert.equal((await mk('akyro-1', '720,500')).status, 400, 'το 500 δεν έχει bitrate στον πίνακα');
  assert.equal((await mk('akyro-2', '480,720')).status, 400, 'αύξουσα σειρά = άτακτο master playlist');
  assert.equal((await mk('akyro-3', '720,720')).status, 400, 'δύο φορές το ίδιο encode');
  assert.equal((await mk('akyro-4', '720,abc')).status, 400);
});

test('sync: το ladder του πλάνου φτάνει ως array· χωρίς ladder ούτε το κλειδί', async () => {
  const auth = await adminAuth();
  const created = await post(auth, '/plans', {
    name: 'abr-sync', maxViewers: 10, maxStreams: 1, serverId: ids.serverA, ladder: '720,480',
  });
  assert.equal(created.status, 201);
  const abr = (await created.json()) as { id: number };
  const aplo = await mkPlan(auth, 'aplo-sync', 10, 1, ids.serverA);
  const client = await mkClient(auth, 'me-abr');
  const subAbr = await mkSub(auth, client.id, abr.id);
  const subAplo = await mkSub(auth, client.id, aplo.id);

  const body = await syncOf('server-a', 'tok-a');
  assert.deepEqual(body[`me-abr#${subAbr.id}`]!.ladder, [720, 480], 'array από αριθμούς, όχι csv');
  // Παράλειψη και όχι null/κενό array: το clients.json των σημερινών πελατών
  // μένει byte-για-byte ίδιο (σύμβαση με το `config.js#ladderOf`).
  assert.ok(!('ladder' in body[`me-abr#${subAplo.id}`]!), 'χωρίς ladder, ούτε το κλειδί');
});

// Ο server ΔΕΝ κάνει cascade: καθαρό 409 αντί για 500, ώστε το panel να πει
// στον διαχειριστή τι να κάνει.
test('DELETE /servers/:id με πελάτες -> 409', async () => {
  const token = await login('admin', 'adminpass');
  const res = await fetch(`${base}/servers/${ids.serverA}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 409);
});

// Το /me/series είναι proxy στον ίδιο stream server με το admin endpoint, αλλά
// για πελάτη: αν χαθεί το φιλτράρισμα, ο ένας πελάτης βλέπει τις χρονοσειρές του
// άλλου (και το CPU του μηχανήματος). Δεν το πιάνει τίποτα άλλο.
test('/me/series: μόνο τα paths του πελάτη, χωρίς το server block', async () => {
  const { createServer } = await import('node:http');
  const seen: string[] = [];
  const stub = createServer((req, res) => {
    seen.push(req.url!);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      bucket: 60,
      from: 1000,
      streams: [
        { t: 1000, stream: '/live/kamera1', in_bps: 5, out_bps: 6, viewers: 2 },
        { t: 1000, stream: '/live/allounou', in_bps: 9, out_bps: 9, viewers: 9 },
      ],
      server: [{ t: 1000, cpu_pct: 42, mem_mb: 100 }],
    }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as { port: number }).port;

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.server.update({
    where: { host: 'server-a' },
    data: { adminUrl: `http://127.0.0.1:${port}` },
  });

  const tokenA = await login('usera', 'passa');
  const res = await fetch(`${base}/me/series?range=24h`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { streams: { stream: string }[]; server?: unknown };

  assert.equal(seen[0], '/admin/api/series?range=24h', 'το range φτάνει στον stream server');
  assert.deepEqual(body.streams.map((r) => r.stream), ['/live/kamera1']);
  assert.equal(body.server, undefined, 'CPU/μνήμη του μηχανήματος δεν πάνε σε πελάτη');

  await new Promise<void>((r) => stub.close(() => r()));
});

// Πριν από αυτό, τα στοιχεία σύνδεσης ήταν γράψε-μια-φορά: ο πελάτης έμενε για
// πάντα με τον κωδικό της δημιουργίας του και ο admin με του seed — η μόνη λύση
// ήταν UPDATE στη sqlite με το χέρι.
test('PATCH /clients/:id: ο admin αλλάζει username/password του πελάτη', async () => {
  const auth = await adminAuth();
  const client = (await (await fetch(`${base}/clients`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'me-xristi', username: 'palio', password: 'palios' }),
  })).json()) as { id: number };
  assert.ok(await login('palio', 'palios'));

  const res = await fetch(`${base}/clients/${client.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ username: 'neo', password: 'neos' }),
  });
  assert.equal(res.status, 200);
  assert.ok(await login('neo', 'neos'));

  const old = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'palio', password: 'palios' }),
  });
  assert.equal(old.status, 401, 'το παλιό username δεν υπάρχει πια');

  // Μόνο κωδικός: το username μένει ως έχει (undefined = «μην το αγγίξεις»).
  await fetch(`${base}/clients/${client.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ password: 'neoteros' }),
  });
  assert.ok(await login('neo', 'neoteros'));

  // Και ο πελάτης που δημιουργήθηκε χωρίς χρήστη αποκτά έναν αργότερα.
  const bare = (await (await fetch(`${base}/clients`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'xoris-xristi' }),
  })).json()) as { id: number };
  const half = await fetch(`${base}/clients/${bare.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ password: 'monos-kodikos' }),
  });
  assert.equal(half.status, 400, 'χωρίς username δεν ξέρουμε ποιον χρήστη να φτιάξουμε');
  const full = await fetch(`${base}/clients/${bare.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ username: 'argoporimenos', password: 'kodikos' }),
  });
  assert.equal(full.status, 200);
  assert.ok(await login('argoporimenos', 'kodikos'));
});

test('username που υπάρχει ήδη -> 409 (όχι 500)', async () => {
  const auth = await adminAuth();
  const dup = await fetch(`${base}/clients`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'diplos', username: 'admin', password: 'x' }),
  });
  assert.equal(dup.status, 409);
});

// Το hash δεν έχει λόγο να φύγει από το API — ούτε στον admin, που έτσι κι αλλιώς
// μπορεί να ορίσει νέο κωδικό.
test('GET /clients: username ναι, hash κωδικού όχι', async () => {
  const auth = await adminAuth();
  const clients = (await (await fetch(`${base}/clients`, { headers: auth })).json()) as {
    name: string; users: { username: string; password?: string }[];
  }[];
  const mine = clients.find((c) => c.name === 'me-xristi')!;
  assert.deepEqual(mine.users.map((u) => u.username), ['neo']);
  assert.equal(mine.users[0].password, undefined);
});

// Ο admin ξέρει το username από το τηλέφωνο («δεν μπαίνω»), όχι το id ή το
// ελληνικό όνομα της εγγραφής: η αναζήτηση γίνεται με το ίδιο GET /clients,
// φιλτραρισμένο — αλλιώς το panel θα κατέβαζε όλους τους πελάτες με τις
// συνδρομές τους για να ψάξει σε ένα πεδίο.
test('GET /clients?username=: φιλτράρει στον χρήστη του πελάτη', async () => {
  const auth = await adminAuth();
  const search = async (username: string) =>
    (await (await fetch(`${base}/clients?username=${encodeURIComponent(username)}`, { headers: auth })).json()) as {
      name: string; users: { username: string }[];
    }[];

  const exact = await search('neo');
  assert.deepEqual(exact.map((c) => c.name), ['me-xristi']);

  // Μερικό ταίριασμα: ο admin θυμάται την αρχή του username, όχι όλο.
  assert.deepEqual((await search('ne')).map((c) => c.name), ['me-xristi']);

  assert.deepEqual(await search('anyparktos'), [], 'άγνωστο username = κανένας πελάτης');

  // Κενό = χωρίς φίλτρο, ώστε το panel να μη χρειάζεται δύο κλήσεις.
  assert.ok((await search('')).length > 1);
});

test('PATCH /auth/me: ο καθένας αλλάζει μόνο τον δικό του λογαριασμό', async () => {
  const tokenB = await login('userb', 'passb');
  const headersB = { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' };

  const wrong = await fetch(`${base}/auth/me`, {
    method: 'PATCH', headers: headersB, body: JSON.stringify({ currentPassword: 'λάθος', password: 'neos' }),
  });
  assert.equal(wrong.status, 401, 'το token μόνο δεν αρκεί για αλλαγή κωδικού');

  const ok = await fetch(`${base}/auth/me`, {
    method: 'PATCH', headers: headersB, body: JSON.stringify({ currentPassword: 'passb', password: 'passb2' }),
  });
  assert.equal(ok.status, 200);
  assert.ok(await login('userb', 'passb2'));
  assert.ok(await login('usera', 'passa'), 'ο άλλος πελάτης δεν επηρεάστηκε');

  // Και ο admin: το ίδιο endpoint, ο μόνος τρόπος να αλλάξει ο κωδικός του seed.
  const auth = await adminAuth();
  const asAdmin = await fetch(`${base}/auth/me`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ currentPassword: 'adminpass', password: 'adminpass2' }),
  });
  assert.equal(asAdmin.status, 200);
  assert.ok(await login('admin', 'adminpass2'));

  // Επαναφορά: τα υπόλοιπα tests (και το adminAuth) περιμένουν τον αρχικό κωδικό.
  const token2 = await login('admin', 'adminpass2');
  await fetch(`${base}/auth/me`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token2}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'adminpass2', password: 'adminpass' }),
  });
  assert.ok(await login('admin', 'adminpass'));
});

// Το seed είναι ο μόνος δρόμος για χαμένο κωδικό admin (το PATCH /auth/me ζητάει
// τον τρέχοντα και δεύτερος admin δεν υπάρχει): αν σπάσει το `force`, η μόνη
// εναλλακτική είναι UPDATE στη sqlite με το χέρι.
test('seed force: ξαναγράφει τον κωδικό υπάρχοντος admin, όχι πελάτη', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const seed = `${__dirname}/../src/seed.js`;
  // Ξεχωριστή διεργασία, ίδια βάση: το DATABASE_URL το βλέπει από το env.
  const env = { ...process.env, SEED_ADMIN_USER: 'admin', SEED_ADMIN_PASSWORD: 'anaktisi' };

  const noForce = await run('node', [seed], { env });
  assert.match(noForce.stderr, /υπάρχει ήδη/);
  assert.ok(await login('admin', 'adminpass'), 'χωρίς force δεν αγγίζει τίποτα');

  await run('node', [seed, 'force'], { env });
  assert.ok(await login('admin', 'anaktisi'));

  // Ένα `force` σε πελάτη δεν πρέπει να τον προάγει σε admin.
  await assert.rejects(
    run('node', [seed, 'force'], { env: { ...env, SEED_ADMIN_USER: 'usera' } }),
    /δεν είναι admin/,
  );
  assert.ok(await login('usera', 'passa'), 'ο κωδικός του πελάτη έμεινε ως ήταν');

  // Επαναφορά για ό,τι τρέξει μετά.
  await run('node', [seed, 'force'], { env: { ...env, SEED_ADMIN_PASSWORD: 'adminpass' } });
  assert.ok(await login('admin', 'adminpass'));
});

// Η αναστολή είναι της ΣΥΝΔΡΟΜΗΣ: ο πελάτης με τρία πλάνα που έληξε το ένα δεν
// πρέπει να χάσει και τα άλλα δύο. Χωρίς το φίλτρο στο sync, το «suspend» θα
// φαινόταν μόνο στην οθόνη και ο πελάτης θα συνέχιζε να εκπέμπει.
test('συνδρομές: suspend μόνο της μίας, οι υπόλοιπες συνεχίζουν', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'anastoli', 20, 1, ids.serverA);
  const client = await mkClient(auth, 'me-anastoli');
  const live = await mkSub(auth, client.id, plan.id);
  const expired = await mkSub(auth, client.id, plan.id);
  await post(auth, `/clients/${client.id}/paths`, { path: '/live/energo', subscriptionId: live.id });
  await post(auth, `/clients/${client.id}/paths`, { path: '/live/ligomeno', subscriptionId: expired.id });

  const suspend = await fetch(`${base}/clients/${client.id}/subscriptions/${expired.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ disabled: true }),
  });
  assert.equal(suspend.status, 200);

  const body = await syncOf('server-a', 'tok-a');
  assert.equal(body[`me-anastoli#${expired.id}`], undefined, 'η συνδρομή σε αναστολή φεύγει από το clients.json');
  assert.deepEqual(Object.keys(body[`me-anastoli#${live.id}`]!.paths), ['/live/energo'], 'η άλλη συνδρομή δεν πειράχτηκε');

  // Και πίσω: η αναστολή δεν χάνει ούτε το path ούτε το κλειδί του.
  await fetch(`${base}/clients/${client.id}/subscriptions/${expired.id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ disabled: false }),
  });
  assert.deepEqual(Object.keys((await syncOf('server-a', 'tok-a'))[`me-anastoli#${expired.id}`]!.paths), ['/live/ligomeno']);
});

// Δύο συνδρομές του ίδιου πλάνου είναι δύο φορές «basic»: χωρίς φιλικό όνομα ο
// πελάτης δεν έχει κανέναν τρόπο να δει ποιο stream μοιράζεται όριο θεατών με
// ποιο. Το όνομα το γράφουν και οι δύο πλευρές — ο πελάτης ξέρει τι είναι το
// κάθε πακέτο, ο admin το βλέπει στο /clients.
test('συνδρομές: φιλικό όνομα από admin και από πελάτη, ξένη συνδρομή 404', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'onomata', 10, 2, ids.serverA);
  const created = await post(auth, '/clients', { name: 'onomasia', username: 'onomasia', password: 'passo' });
  const client = (await created.json()) as { id: number };
  const ekklisia = await mkSub(auth, client.id, plan.id);
  const dimarcheio = await mkSub(auth, client.id, plan.id);
  await post(auth, `/clients/${client.id}/paths`, { path: '/live/ekklisia', subscriptionId: ekklisia.id });
  await post(auth, `/clients/${client.id}/paths`, { path: '/live/dimarcheio', subscriptionId: dimarcheio.id });

  const patchSub = (headers: Auth, url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: 'PATCH', headers, body: JSON.stringify(body) });

  const named = await patchSub(auth, `/clients/${client.id}/subscriptions/${ekklisia.id}`, { label: 'Εκκλησία' });
  assert.equal(named.status, 200);
  assert.equal(((await named.json()) as { label: string }).label, 'Εκκλησία');

  // Το όνομα φτάνει στον πελάτη μαζί με τα streams — εκεί το χρειάζεται η
  // ομαδοποίηση της οθόνης.
  const token = await login('onomasia', 'passo');
  const customer = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const streams = async () =>
    (await (await fetch(`${base}/me/streams`, { headers: customer })).json()) as
      { path: string; subscriptionId: number; subscriptionLabel: string | null }[];
  const first = await streams();
  assert.equal(first.find((s) => s.path === '/live/ekklisia')!.subscriptionLabel, 'Εκκλησία');
  assert.equal(first.find((s) => s.path === '/live/dimarcheio')!.subscriptionLabel, null, 'χωρίς όνομα μένει null');

  // Ο ίδιος ο πελάτης ονομάζει το δεύτερο πακέτο του.
  const byCustomer = await patchSub(customer, `/me/subscriptions/${dimarcheio.id}`, { label: '  Δημαρχείο  ' });
  assert.equal(byCustomer.status, 200);
  assert.equal(
    (await streams()).find((s) => s.path === '/live/dimarcheio')!.subscriptionLabel,
    'Δημαρχείο',
    'το όνομα αποθηκεύεται χωρίς τα κενά των άκρων',
  );

  // Σκέτα κενά σημαίνουν «σβήσ' το»: κενή κεφαλίδα είναι χειρότερη από το όνομα
  // του πλάνου.
  await patchSub(customer, `/me/subscriptions/${dimarcheio.id}`, { label: '   ' });
  assert.equal((await streams()).find((s) => s.path === '/live/dimarcheio')!.subscriptionLabel, null);

  assert.equal(
    (await patchSub(customer, `/me/subscriptions/${dimarcheio.id}`, { label: 'x'.repeat(61) })).status,
    400,
    'το όνομα είναι κεφαλίδα κάρτας, όχι κείμενο',
  );

  // Το /me δεν είναι δεύτερος δρόμος για την αναστολή: εμπορική απόφαση, μένει
  // στον admin. Το `disabled` απλώς αγνοείται και το label είναι υποχρεωτικό.
  assert.equal((await patchSub(customer, `/me/subscriptions/${ekklisia.id}`, { disabled: true })).status, 400);
  const stillOn = await syncOf('server-a', 'tok-a');
  assert.ok(stillOn[`onomasia#${ekklisia.id}`], 'η συνδρομή δεν μπήκε σε αναστολή από το /me');

  // Ξένη συνδρομή: το clientId βγαίνει από το token, όχι από το URL.
  const other = await login('usera', 'passa');
  const foreign = await patchSub(
    { authorization: `Bearer ${other}`, 'content-type': 'application/json' },
    `/me/subscriptions/${ekklisia.id}`,
    { label: 'δικό μου τώρα' },
  );
  assert.equal(foreign.status, 404);
  assert.equal((await streams()).find((s) => s.path === '/live/ekklisia')!.subscriptionLabel, 'Εκκλησία');
});

// --- API keys ---------------------------------------------------------------
// Εξωτερική υπηρεσία που κάνει provisioning: το 12ωρο JWT δεν κάνει, και μακρόβιο
// JWT δεν ανακαλείται χωρίς αλλαγή του JWT_SECRET — δηλαδή χωρίς να πέσουν έξω
// ταυτόχρονα όλοι οι συνδεδεμένοι χρήστες.
test('api key: provisioning χωρίς login, ανάκληση με μία διαγραφή', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const mint = `${__dirname}/../src/apikey.js`;

  const out = await run('node', [mint, 'e-shop']);
  const key = out.stdout.trim().split(/\s+/).pop()!;
  assert.match(key, /^pk_/, 'το key τυπώνεται μία φορά, με πρόθεμα pk_');

  const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const plan = await mkPlan(await adminAuth(), 'apikey-plan', 10, 2, ids.serverA);
  // Ολόκληρη η αλυσίδα του provisioning με το key, χωρίς κανένα login.
  const client = await mkClient(auth, 'pelatis-apikey');
  const sub = await mkSub(auth, client.id, plan.id);
  const path = await post(auth, `/clients/${client.id}/paths`, { path: '/live/apikey', subscriptionId: sub.id });
  assert.equal(path.status, 201);

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const rows = await prisma.apiKey.findMany();
  assert.equal(rows.length, 1);
  // Αντίγραφο της sqlite δεν πρέπει να παραδίδει έτοιμο κλειδί.
  assert.ok(!JSON.stringify(rows).includes(key), 'το plaintext δεν αποθηκεύεται');
  assert.ok(rows[0]!.lastUsed, 'γράφτηκε η τελευταία χρήση');

  // Ανάκληση: μία διαγραφή, χωρίς να πειραχτεί κανένα JWT.
  await prisma.apiKey.deleteMany();
  await prisma.$disconnect();
  const after = await fetch(`${base}/clients`, { headers: auth });
  assert.equal(after.status, 401, 'το διαγραμμένο key δεν περνάει');
  assert.ok(await login('admin', 'adminpass'), 'οι χρήστες δεν επηρεάστηκαν');
});

test('api key: άκυρο -> 401', async () => {
  const res = await fetch(`${base}/clients`, { headers: { authorization: 'Bearer pk_den-yparxei' } });
  assert.equal(res.status, 401);
});

// Το username δεν είναι στο JWT (payload: sub/role/clientId), οπότε η οθόνη
// «Ο λογαριασμός μου» δεν έχει άλλο τρόπο να δείξει ποιος είναι συνδεδεμένος.
test('GET /auth/me: τα στοιχεία του συνδεδεμένου, χωρίς hash κωδικού', async () => {
  const token = await login('usera', 'passa');
  const res = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { username: 'usera', role: 'customer', clientId: ids.clientA });

  const anon = await fetch(`${base}/auth/me`);
  assert.equal(anon.status, 401);
});

// --- Σύνδεση με link (billing -> panel) -------------------------------------
// Το billing στέλνει τον πελάτη στο panel χωρίς να ξέρει τον κωδικό του: παίρνει
// URL με βραχύβιο token, το panel το ανταλλάσσει με κανονική συνεδρία.
test('login-link: ο πελάτης μπαίνει χωρίς κωδικό, με μία μόνο χρήση', async () => {
  const auth = await adminAuth();
  const res = await post(auth, '/auth/login-link', { clientId: ids.clientA });
  assert.equal(res.status, 200);
  const { url } = (await res.json()) as { url: string };

  // Το token στο fragment, όχι σε query: δεν φτάνει ποτέ σε server log ή referrer.
  assert.match(url, /\/login#t=/, `περίμενα URL του panel, πήρα ${url}`);
  const linkToken = url.split('#t=')[1]!;

  const ex = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: linkToken }),
  });
  assert.equal(ex.status, 200, 'η ανταλλαγή γίνεται χωρίς κανένα token — ο χρήστης δεν έχει ακόμα συνεδρία');
  const { access_token } = (await ex.json()) as { access_token: string };

  const mine = await fetch(`${base}/me/streams`, { headers: { authorization: `Bearer ${access_token}` } });
  assert.equal(mine.status, 200);
  const streams = (await mine.json()) as { path: string }[];
  assert.equal(streams[0]!.path, '/live/kamera1', 'η συνεδρία είναι του πελάτη του link');

  // Κανονική συνεδρία, όχι το βραχύβιο token: αλλιώς ο πελάτης θα έπεφτε έξω σε λίγα λεπτά.
  const { exp } = JSON.parse(Buffer.from(access_token.split('.')[1]!, 'base64url').toString()) as { exp: number };
  assert.ok(exp * 1000 - Date.now() > 3_600_000, 'η συνεδρία μετά την ανταλλαγή διαρκεί ώρες');

  const again = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: linkToken }),
  });
  assert.equal(again.status, 401, 'μία χρήση: το ίδιο link δεν ξανανοίγει συνεδρία');
});

// Χωρίς αυτό, όποιος έχει μια συνεδρία θα την ανανέωνε επ' άπειρον από το exchange.
test('exchange: κανονικό token συνεδρίας -> 401', async () => {
  const token = await login('usera', 'passa');
  const res = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 401);
});

test('login-link: πελάτης χωρίς χρήστη -> 400', async () => {
  const auth = await adminAuth();
  const client = await mkClient(auth, 'pelatis-xoris-xristi');
  const res = await post(auth, '/auth/login-link', { clientId: client.id });
  assert.equal(res.status, 400);
});

// --- Ο πελάτης φτιάχνει μόνος του streams -----------------------------------
// Το όριο δεν ξαναγράφεται εδώ: το endpoint του /me περνάει από την ίδια
// addPath με τον admin, οπότε το τεστ ελέγχει ότι πράγματι περνάει από εκεί
// (409 στο όριο) και ότι το clientId βγαίνει από το token (404 σε ξένη
// συνδρομή), όχι από το σώμα του αιτήματος.
test('/me/streams POST: ο πελάτης φτιάχνει streams μέχρι το όριο του πακέτου του', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'ftiaxno-monos', 10, 2, ids.serverA);
  const created = await post(auth, '/clients', { name: 'ftiaxnei-monos', username: 'ftiaxnei', password: 'pass1234' });
  assert.equal(created.status, 201);
  const client = (await created.json()) as { id: number };
  const sub = await mkSub(auth, client.id, plan.id);

  const token = await login('ftiaxnei', 'pass1234');
  const me: Auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const first = await post(me, '/me/streams', { subscriptionId: sub.id });
  assert.equal(first.status, 201);
  // Το όνομα το δίνει το API (nextPath) — ο πελάτης δεν διαλέγει path.
  assert.equal(((await first.json()) as { path: string }).path, `/live/c${client.id}-s${sub.id}-1`);
  assert.equal((await post(me, '/me/streams', { subscriptionId: sub.id })).status, 201);

  const third = await post(me, '/me/streams', { subscriptionId: sub.id });
  assert.equal(third.status, 409, 'το όριο του πακέτου κόβει το τρίτο');
  assert.match(((await third.json()) as { message: string }).message, /2 streams/);

  // Η συνδρομή του pelatis-a δεν είναι δική του: 404, όχι path μέσα σε ξένο πλάνο.
  assert.equal((await post(me, '/me/streams', { subscriptionId: ids.subA })).status, 404);

  const mine = (await (await fetch(`${base}/me/streams`, { headers: me })).json()) as { path: string }[];
  assert.deepEqual(mine.map((s) => s.path), [`/live/c${client.id}-s${sub.id}-1`, `/live/c${client.id}-s${sub.id}-2`]);
});

// Το /me/streams δείχνει paths· μια συνδρομή χωρίς κανένα path δεν φαίνεται
// πουθενά, οπότε ο πελάτης που μόλις αγόρασε δεν θα είχε από πού να πατήσει
// «νέο stream». Γι' αυτό ξεχωριστό endpoint με τα πακέτα.
test('/me/subscriptions: τα πακέτα του πελάτη με τα όριά τους, ακόμα και άδεια', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'adeio-paketo', 9, 4, ids.serverA);
  const created = await post(auth, '/clients', { name: 'molis-agorase', username: 'molis', password: 'pass1234' });
  const client = (await created.json()) as { id: number };
  const sub = await mkSub(auth, client.id, plan.id);

  const token = await login('molis', 'pass1234');
  const me: Auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const subs = (await (await fetch(`${base}/me/subscriptions`, { headers: me })).json()) as {
    id: number; plan: string; label: string | null; host: string;
    maxStreams: number; maxViewers: number; streams: number; suspended: boolean;
  }[];
  assert.deepEqual(subs, [{
    id: sub.id, plan: 'adeio-paketo', label: null, host: 'server-a',
    maxStreams: 4, maxViewers: 9, streams: 0, suspended: false,
  }], 'άδειο πακέτο, με το όριο και τα μηδέν streams του');

  assert.equal((await post(me, '/me/streams', { subscriptionId: sub.id })).status, 201);
  const after = (await (await fetch(`${base}/me/subscriptions`, { headers: me })).json()) as { streams: number }[];
  assert.equal(after[0]!.streams, 1, 'το πλήθος ακολουθεί το νέο stream');

  // Ξένα πακέτα δεν φαίνονται: το clientId βγαίνει από το token.
  const other = (await (await fetch(`${base}/me/subscriptions`, {
    headers: { authorization: `Bearer ${await login('usera', 'passa')}` },
  })).json()) as { id: number }[];
  assert.equal(other.some((s) => s.id === sub.id), false);
});

// Η διαγραφή από τον πελάτη κρίνεται στο τελευταίο snapshot: όσο υπάρχει
// publisher, το stream δεν σβήνεται — αλλιώς η εκπομπή που τρέχει κόβεται με ένα
// κλικ και το κλειδί χάνεται μαζί της.
test('DELETE /me/streams/:id: όχι όσο εκπέμπει, ναι όταν σταματήσει, ξένο -> 404', async () => {
  const auth = await adminAuth();
  const plan = await mkPlan(auth, 'svino-monos', 10, 2, ids.serverA);
  const created = await post(auth, '/clients', { name: 'svinei-monos', username: 'svinei', password: 'pass1234' });
  const client = (await created.json()) as { id: number };
  const sub = await mkSub(auth, client.id, plan.id);

  const token = await login('svinei', 'pass1234');
  const me: Auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const mine = (await (await post(me, '/me/streams', { subscriptionId: sub.id })).json()) as { id: number; path: string };

  const sync = (streams: unknown[]) =>
    fetch(`${base}/servers/server-a/sync`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-a', 'content-type': 'application/json' },
      body: JSON.stringify({ streams }),
    });
  const del = (id: number) => fetch(`${base}/me/streams/${id}`, { method: 'DELETE', headers: me });

  await sync([{ stream: mine.path, viewers: 0, since: Date.now() - 5_000 }]);
  const live = await del(mine.id);
  assert.equal(live.status, 409, 'με publisher πάνω του δεν σβήνεται');
  assert.match(((await live.json()) as { message: string }).message, /εκπέμπει/);

  // Χωρίς `since` δεν υπάρχει publisher — το ότι το stream λείπει εντελώς από το
  // snapshot είναι το ίδιο πράγμα, δες το δεύτερο sync.
  await sync([{ stream: mine.path, viewers: 0 }]);
  assert.equal((await del(mine.id)).status, 200, 'χωρίς publisher σβήνεται');

  const left = (await (await fetch(`${base}/me/streams`, { headers: me })).json()) as unknown[];
  assert.equal(left.length, 0);
  // ...και η θέση ελευθερώθηκε στο πακέτο.
  assert.equal(((await (await fetch(`${base}/me/subscriptions`, { headers: me })).json()) as { streams: number }[])[0]!.streams, 0);

  // Το path του pelatis-a δεν είναι δικό του: 404, όχι διαγραφή ξένου stream.
  const foreign = (await (await fetch(`${base}/me/streams`, {
    headers: { authorization: `Bearer ${await login('usera', 'passa')}` },
  })).json()) as { id: number }[];
  assert.equal((await del(foreign[0]!.id)).status, 404);
});

// Ο server που κρέμεται από συνδρομή ή πλάνο είναι εκεί για να πει «πού» — και
// κουβαλούσε ολόκληρη τη γραμμή του: το bearer του sync και τον κωδικό του admin
// dashboard, σε κάθε provisioning κλήση εξωτερικής υπηρεσίας (το API key έχει
// ρόλο admin). Το `/servers` μένει η μόνη πόρτα που τα δείχνει.
test('συνδρομές και πλάνα: ο server μόνο ως {id, host}, χωρίς token/adminPass', async () => {
  const auth = await adminAuth();
  const client = await mkClient(auth, 'xoris-mystika');
  const created = (await (await post(auth, `/clients/${client.id}/subscriptions`, {
    planId: await planId(auth, 'basic'),
  })).json()) as { server: Record<string, unknown> };
  assert.deepEqual(Object.keys(created.server).sort(), ['host', 'id']);

  const clients = (await (await fetch(`${base}/clients`, { headers: auth })).json()) as {
    name: string; subscriptions: { server: Record<string, unknown> }[];
  }[];
  const listed = clients.find((c) => c.name === 'xoris-mystika')!;
  assert.deepEqual(Object.keys(listed.subscriptions[0]!.server).sort(), ['host', 'id']);

  const plans = (await (await fetch(`${base}/plans`, { headers: auth })).json()) as {
    server: Record<string, unknown>;
  }[];
  assert.deepEqual(Object.keys(plans[0]!.server).sort(), ['host', 'id']);
});
