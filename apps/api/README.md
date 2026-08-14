# apps/api

NestJS API της κεντρικής διαχείρισης: πελάτες, paths, κλειδιά εκπομπής, όρια
θεατών, πολλοί stream servers. Δες [PLAN-monorepo.md](../../PLAN-monorepo.md)
(Βήμα 2) και [PLAN-multitenant.md](../../PLAN-multitenant.md) (Φάση 6) στη
ρίζα του repo για το γιατί.

Το UI ζει στο `apps/panel` (Nuxt SPA, στατικά αρχεία που σερβίρει ο Caddy εδώ
δίπλα) — δες [PLAN-monorepo.md](../../PLAN-monorepo.md). Ο πρώτος admin
χρήστης φτιάχνεται πάντα με το `npm run seed`.

## Τοπικά

Όλα από τη **ρίζα** του monorepo: το `-w apps/api` είναι σχετικό με αυτήν, και
μέσα από το `apps/api` το npm δεν βρίσκει το workspace με αυτό το όνομα.

```bash
cp apps/api/.env.example apps/api/.env  # DATABASE_URL, JWT_SECRET, PORT, DOMAIN (Docker)
npm ci                                  # όλα τα workspaces, ένα lockfile
npm run build -w apps/api               # nest build (tsc)· το @prisma/client το φτιάχνει το postinstall
npm run db:push -w apps/api             # εφαρμόζει το schema.prisma στο sqlite
npm run seed -w apps/api                # φτιάχνει τον πρώτο admin χρήστη
npm start -w apps/api
```

(Το `db push` παραπάνω είναι ό,τι κάνει και το `CMD` του Dockerfile στο boot —
εφαρμόζει το schema.prisma στο sqlite, idempotent. Δεν υπάρχει migrations
directory: το μοντέλο είναι λίγοι πίνακες, δεν αξίζει το εργαλείο.)

## Tests

```bash
npm test -w apps/api   # nest build && node --test dist/test/*.js
```

Ένα αρχείο (`test/api.spec.ts`): πραγματικό `app.listen(0)`, πραγματικό sqlite
σε προσωρινό αρχείο (`prisma db push` πριν τα tests), `fetch` σαν client.
Χωρίς jest/supertest — ίδια φιλοσοφία με τα `test-*.js` του `apps/stream`.

## Docker

```bash
cd apps/api
cp .env.example .env      # DOMAIN, JWT_SECRET
docker compose up -d --build
docker compose exec api node dist/src/seed.js
```

Δύο services: `api` (Nest, το sqlite σε named volume) και `caddy` (χτισμένο
από το `apps/panel/Dockerfile` — κουβαλάει τα στατικά του Nuxt panel στο
`/srv`)· `/api/*` → Nest, ό,τι άλλο → `file_server` με SPA fallback (δες
`Caddyfile`).

## Auth

Δύο ξεχωριστοί μηχανισμοί, κανένας passport:

- **JWT** (`@nestjs/jwt`) για χρήστες: `POST /auth/login` → `access_token`.
  Global guard σε κάθε route εκτός `@Public()`. Payload: `sub` (user id),
  `role` (`admin`/`customer`), `clientId` (`null` για admin).
- **Static bearer token ανά server** (`Server.token`) μόνο για το
  `POST /servers/:host/sync` — ο stream server δεν συνδέεται ποτέ σαν χρήστης.

Κωδικοί: `node:crypto` `scryptSync` + `timingSafeEqual` (`src/auth/password.ts`),
όχι bcrypt/argon — καμία native εξάρτηση στο image.

## Endpoints

| Endpoint | Auth | Σημείωση |
|---|---|---|
| `POST /auth/login` | καμία | `{username,password}` → `{access_token}` |
| `POST /servers/:host/sync` | `Bearer <Server.token>` | σώμα = snapshot του stream server, απάντηση = clients.json (μόνο μη-disabled πελάτες αυτού του server) |
| `GET /live` | admin | τελευταίο snapshot όλων των servers, από τη μνήμη· `online: false` αν `ts` > 30s |
| `GET /servers` / `POST /servers` | admin | CRUD server· το `token` παράγεται μόνο του αν δεν δοθεί |
| `GET/PATCH/DELETE /servers/:id` | admin | |
| `GET /servers/:host/series?range=` | admin | proxy → `/admin/api/series` του stream server (basic auth από το Server) |
| `GET /servers/:host/sessions` | admin | proxy → `/admin/api/sessions` |
| `DELETE /servers/:host/sessions/:id` | admin | proxy → `/admin/api/sessions/:id` |
| `POST /servers/:host/restart` | admin | proxy → `/admin/api/restart` |
| `GET /clients` / `POST /clients` | admin | `POST` δέχεται προαιρετικά `username`+`password` — φτιάχνει μαζί και τον customer χρήστη (δες «Αποφάσεις» παρακάτω) |
| `GET/PATCH/DELETE /clients/:id` | admin | `PATCH` για `limit`, `disabled`, `name`, `serverId`· `DELETE` σβήνει και τα paths του (cascade) |
| `POST /clients/:id/paths` | admin | `{path}` → παράγει κλειδί (16 bytes, base64url) |
| `DELETE /clients/:id/paths/:pathId` | admin | |
| `GET /me/streams` | οποιοσδήποτε συνδεδεμένος | τα paths του πελάτη του token (admin χωρίς `clientId` → `[]`). Κάθε entry: `host` (το domain του stream server), `path`, `key`, `streamKey` (`όνομα?key=...`), `limit`, `viewers`, `since` (πότε συνδέθηκε ο publisher, `null` = δεν εκπέμπει) και `in_bps` — τα τρία τελευταία από το τελευταίο snapshot |
| `GET /me/series?range=` | οποιοσδήποτε συνδεδεμένος | ίδιο proxy με το `/servers/:host/series`, αλλά **μόνο** για τα paths του πελάτη του token και χωρίς το `server` block (CPU/μνήμη). Ο server βγαίνει από τον πελάτη, δεν τον διαλέγει ο caller |

`DELETE /servers/:id` με πελάτες ακόμα ανατεθειμένους σε αυτόν δίνει **409**:
οι πελάτες δεν κάνουν cascade με τον server επίτηδες, το να σβήνεις έναν
server δεν πρέπει να σβήνει σιωπηλά και τους πελάτες του — μετακίνησέ τους ή
σβήσε τους πρώτα.

## Αποφάσεις

- **Το `DATABASE_URL` είναι απόλυτο path στο Docker.** Το Prisma λύνει τα
  σχετικά sqlite paths ως προς το `schema.prisma`, όχι ως προς το cwd: με
  `file:./data/api.db` η βάση έβγαινε στο `apps/api/prisma/data/`, δηλαδή έξω
  από το named volume, και **χανόταν αθόρυβα σε κάθε recreate του container**.
  Το compose δίνει `file:/app/apps/api/data/api.db`· τοπικά το `.env` δείχνει
  `file:../data/api.db` (σχετικό ως προς το `prisma/`). Ένα `docker compose exec
  api ls -la /app/apps/api/data` πρέπει να δείχνει το `api.db` — αν είναι άδειο,
  τα δεδομένα δεν επιβιώνουν.
- **Prisma 6, όχι 7.** Το Prisma 7 αφαιρεί το `datasource.url` από το schema
  και θέλει driver adapters + `prisma.config.ts` — πολύ βάρος για ένα sqlite
  με λίγους πίνακες. Prisma 6.19 κρατάει το κλασικό `env("DATABASE_URL")`.
- **Το `prisma` CLI είναι κανονικό dependency, όχι dev.** Χρειάζεται στο
  runtime image για το `db push` στο boot (δες `Dockerfile`) — δεν υπάρχει
  migrations directory, το schema.prisma είναι η μόνη πηγή αλήθειας.
- **`POST /clients` φτιάχνει προαιρετικά και τον χρήστη.** Το συμβόλαιο δεν
  όριζε ξεχωριστό users CRUD, αλλά κάποιος πρέπει να μπορεί να συνδεθεί σαν
  ο πελάτης — παρά να προσθέσω ένα ολόκληρο users module, το `POST /clients`
  δέχεται προαιρετικά `username`/`password` και τα δύο γίνονται σε ένα
  `$transaction`.
- **`db.$queryRaw`/migrations: όχι.** `prisma db push` αρκεί σε ένα μικρό
  σχήμα χωρίς ιστορικό αλλαγών σε production ακόμα.
- **Χωρίς CORS.** Το panel σερβίρεται από τον ίδιο Caddy (`/api/*` → εδώ) και
  στο dev το ίδιο κάνει το proxy του Nuxt — δεν υπάρχει νόμιμο cross-origin
  κάλεσμα να επιτραπεί.
- **Χωρίς class-validator.** Ελάχιστος χειροκίνητος έλεγχος (`BadRequestException`
  σε λείποντα πεδία) — δεν αξίζει άλλη εξάρτηση για λίγα endpoints.
