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
  const streamsA = (await resA.json()) as { path: string; key: string; streamKey: string; limit: number }[];
  assert.equal(streamsA.length, 1);
  assert.equal(streamsA[0].path, '/live/kamera1');
  assert.equal(streamsA[0].key, 'KEYA1');
  assert.equal(streamsA[0].streamKey, 'kamera1?key=KEYA1');
  assert.equal(streamsA[0].limit, 5);
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
