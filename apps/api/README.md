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

(Μέσα στο container **όχι** `npm run seed`: το npm script έχει `--env-file=.env`
και το image δεν κουβαλάει `.env` — τις μεταβλητές τις δίνει το compose.)

**Χαμένος κωδικός admin:** το `PATCH /auth/me` ζητάει τον τρέχοντα και δεύτερος
admin που θα έκανε reset δεν υπάρχει, οπότε η ανάκτηση γίνεται από τον host —
ίδια σύμβαση `force` με το `generate-passwords` του stream server:

```bash
docker compose exec api node dist/src/seed.js force            # τυχαίος, τον τυπώνει
docker compose exec -e SEED_ADMIN_PASSWORD=... api node dist/src/seed.js force
```

Χωρίς `force` ο υπάρχων χρήστης δεν αγγίζεται. Το `force` γράφει **μόνο** τον
κωδικό, όχι τον ρόλο: με `SEED_ADMIN_USER` πελάτη σκάει, αλλιώς ένα λάθος
username θα προήγαγε σιωπηλά πελάτη σε admin.

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
| `PATCH /auth/me` | οποιοσδήποτε συνδεδεμένος | `{currentPassword, username?, password?}` — αλλάζει τα **δικά του** στοιχεία (το id βγαίνει από το token, ποτέ από το σώμα). Λάθος `currentPassword` → **401**, username που υπάρχει → **409**. Το token μένει έγκυρο: το payload δεν αλλάζει |
| `POST /servers/:host/sync` | `Bearer <Server.token>` | σώμα = snapshot του stream server, απάντηση = clients.json — οι μη-disabled πελάτες που έχουν **αγορά ή path** σε αυτόν τον server, με το `limit` και τα paths **μόνο** αυτού του server |
| `GET /live` | admin | τελευταίο snapshot όλων των servers, από τη μνήμη· `online: false` αν `ts` > 30s |
| `GET /servers` / `POST /servers` | admin | CRUD server· το `token` παράγεται μόνο του αν δεν δοθεί |
| `GET/PATCH/DELETE /servers/:id` | admin | |
| `GET /servers/:host/series?range=` | admin | proxy → `/admin/api/series` του stream server (basic auth από το Server) |
| `GET /servers/:host/sessions` | admin | proxy → `/admin/api/sessions` |
| `DELETE /servers/:host/sessions/:id` | admin | proxy → `/admin/api/sessions/:id` |
| `POST /servers/:host/restart` | admin | proxy → `/admin/api/restart` |
| `GET /clients` / `POST /clients` | admin | `POST` δέχεται προαιρετικά `username`+`password` — φτιάχνει μαζί και τον customer χρήστη (δες «Αποφάσεις» παρακάτω). Το `GET` δίνει και `users: [{id, username}]`, **χωρίς** το hash του κωδικού |
| `GET/PATCH/DELETE /clients/:id` | admin | `PATCH` για `disabled`, `name`, `packages` (η **τελική** λίστα `[{packageId, serverId?, qty}]` — ό,τι λείπει αφαιρείται· `serverId` που λείπει = **νέα αγορά**, παίρνει τον σημερινό server του πακέτου) και `username`/`password` του χρήστη του πελάτη (ό,τι δεν σταλεί μένει ως έχει· μόνο `password` σε πελάτη **χωρίς** χρήστη → **400**, username που υπάρχει → **409**)· `DELETE` σβήνει και τα paths του (cascade) |
| `GET /packages` / `POST /packages` | admin | `{name, maxViewers, maxStreams, serverId}`, τα δύο όρια ακέραιοι **≥1**· ο `serverId` είναι ο server των **επόμενων** αγορών |
| `PATCH/DELETE /packages/:id` | admin | αλλαγή `serverId` = «από δω και πέρα πουλάει εκεί», οι υπάρχουσες αγορές **δεν** μετακομίζουν· `DELETE` με πελάτες που το κρατούν → **409** |
| `POST /clients/:id/paths` | admin | `{path, serverId}` → παράγει κλειδί (16 bytes, base64url)· **409** αν ο πελάτης δεν έχει αγορά σε αυτόν τον server ή αν τα πακέτα του εκεί δεν χωράνε άλλο stream |
| `DELETE /clients/:id/paths/:pathId` | admin | |
| `GET /me/streams` | οποιοσδήποτε συνδεδεμένος | τα paths του πελάτη του token (admin χωρίς `clientId` → `[]`). Κάθε entry: `host` (το domain του stream server), `path`, `key`, `streamKey` (`όνομα?key=...`), `limit` (άθροισμα των πακέτων του **σε αυτόν τον server**, `0` = χωρίς όριο), `viewers`, `since` (πότε συνδέθηκε ο publisher, `null` = δεν εκπέμπει), `in_bps`, `out_bps` και `r2Estimate` (η έξοδος είναι εκτίμηση όταν τα segments φεύγουν από CDN) — τα πέντε τελευταία από το τελευταίο snapshot |
| `GET /me/series?range=` | οποιοσδήποτε συνδεδεμένος | ίδιο proxy με το `/servers/:host/series`, αλλά **μόνο** για τα paths του πελάτη του token και χωρίς το `server` block (CPU/μνήμη). Οι servers βγαίνουν από τα paths του, δεν τους διαλέγει ο caller — με paths σε δύο μηχανήματα ρωτάει και τα δύο και ενώνει (ένα πεσμένο δεν ρίχνει το γράφημα του άλλου) |

**Πακέτα:** τα όρια δεν ζουν στον πελάτη — είναι το άθροισμα των αγορών του επί
την ποσότητα (`Σ qty × maxViewers`, ίδιο για τα streams), **ανά server**. Πελάτης
χωρίς αγορά σε έναν server βγάζει `0` εκεί, δηλαδή **χωρίς όριο** — ακριβώς η
σημασία του `0` σε όλη τη διαδρομή ως τον stream server, ο οποίος δεν μαθαίνει
ποτέ τι είναι πακέτο: παίρνει έτοιμο `limit` στο clients.json, με το ίδιο σχήμα
όπως πάντα. Το όριο streams μετράει **paths** (πόσα μπορεί να έχει ο πελάτης
εκεί) και επιβάλλεται μόνο στο `POST /clients/:id/paths` — paths που υπάρχουν
ήδη δεν κόβονται αν αργότερα μικρύνει το πακέτο.

**Σε ποιον server είναι ο πελάτης;** Σε κανέναν — ο `Client` δεν έχει server. Τον
έχει η **αγορά**: κάθε γραμμή `ClientPackage` κρατάει το `serverId` που είχε το
πακέτο τη στιγμή που αγοράστηκε. Ο ΘΩΜΑΣ που πήρε «basic» όσο το basic έδειχνε
`stream1` μένει στο `stream1` για πάντα· αν αύριο το basic δείχνει `stream2`, εκεί
πάει μόνο η **επόμενη** αγορά — και ο ίδιος πελάτης βρίσκεται να έχει πακέτα, όρια
και paths σε δύο μηχανήματα ταυτόχρονα. Έτσι γεμίζει ένας server χωρίς να
πειραχτεί κανείς από όσους ήδη κάθονται εκεί.

`DELETE /servers/:id` που τον χρησιμοποιεί πακέτο, αγορά ή path δίνει **409**:
τίποτα δεν κάνει cascade με τον server επίτηδες, το να σβήνεις έναν server δεν
πρέπει να σβήνει σιωπηλά paths και κλειδιά εκπομπής — άδειασέ τον πρώτα.

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
- **Καμία διαχείριση χρηστών πέρα από αυτά τα δύο endpoints.** Χωρίς users
  module, τα στοιχεία σύνδεσης άλλαζαν μόνο με `UPDATE` στη sqlite: ο πελάτης
  έμενε για πάντα με τον κωδικό της δημιουργίας του και ο admin με του `seed`.
  Δύο σημεία τα καλύπτουν, με διαφορετικό έλεγχο σε καθένα:
  - `PATCH /clients/:id` — ο **admin** ορίζει κωδικό πελάτη χωρίς να τον ξέρει
    (reset). Δημιουργία και αλλαγή περνάνε από την ίδια `setUser`, όπως τα
    πακέτα από την `setPackages`: χωριστά, το ένα από τα δύο θα ξέχναγε το
    `hashPassword` ή το 409 του διπλού username.
  - `PATCH /auth/me` — ο **καθένας** τα δικά του, με το `sub` του token (αλλιώς
    ο πελάτης θα άλλαζε τον κωδικό του admin) και με τον τρέχοντα κωδικό ξανά:
    το token μόνο δεν αρκεί, μια ξεχασμένη συνεδρία δεν πρέπει να μπορεί να
    κλειδώσει έξω τον κάτοχο. Είναι και ο μόνος δρόμος **μέσα από την
    εφαρμογή** για τον admin — δεν υπάρχει δεύτερος admin να του κάνει reset,
    οπότε ο χαμένος κωδικός θέλει `seed ... force` από τον host (δες «Docker»).

  Ο admin **δεν** μπορεί να δει κωδικό, μόνο να ορίσει νέο: το `GET /clients`
  γυρίζει `users` με ρητό `select` (id, username), ώστε το hash να μη φύγει
  ποτέ από το API.
- **`db.$queryRaw`/migrations: όχι.** `prisma db push` αρκεί σε ένα μικρό
  σχήμα χωρίς ιστορικό αλλαγών σε production ακόμα.
- **Χωρίς CORS.** Το panel σερβίρεται από τον ίδιο Caddy (`/api/*` → εδώ) και
  στο dev το ίδιο κάνει το proxy του Nuxt — δεν υπάρχει νόμιμο cross-origin
  κάλεσμα να επιτραπεί.
- **Χωρίς class-validator.** Ελάχιστος χειροκίνητος έλεγχος (`BadRequestException`
  σε λείποντα πεδία) — δεν αξίζει άλλη εξάρτηση για λίγα endpoints.
