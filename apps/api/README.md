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
| `POST /servers/:host/sync` | `Bearer <Server.token>` | σώμα = snapshot του stream server, απάντηση = clients.json — **μία εγγραφή ανά συνδρομή** αυτού του server (κλειδί `όνομαΠελάτη#idΣυνδρομής`), με το `limit` του πλάνου της και τα δικά της paths. Οι disabled πελάτες λείπουν |
| `GET /live` | admin | τελευταίο snapshot όλων των servers, από τη μνήμη· `online: false` αν `ts` > 30s |
| `GET /servers` / `POST /servers` | admin | CRUD server· το `token` παράγεται μόνο του αν δεν δοθεί |
| `GET/PATCH/DELETE /servers/:id` | admin | |
| `GET /servers/:host/series?range=` | admin | proxy → `/admin/api/series` του stream server (basic auth από το Server) |
| `GET /servers/:host/sessions` | admin | proxy → `/admin/api/sessions` |
| `DELETE /servers/:host/sessions/:id` | admin | proxy → `/admin/api/sessions/:id` |
| `POST /servers/:host/restart` | admin | proxy → `/admin/api/restart` |
| `GET /clients` / `POST /clients` | admin | `POST` δέχεται προαιρετικά `username`+`password` — φτιάχνει μαζί και τον customer χρήστη (δες «Αποφάσεις» παρακάτω). Το `GET` δίνει και `users: [{id, username}]`, **χωρίς** το hash του κωδικού |
| `GET/PATCH/DELETE /clients/:id` | admin | `PATCH` για `disabled`, `name` και `username`/`password` του χρήστη του πελάτη (ό,τι δεν σταλεί μένει ως έχει· μόνο `password` σε πελάτη **χωρίς** χρήστη → **400**, username που υπάρχει → **409**). Τα πλάνα **δεν** περνάνε από εδώ, δες τα subscriptions· `DELETE` σβήνει συνδρομές και paths (cascade) |
| `GET /plans` / `POST /plans` | admin | ο κατάλογος: `{name, maxViewers, maxStreams, serverId}`, τα δύο όρια ακέραιοι **≥1**· ο `serverId` είναι ο server των **επόμενων** συνδρομών |
| `PATCH/DELETE /plans/:id` | admin | αλλαγή ορίων = ισχύει **και** για τις υπάρχουσες συνδρομές (τα διαβάζουν από εδώ)· αλλαγή `serverId` = «από δω και πέρα πουλάει εκεί», καμία υπάρχουσα δεν μετακομίζει· `DELETE` με συνδρομές → **409** |
| `POST /clients/:id/subscriptions` | admin | `{planId}` → μία αγορά. Ο `serverId` της είναι στιγμιότυπο του πλάνου **τώρα** και δεν ξαναλλάζει. Χωρίς ποσότητα: δύο φορές το ίδιο πλάνο = δύο συνδρομές |
| `PATCH /clients/:id/subscriptions/:subId` | admin | `{disabled}` — **αναστολή μιας μόνο συνδρομής** (π.χ. έληξε), ανεξάρτητα από το `Client.disabled` που τις κόβει όλες. Η συνδρομή φεύγει από το clients.json σε ≤10s· paths και κλειδιά μένουν ανέπαφα για την επαναφορά |
| `DELETE /clients/:id/subscriptions/:subId` | admin | **409** όσο κρατάει streams — σβήσ' τα πρώτα, για να μη χαθούν σιωπηλά κλειδιά εκπομπής |
| `POST /clients/:id/paths` | admin | `{path, subscriptionId}` → παράγει κλειδί (16 bytes, base64url). Το `path` είναι **προαιρετικό**: χωρίς αυτό βγαίνει `/live/c<idΠελάτη>-s<idΣυνδρομής>-<ν>`, με το `ν` να συνεχίζει από το μεγαλύτερο υπάρχον της συνδρομής. Ο server έρχεται από τη συνδρομή· **404** αν η συνδρομή είναι άλλου πελάτη, **409** αν το πλάνο της δεν χωράει άλλο stream ή αν το path υπάρχει ήδη σε αυτόν τον server |
| `POST /clients/:id/paths/:pathId/key` | admin | **νέο κλειδί στο ίδιο path** (εκτεθειμένο κλειδί): το path, η διεύθυνση προβολής και ό,τι έχει ενσωματωθεί μένουν· ο publisher με το παλιό κόβεται σε ≤10s. **404** αν το path είναι άλλου πελάτη |
| `DELETE /clients/:id/paths/:pathId` | admin | |
| `POST /me/streams/:id/key` | οποιοσδήποτε συνδεδεμένος | το ίδιο, από τον ίδιο τον πελάτη — το `id` έρχεται από το `GET /me/streams` και ελέγχεται με το `clientId` του token (ξένο path → **404**, admin χωρίς `clientId` → **404**) |
| `GET /me/streams` | οποιοσδήποτε συνδεδεμένος | τα paths του πελάτη του token (admin χωρίς `clientId` → `[]`). Κάθε entry: `id` (του path, για την ανανέωση κλειδιού), `host` (το domain του stream server), `path`, `key`, `streamKey` (`όνομα?key=...`), `plan` και `subscriptionId` (σε ποιο αγορασμένο πλάνο ανήκει), `suspended` (η συνδρομή είναι σε αναστολή — το stream φαίνεται αλλά δεν εκπέμπει), `limit` (το όριο **αυτού του πλάνου**), `viewers`, `since` (πότε συνδέθηκε ο publisher, `null` = δεν εκπέμπει), `in_bps`, `out_bps` και `r2Estimate` (η έξοδος είναι εκτίμηση όταν τα segments φεύγουν από CDN) — τα πέντε τελευταία από το τελευταίο snapshot |
| `GET /me/series?range=` | οποιοσδήποτε συνδεδεμένος | ίδιο proxy με το `/servers/:host/series`, αλλά **μόνο** για τα paths του πελάτη του token και χωρίς το `server` block (CPU/μνήμη). Οι servers βγαίνουν από τις συνδρομές του, δεν τους διαλέγει ο caller — με paths σε δύο μηχανήματα ρωτάει και τα δύο και ενώνει (ένα πεσμένο δεν ρίχνει το γράφημα του άλλου) |

**Πλάνα και συνδρομές:** ο κατάλογος (`Plan`) είναι ό,τι πουλάμε· η **συνδρομή**
(`Subscription`) είναι μία αγορά ενός πλάνου και η μονάδα των πάντων. Ο πελάτης
έχει 0..Χ συνδρομές και **τίποτα δεν αθροίζεται**: δύο «basic» των 50 θεατών
είναι δύο πλάνα των 50, όχι ένα των 100. Κάθε συνδρομή έχει δικό της server, δικό
της όριο θεατών και δικά της streams — το `Path` κρέμεται από τη συνδρομή, όχι από
τον πελάτη, αλλιώς το όριο δεν θα είχε πού να επιβληθεί.

**Αναστολή:** το `Subscription.disabled` κόβει **μία** συνδρομή — ο πελάτης με τρία
πλάνα που έληξε το ένα κρατάει τα άλλα δύο ζωντανά. Το `Client.disabled` μένει για
«όλα κάτω». Και στις δύο περιπτώσεις η συνδρομή απλώς λείπει από το clients.json:
άγνωστο path = μπλόκο στον stream server, οπότε η εκπομπή πέφτει σε ≤10s χωρίς να
χαθεί ούτε path ούτε κλειδί — η επαναφορά είναι ένα κλικ.

Ο stream server δεν μαθαίνει ποτέ τι είναι πλάνο: παίρνει έτοιμο `limit` στο
clients.json, με το ίδιο σχήμα όπως πάντα. Το κόλπο είναι ότι το sync γράφει **μία
εγγραφή ανά συνδρομή** αντί για μία ανά πελάτη — ο stream server ομαδοποιεί τους
θεατές ανά εγγραφή (`config.js#clientOf`, `stats.js#overLimit`), οπότε το όριο του
κάθε πλάνου επιβάλλεται στα δικά του paths **χωρίς να αλλάξει γραμμή εκεί**. Το
όριο streams μετράει paths και επιβάλλεται μόνο στο `POST /clients/:id/paths` —
paths που υπάρχουν ήδη δεν κόβονται αν αργότερα μικρύνει το πλάνο.

**Τι παγώνει στην αγορά και τι όχι:** ο **server** είναι στιγμιότυπο, τα **όρια**
όχι. Ο πελάτης που πήρε «basic» όσο το basic έδειχνε `stream1` μένει στο `stream1`
για πάντα· αν αύριο το basic δείχνει `stream2`, εκεί πάει μόνο η **επόμενη**
συνδρομή — έτσι γεμίζει ένας server χωρίς να πειραχτεί κανείς από όσους ήδη
κάθονται εκεί, και ο ίδιος πελάτης μπορεί να έχει πλάνα σε δύο μηχανήματα. Τα
όρια όμως τα διαβάζουν όλες οι συνδρομές ζωντανά από τον κατάλογο: αλλάζεις το
basic σε 80 θεατές και το παίρνουν όλοι, χωρίς να τους πειράξεις έναν έναν.

`DELETE /servers/:id` που τον χρησιμοποιεί πλάνο, συνδρομή ή path δίνει **409**:
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
    (reset). Δημιουργία και αλλαγή περνάνε από την ίδια `setUser`: χωριστά, το
    ένα από τα δύο θα ξέχναγε το `hashPassword` ή το 409 του διπλού username.
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
