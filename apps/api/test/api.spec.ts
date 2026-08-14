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

  const clientA = await prisma.client.create({
    data: {
      name: 'pelatis-a',
      limit: 5,
      serverId: serverA.id,
      paths: { create: [{ path: '/live/kamera1', key: 'KEYA1', serverId: serverA.id }] },
    },
  });
  const clientB = await prisma.client.create({
    data: {
      name: 'pelatis-b',
      limit: 0,
      serverId: serverB.id,
      paths: { create: [{ path: '/live/kamerab', key: 'KEYB1', serverId: serverB.id }] },
    },
  });
  const clientDisabled = await prisma.client.create({
    data: {
      name: 'pelatis-anenergos',
      disabled: true,
      serverId: serverA.id,
      paths: { create: [{ path: '/live/kamerax', key: 'KEYX1', serverId: serverA.id }] },
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

  ids = { serverA: serverA.id, serverB: serverB.id, clientA: clientA.id, clientB: clientB.id, clientDisabled: clientDisabled.id };

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
  assert.deepEqual(body, {
    'pelatis-a': { limit: 5, paths: { '/live/kamera1': 'KEYA1' } },
  });
  assert.ok(!('pelatis-anenergos' in body), 'ο disabled πελάτης δεν εμφανίζεται');
  assert.ok(!('pelatis-b' in body), 'πελάτης άλλου server δεν εμφανίζεται');
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
  assert.equal(streamsA[0].limit, 5);
  assert.equal(streamsA[0].host, 'server-a', 'το panel χτίζει από αυτό τα URL αναπαραγωγής/OBS');
  assert.ok(!streamsA.some((s) => s.path === '/live/kamerab'), 'δεν βλέπει το path του πελάτη Β');

  const tokenB = await login('userb', 'passb');
  const resB = await fetch(`${base}/me/streams`, { headers: { authorization: `Bearer ${tokenB}` } });
  const streamsB = (await resB.json()) as { path: string }[];
  assert.equal(streamsB.length, 1);
  assert.equal(streamsB[0].path, '/live/kamerab');
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

  const created = await fetch(`${base}/clients`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'προς-διαγραφή', serverId: ids.serverA, limit: 1 }),
  });
  const client = (await created.json()) as { id: number };
  const path = await fetch(`${base}/clients/${client.id}/paths`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ path: '/live/prosdiagrafi' }),
  });
  assert.equal(path.status, 201);

  const del = await fetch(`${base}/clients/${client.id}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200, 'ο πελάτης σβήνει παρότι έχει path');

  // Το path πρέπει να έχει φύγει μαζί, αλλιώς κρατάει το unique (serverId, path)
  // δεσμευμένο για πάντα.
  const reuse = await fetch(`${base}/clients/${ids.clientA}/paths`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ path: '/live/prosdiagrafi' }),
  });
  assert.equal(reuse.status, 201, 'το path ελευθερώθηκε');
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
