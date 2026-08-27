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

Τρεις ξεχωριστοί μηχανισμοί, κανένας passport:

- **JWT** (`@nestjs/jwt`) για χρήστες: `POST /auth/login` → `access_token`.
  Global guard σε κάθε route εκτός `@Public()`. Payload: `sub` (user id),
  `role` (`admin`/`customer`), `clientId` (`null` για admin).
- **API key** (`ApiKey`) για εξωτερικές υπηρεσίες που κάνουν provisioning:
  `Authorization: Bearer pk_…` στα ίδια endpoints, χωρίς login και χωρίς λήξη.
  Ο ίδιος guard το ξεχωρίζει από το πρόθεμα `pk_` και γεμίζει το ίδιο `req.user`
  με `role: "admin"`, οπότε τίποτα κατάντη (`@Roles`, `/me`) δεν αλλάζει.
- **Static bearer token ανά server** (`Server.token`) μόνο για το
  `POST /servers/:host/sync` — ο stream server δεν συνδέεται ποτέ σαν χρήστης.

Και ένα βραχύβιο JWT ως **link σύνδεσης** (`POST /auth/login-link`), για να
στέλνει το billing τον πελάτη στο panel χωρίς κωδικούς — δες παρακάτω.

Κωδικοί: `node:crypto` `scrypt` (ασύγχρονο) + `timingSafeEqual`
(`src/auth/password.ts`), όχι bcrypt/argon — καμία native εξάρτηση στο image.
**Ελάχιστο μήκος 8** και ο έλεγχος ζει μέσα στο `hashPassword`: κωδικό γράφουν
τρία σημεία (admin για πελάτη, ο καθένας για τον εαυτό του, το `seed`) και ένας
έλεγχος ανά σημείο σημαίνει ότι κάποιο θα τον ξεχάσει. Τα API keys όμως με
**sha256** (`src/auth/apikey.ts`): το scrypt είναι σκόπιμα αργό και εδώ θα το
πλήρωνε κάθε αίτημα, ενώ 24 τυχαία bytes δεν έχουν λεξικό να τα μαντέψει.

Τρία πράγματα που κρατάνε όρθιο το παραπάνω και δεν φαίνονται από τα endpoints:

- **`JWT_SECRET`: καμία αναδίπλωση** (`src/auth/secret.ts`). Χωρίς τυχαία τιμή
  ≥32 χαρακτήρων η διεργασία **δεν ξεκινάει**. Fallback σήμαινε server που
  δουλεύει κανονικά υπογράφοντας με μυστικό που διαβάζεται από το repo — δηλαδή
  admin token για όποιον το βρει, χωρίς κανένα σημάδι στα logs. Γι' αυτό και το
  `.env.example` έχει **κενό** `JWT_SECRET` (`openssl rand -base64 32`).
  Ο αλγόριθμος είναι καρφωμένος σε `HS256` και στο sign και στο verify.
- **Φρενάρισμα του login** (`src/auth/throttle.ts`): 10 συνεχόμενες **αποτυχίες**
  ανά IP+username → `429` για 15 λεπτά, και η πρώτη επιτυχία μηδενίζει τον
  μετρητή. Μόνο οι αποτυχίες μετράνε, ώστε να μην κόβεται πελάτης που δουλεύει.
  Χωρίς αυτό, το μαντεψιμο ήταν και δωρεάν και ακριβό για εμάς: κάθε προσπάθεια
  πληρώνει ένα scrypt. Στη μνήμη ενός process — με δεύτερο instance θέλει κοινό
  store. Το `main.ts` δηλώνει `trust proxy` (ένα άλμα, ο Caddy), αλλιώς όλος ο
  κόσμος μετριέται σε μία IP.
- **Ένα API key δεν είναι άνθρωπος** (`src/auth/human-only.ts`): έχει ρόλο admin,
  αλλά όχι στη διαχείριση κλειδιών και όχι στους χειρισμούς των μηχανημάτων
  (`restart`, kill session) — δες «API keys».

### API keys

Από το panel: **/admin/apikeys** (δημιουργία, λίστα με την τελευταία χρήση,
ανάκληση). Ή από shell στον host, που δουλεύει και με χαμένο κωδικό admin:

```bash
docker compose exec api node dist/src/apikey.js "e-shop"     # τυπώνει το κλειδί ΜΙΑ φορά
docker compose exec api node dist/src/apikey.js list         # ποια υπάρχουν, πότε χρησιμοποιήθηκαν
docker compose exec api node dist/src/apikey.js revoke 3     # ή revoke "e-shop" (όλα του ονόματος)
```

Αποθηκεύεται μόνο το sha256, οπότε χαμένο κλειδί σημαίνει καινούργιο κλειδί.
Η ανάκληση είναι μία διαγραφή γραμμής και δεν αγγίζει κανέναν χρήστη — σε
αντίθεση με μακρόβιο JWT, που για να ακυρωθεί θέλει αλλαγή του `JWT_SECRET`,
δηλαδή αποσύνδεση όλων. Το κλειδί έχει **δικαιώματα admin** παντού εκτός από δύο
σημεία, όπου απαντάει **403** (`src/auth/human-only.ts`, το `sub` του key είναι
αρνητικό):

- `/apikeys` — ένα κλειδί δεν γεννάει διαδόχους, αλλιώς η ανάκληση δεν τελειώνει
  ποτέ: σβήνεις μία γραμμή και ο επιτιθέμενος έχει ήδη άλλες δύο.
- `POST /servers/:host/restart` και `DELETE /servers/:host/sessions/:id` — το
  provisioning φτιάχνει πελάτες και servers, δεν ρίχνει εκπομπές που παίζουν.

Δεν είναι scopes: στα υπόλοιπα το κλειδί μπορεί ό,τι κι ένας admin. Γι' αυτό δώσε
ένα ανά υπηρεσία, ώστε η ανάκληση του ενός να μη σταματάει τις άλλες. (Scoped keys
ανά πελάτη θα ήθελαν `role`/`clientId` στο μοντέλο — δεν μπήκαν μέχρι να
χρειαστούν.)

### Provisioning από εξωτερική υπηρεσία

Η σειρά είναι πελάτης → συνδρομή → path, γιατί το path παίρνει server και όριο
θεατών **από τη συνδρομή** (δες «Πλάνα και συνδρομές» παρακάτω). Τα δύο πρώτα
βήματα γίνονται μία φορά ανά αγορά, το τρίτο μία φορά ανά stream:

```bash
API=https://panel.example.com/api
KEY=pk_…

# 0. ποια πλάνα πουλάμε (το planId είναι ό,τι διάλεξε ο πελάτης στο site)
curl -H "authorization: Bearer $KEY" $API/plans

# 1. ο πελάτης — προαιρετικά με τα στοιχεία εισόδου του στο panel
curl -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Πελάτης ΑΕ","username":"pelatis","password":"…"}' $API/clients

# 2. μία αγορά ενός πλάνου (ο server παγώνει εδώ, δεν ξαναλλάζει)
curl -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"planId":1}' $API/clients/7/subscriptions

# 3. το stream — χωρίς `path` το ονομάζει μόνο του (/live/c7-s3-1)
curl -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"subscriptionId":3}' $API/clients/7/paths
```

Το βήμα 3 επιστρέφει το `key` εκπομπής. Τη διεύθυνση RTMP δεν την επιστρέφει
κανένα endpoint — τη συνθέτει ο caller: `rtmp://rtmp.<host της συνδρομής>/<πρώτο
κομμάτι του path>`, ακριβώς όπως το `apps/panel/app/pages/index.vue`.

Ό,τι πάει στραβά έχει δικό του status και **δεν** είναι 500: άγνωστο πλάνο ή
όρια < 1 → 400, συνδρομή άλλου πελάτη → 404, γεμάτο πλάνο ή path που υπάρχει
ήδη → 409, ίδιο `name`/`username` → 409. Δηλαδή το retry έχει νόημα μόνο στα
5xx — τα 4xx θέλουν διόρθωση των δεδομένων, όχι ξανά την ίδια κλήση.

Ακύρωση συνδρομής: `PATCH /clients/:id/subscriptions/:subId {"disabled":true}` —
η εκπομπή πέφτει σε ≤10s, τα paths και τα κλειδιά μένουν για την επαναφορά. Το
`DELETE` είναι για τα οριστικά, και επιστρέφει 409 όσο κρατάει streams.

Αναβάθμιση/υποβάθμιση: `PATCH /clients/:id/subscriptions/:subId {"planId":3}` —
ίδια συνδρομή, άλλο πλάνο. Τα paths και τα κλειδιά εκπομπής δεν πειράζονται (ο
πελάτης δεν ξαναστήνει OBS), τα όρια πιάνουν με το επόμενο sync και ο server
μένει αυτός της αγοράς. Υποβάθμιση σε πλάνο που δεν χωράει τα streams της
συνδρομής → **409**: σβήνει πρώτα ο διαχειριστής όσα περισσεύουν.

### Σύνδεση με link από το billing

Το εξωτερικό σύστημα ζητάει link και κάνει redirect τον χρήστη σε αυτό — δεν
ξέρει, δεν κρατάει και δεν εκθέτει τον κωδικό του πελάτη:

```bash
curl -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"clientId":7}' $API/auth/login-link
# → {"url":"https://panel.example.com/login#t=eyJ…","expiresIn":300}
```

Δύο tokens και όχι ένα: το token του link ζει **5 λεπτά** και είναι **μιας
χρήσης**, το panel το ανταλλάσσει αμέσως (`POST /auth/exchange`) με κανονικό
12ωρο. Ένα μόνο token θα σήμαινε ή συνεδρία που λήγει σε πέντε λεπτά ή link που
ανοίγει τον λογαριασμό για δώδεκα ώρες. Το `once: true` στο payload είναι ο
διαχωρισμός — χωρίς αυτό, όποιος έχει συνεδρία θα την ανανέωνε επ' άπειρον από το
`exchange`.

Το token μπαίνει στο **fragment** (`#t=`), οπότε δεν φτάνει ποτέ σε log του
server ούτε σε `Referer`· η σελίδα το σβήνει από το URL πριν το ανταλλάξει. Τα
ξοδεμένα `jti` ζουν **στη μνήμη** του API: μετά από restart ένα link μπορεί να
ξαναχρησιμοποιηθεί μέσα στα 5' του — πίνακας στη sqlite για δεδομένα πέντε λεπτών
δεν αξίζει.

Τη διεύθυνση του panel δεν τη ρυθμίζει κανείς: βγαίνει από το `Host` του
αιτήματος (ίδιος host με το API — ο Caddy κόβει το `/api`). Μόνο στο `npm run
dev`, όπου το Nuxt είναι σε άλλη θύρα, θέλει `PANEL_URL=http://localhost:3001`.

## Endpoints

Ο πίνακας εδώ είναι για όποιον δουλεύει **μέσα** στο repo: τι κάνει το κάθε
endpoint και γιατί έτσι. Για όποιον καλεί το API απ' έξω (σώματα, απαντήσεις,
σφάλματα, ροή provisioning) υπάρχει ξεχωριστή αναφορά: [API.md](API.md).

| Endpoint | Auth | Σημείωση |
|---|---|---|
| `POST /auth/login` | καμία | `{username,password}` → `{access_token}`. Ίδιο **401** για άγνωστο χρήστη και για λάθος κωδικό, με ίδιο κόστος (πάντα ένα scrypt — αλλιώς το ρολόι λέει ποια ονόματα υπάρχουν). Μετά από 10 συνεχόμενες αποτυχίες σε IP+username → **429** για 15' |
| `POST /auth/login-link` | admin | `{clientId}` → `{url, expiresIn}`: link μιας χρήσης για τον χρήστη του πελάτη (**400** αν δεν έχει χρήστη). Το URL είναι `<PANEL_URL>/login#t=<token 5'>` — από ρύθμιση (το compose δίνει `https://$DOMAIN`), με πτώση στο `Host` του αιτήματος μόνο αν λείπει: αλλιώς ο caller διαλέγει πού θα σταλεί ο πελάτης με το token του |
| `POST /auth/exchange` | καμία | `{token}` του link → `{access_token}` 12ωρο (ίδιο φρενάρισμα με το login, ανά IP). **401** αν έχει λήξει, αν ξοδεύτηκε ήδη, ή αν είναι κανονικό token συνεδρίας (λείπει το `once`) |
| `GET /auth/me` | οποιοσδήποτε συνδεδεμένος | `{username, role, clientId}` — ό,τι δεν χωράει στο JWT. Το username **δεν** μπαίνει στο payload επίτηδες: μετά από αλλαγή θα έδειχνε το παλιό μέχρι την επόμενη σύνδεση. API key → **401** (δεν έχει λογαριασμό) |
| `PATCH /auth/me` | οποιοσδήποτε συνδεδεμένος | `{currentPassword, username?, password?}` — αλλάζει τα **δικά του** στοιχεία (το id βγαίνει από το token, ποτέ από το σώμα). Λάθος `currentPassword` → **401**, username που υπάρχει → **409**. Το token μένει έγκυρο: το payload δεν αλλάζει |
| `POST /servers/:host/sync` | `Bearer <Server.token>` | σώμα = snapshot του stream server, απάντηση = clients.json — **μία εγγραφή ανά συνδρομή** αυτού του server (κλειδί `όνομαΠελάτη#idΣυνδρομής`), με το `limit` του πλάνου της και τα δικά της paths. Οι disabled πελάτες λείπουν. Πλάνο με ladder προσθέτει `"ladder": [720, 480]` (array από αριθμούς)· χωρίς ladder το κλειδί **λείπει εντελώς**, ώστε το αρχείο των σημερινών πελατών να μένει byte-για-byte ίδιο. Ίδια σύμβαση για την αναδιανομή: `"relays": {"/live/x": [{"name":"YouTube","url":"rtmp://…/<key>"}]}` — μόνο οι **ενεργοί** προορισμοί, με το κλειδί της πλατφόρμας ήδη ενωμένο στο URL |
| `GET /apikeys` / `POST /apikeys` / `DELETE /apikeys/:id` | admin **χρήστης** | τα κλειδιά των εξωτερικών υπηρεσιών. Η λίστα δίνει `{id, name, lastUsed}` — ποτέ το hash. Το `POST {name}` επιστρέφει `{id, name, key}` και είναι η **μόνη** φορά που φεύγει η τιμή· κενό `name` → **400**. Με `Bearer pk_…` και τα τρία απαντούν **403**: ένα key που διέρρευσε δεν πρέπει να γεννάει διαδόχους |
| `GET /live` | admin | τελευταίο snapshot όλων των servers, από τη μνήμη· `online: false` αν `ts` > 30s |
| `GET /servers` / `POST /servers` | admin | CRUD server· το `token` παράγεται μόνο του αν δεν δοθεί. Το `POST` είναι η **μόνη** φορά που η απάντηση περιέχει `token` και `adminPass` — από εκεί τα παίρνει το install script (και το panel τα δείχνει μία φορά) |
| `GET/PATCH/DELETE /servers/:id` | admin | οι απαντήσεις **δεν** έχουν `token`/`adminPass`: ένα `GET` δεν πρέπει να παραδίδει τα μυστικά του μηχανήματος (και το `GET` το κάνει και κάθε API key). Ο κωδικός αλλάζει με `PATCH {adminPass}`, δεν διαβάζεται |
| `GET /servers/:host/series?range=` | admin | proxy → `/admin/api/series` του stream server (basic auth από το Server) |
| `GET /servers/:host/sessions` | admin | proxy → `/admin/api/sessions` |
| `GET /servers/:host/logs` | admin | proxy → `/admin/api/logs` — οι τελευταίες 300 γραμμές της κονσόλας του stream server (`[{ts, level, text}]`, ts σε ms, παλαιότερη πρώτη). Ζουν στη μνήμη του: restart του stream server = άδειο log |
| `DELETE /servers/:host/sessions/:id` | admin **χρήστης** | proxy → `/admin/api/sessions/:id`· με API key **403** |
| `POST /servers/:host/restart` | admin **χρήστης** | proxy → `/admin/api/restart`· με API key **403** |
| `GET /clients` / `POST /clients` | admin | `POST` δέχεται προαιρετικά `username`+`password` — φτιάχνει μαζί και τον customer χρήστη (δες «Αποφάσεις» παρακάτω). Το `GET` δίνει και `users: [{id, username}]`, **χωρίς** το hash του κωδικού, και δέχεται `?username=` — **αναζήτηση** πελάτη από το username του χρήστη του, με μερικό ταίριασμα, χωρίς διάκριση πεζών/κεφαλαίων στα ASCII (`?username=nik` και `?username=NIK` βρίσκουν τον `nikos` — sqlite LIKE)· κενό ή απόν = όλοι οι πελάτες |
| `GET/PATCH/DELETE /clients/:id` | admin | `PATCH` για `disabled`, `name` και `username`/`password` του χρήστη του πελάτη (ό,τι δεν σταλεί μένει ως έχει· μόνο `password` σε πελάτη **χωρίς** χρήστη → **400**, username που υπάρχει → **409**). Τα πλάνα **δεν** περνάνε από εδώ, δες τα subscriptions· `DELETE` σβήνει συνδρομές και paths (cascade) |
| `GET /plans` / `POST /plans` | admin | ο κατάλογος: `{name, maxViewers, maxStreams, serverId, ladder?, maxRelays?}`, τα δύο όρια ακέραιοι **≥1**· ο `serverId` είναι ο server των **επόμενων** συνδρομών. Το `ladder` είναι csv από ύψη σε **φθίνουσα** σειρά και χωρίς διπλά, μόνο από τα `1080,720,480,360,240` (**400** αλλιώς — ο stream server έχει σταθερό bitrate ανά ύψος): οι επιπλέον αναλύσεις (ABR) που πουλάει το πλάνο, **κάτω** από την πηγή — η κορυφή είναι πάντα η πηγή σε copy. Κενό ή απόν = καθόλου transcoding, και αποθηκεύεται ως `null`. Το API δεν ξέρει **με τι** κωδικοποιεί ο server (x264 ή GPU, `config.hls.encoder` εκεί) ούτε πόσα σκαλοπάτια αντέχει (`hls.maxRenditions`): ένα πλάνο μπορεί να υπόσχεται περισσότερα από όσα βγάζει το μηχάνημα, και ο δρόμος είναι να δείχνει ο `serverId` σε μηχάνημα που τα σηκώνει |
| `PATCH/DELETE /plans/:id` | admin | αλλαγή ορίων **και ladder** = ισχύει **και** για τις υπάρχουσες συνδρομές (τα διαβάζουν από εδώ· το νέο ladder πιάνει στην επόμενη εκπομπή, όχι σε όσες τρέχουν)· αλλαγή `serverId` = «από δω και πέρα πουλάει εκεί», καμία υπάρχουσα δεν μετακομίζει· `DELETE` με συνδρομές → **409** |
| `POST /clients/:id/subscriptions` | admin | `{planId}` → μία αγορά. Ο `serverId` της είναι στιγμιότυπο του πλάνου **τώρα** και δεν ξαναλλάζει. Χωρίς ποσότητα: δύο φορές το ίδιο πλάνο = δύο συνδρομές |
| `PATCH /clients/:id/subscriptions/:subId` | admin | `{planId}` — **αναβάθμιση/υποβάθμιση**: αλλάζει μόνο το πλάνο, τα paths και τα κλειδιά εκπομπής μένουν ανέπαφα (γι' αυτό και όχι `DELETE` + `POST`, που θα τα έσβηνε). Τα νέα όρια πιάνουν με το επόμενο sync (≤10s), το νέο `ladder` στην επόμενη εκπομπή. Ο **server δεν αλλάζει** — έχει παγώσει στην αγορά και τα paths ζουν πάνω του, ακόμα κι αν το νέο πλάνο πουλάει σε άλλο μηχάνημα. **409** όταν η συνδρομή έχει περισσότερα streams από όσα επιτρέπει το νέο πλάνο (σβήσε πρώτα τα παραπανίσια — ποιο θα φύγει δεν είναι απόφαση του API), **400** σε άγνωστο πλάνο. Και `{disabled}` — **αναστολή μιας μόνο συνδρομής** (π.χ. έληξε), ανεξάρτητα από το `Client.disabled` που τις κόβει όλες. Η συνδρομή φεύγει από το clients.json σε ≤10s· paths και κλειδιά μένουν ανέπαφα για την επαναφορά. Και `{label}` — **φιλικό όνομα** της αγοράς («Εκκλησία», «Δημαρχείο»), ως 60 χαρακτήρες, κενό ή `null` το σβήνει· χωρίς αυτό δύο συνδρομές του ίδιου πλάνου είναι δύο φορές «basic», για τον admin και για τον πελάτη. Τα τρία πεδία ανεξάρτητα, άδειο σώμα → **400** |
| `DELETE /clients/:id/subscriptions/:subId` | admin | **409** όσο κρατάει streams — σβήσ' τα πρώτα, για να μη χαθούν σιωπηλά κλειδιά εκπομπής |
| `POST /clients/:id/paths` | admin | `{path, subscriptionId}` → παράγει κλειδί (16 bytes, base64url). Το `path` είναι **προαιρετικό**: χωρίς αυτό βγαίνει `/live/c<idΠελάτη>-s<idΣυνδρομής>-<ν>`, με το `ν` να συνεχίζει από το μεγαλύτερο υπάρχον της συνδρομής. Ο server έρχεται από τη συνδρομή· **404** αν η συνδρομή είναι άλλου πελάτη, **409** αν το πλάνο της δεν χωράει άλλο stream ή αν το path υπάρχει ήδη σε αυτόν τον server. Μορφή `/app/stream` και κανένα κομμάτι δεν αρχίζει από τελεία (`/../x` → **400**) |
| `POST /clients/:id/paths/:pathId/key` | admin | **νέο κλειδί στο ίδιο path** (εκτεθειμένο κλειδί): το path, η διεύθυνση προβολής και ό,τι έχει ενσωματωθεί μένουν· ο publisher με το παλιό κόβεται σε ≤10s. **404** αν το path είναι άλλου πελάτη |
| `DELETE /clients/:id/paths/:pathId` | admin | |
| `POST /clients/:id/paths/:pathId/destinations` | admin | `{name, url, key, enabled?}` → **προορισμός αναδιανομής** (YouTube κ.λπ.). Μόνο `rtmp://`/`rtmps://` και ποτέ προς τοπικό δίκτυο. **409** αν το πλάνο έχει `maxRelays: 0` ή αν γέμισε το όριο |
| `PATCH/DELETE /clients/:id/paths/:pathId/destinations/:destId` | admin | `PATCH` για `name`/`url`/`key`/`enabled` |
| `POST /me/streams/:id/destinations` | οποιοσδήποτε συνδεδεμένος | το ίδιο, από τον ίδιο τον πελάτη — αυτός συνδέει το **δικό του** κανάλι, χωρίς να περιμένει διαχειριστή |
| `PATCH/DELETE /me/streams/:id/destinations/:destId` | οποιοσδήποτε συνδεδεμένος | |
| `PATCH /me/subscriptions/:id` | οποιοσδήποτε συνδεδεμένος | `{label}` — ο πελάτης ονομάζει **μόνος του** τα πακέτα του (εκείνος ξέρει ποιο είναι η εκκλησία και ποιο το δημαρχείο). Μόνο το `label`: η αναστολή και η **αλλαγή πλάνου** είναι εμπορικές αποφάσεις και μένουν στο `/clients` (`{disabled}` ή `{planId}` εδώ → **400**). Ξένη συνδρομή ή admin χωρίς `clientId` → **404** |
| `POST /me/streams/:id/key` | οποιοσδήποτε συνδεδεμένος | το ίδιο, από τον ίδιο τον πελάτη — το `id` έρχεται από το `GET /me/streams` και ελέγχεται με το `clientId` του token (ξένο path → **404**, admin χωρίς `clientId` → **404**) |
| `GET /me/streams` | οποιοσδήποτε συνδεδεμένος | τα paths του πελάτη του token (admin χωρίς `clientId` → `[]`). Κάθε entry: `id` (του path, για την ανανέωση κλειδιού), `host` (το domain του stream server), `path`, `key`, `streamKey` (`όνομα?key=...`), `plan`, `subscriptionId` και `subscriptionLabel` (σε ποιο αγορασμένο πλάνο ανήκει — το `label` είναι το όνομα που του έδωσαν, `null` αν κανένα· το panel ομαδοποιεί με αυτά), `suspended` (η συνδρομή είναι σε αναστολή — το stream φαίνεται αλλά δεν εκπέμπει), `limit` (το όριο **αυτού του πλάνου**), `viewers`, `since` (πότε συνδέθηκε ο publisher, `null` = δεν εκπέμπει), `in_bps`, `out_bps` και `r2Estimate` (η έξοδος είναι εκτίμηση όταν τα segments φεύγουν από CDN) — τα πέντε τελευταία από το τελευταίο snapshot |
| `GET /me/subscriptions` | οποιοσδήποτε συνδεδεμένος | τα πακέτα του πελάτη του token (admin χωρίς `clientId` → `[]`): `id`, `plan`, `label`, `host`, `maxStreams`, `maxViewers`, `streams` (πόσα paths έχει ήδη) και `suspended`. Ξεχωριστό από το `GET /me/streams`, που γυρίζει **paths**: μια συνδρομή χωρίς κανένα stream δεν φαίνεται εκεί, και είναι ακριβώς η περίπτωση όπου ο πελάτης θέλει να φτιάξει το πρώτο του |
| `POST /me/streams` | οποιοσδήποτε συνδεδεμένος | `{subscriptionId}` → **νέο stream από τον ίδιο τον πελάτη**, με path και κλειδί από το API (ο πελάτης δεν διαλέγει όνομα path). Ίδια `addPath` με το admin endpoint, άρα ίδιο όριο: **409** όταν το πλάνο της συνδρομής δεν χωράει άλλο stream, **404** αν η συνδρομή είναι άλλου πελάτη ή ο caller δεν έχει `clientId` |
| `DELETE /me/streams/:id` | οποιοσδήποτε συνδεδεμένος | σβήνει **δικό του** stream (path + κλειδί). **409** όσο το τελευταίο snapshot δείχνει publisher πάνω του (`since`): το κλειδί φεύγει μαζί με το path, οπότε ένα κλικ την ώρα της εκπομπής θα την έκοβε χωρίς επιστροφή. Η κατάσταση είναι ≤10s παλιά — publisher που συνδέεται μέσα σε αυτό το παράθυρο κόβεται στο επόμενο sync. **404** για ξένο path ή caller χωρίς `clientId` |
| `GET /me/series?range=` | οποιοσδήποτε συνδεδεμένος | ίδιο proxy με το `/servers/:host/series`, αλλά **μόνο** για τα paths του πελάτη του token και χωρίς το `server` block (CPU/μνήμη). Οι servers βγαίνουν από τις συνδρομές του, δεν τους διαλέγει ο caller — με paths σε δύο μηχανήματα ρωτάει και τα δύο και ενώνει (ένα πεσμένο δεν ρίχνει το γράφημα του άλλου) |

Όπου ο πίνακας λέει `admin`, περνάει και **API key** (`Bearer pk_…`) — το ίδιο
δικαίωμα από άλλη πόρτα. Εξαιρέσεις: το `PATCH /auth/me` (**401** — το key δεν
έχει λογαριασμό να αλλάξει) και όσα λένε `admin **χρήστης**` (**403** — δες
«API keys»).

Και ένας κανόνας για όλο το `/me/*`: **σε αναστολή είναι read-only**. Ό,τι
γράφει (νέο stream, ανανέωση κλειδιού, προορισμοί, `label`) απαντάει **403** όταν
είναι σε αναστολή ο πελάτης ή το πακέτο· ό,τι διαβάζει συνεχίζει κανονικά, με το
`suspended: true` να λέει τον λόγο. Η εκπομπή έχει ήδη κοπεί από το sync (≤10s),
αλλά το API μέχρι πρόσφατα δεχόταν κανονικά γραψίματα — δηλαδή η αναστολή
φαινόταν παντού εκτός από εκεί που γράφεται.

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

## Αναδιανομή σε εξωτερικές πλατφόρμες

Ο πελάτης δίνει το Stream URL και το Stream key του καναλιού του (YouTube,
Facebook, Twitch, ό,τι δέχεται RTMP) και ο stream server σπρώχνει εκεί την ίδια
εκπομπή με έναν `ffmpeg -c copy` — δες `apps/stream/relay.js`.

- **Ο προορισμός κρέμεται από το `Path`, όχι από τη συνδρομή.** Κάθε κάμερα πάει
  στο δικό της κανάλι: δύο streams της ίδιας εκκλησίας δεν μοιράζονται
  λογαριασμό YouTube.
- **Το όριο (`Plan.maxRelays`) μετριέται ανά stream και το `0` σημαίνει
  «καθόλου»** — όχι «χωρίς όριο», αντίθετα από τα `maxViewers`/`maxStreams`.
  «Απεριόριστοι προορισμοί» δεν πουλιέται: ο καθένας είναι ένα ακόμα αντίγραφο
  της εκπομπής στο upstream του μηχανήματος, ενώ «κανένας» είναι η σωστή
  προεπιλογή για κάθε πλάνο που υπήρχε πριν το χαρακτηριστικό.
- **Καμία γνώση πλατφόρμας πουθενά.** Το API ενώνει `url` + `key` σε ένα
  `rtmp://…` και ο stream server σηκώνει ffmpeg. Νέα πλατφόρμα = μηδέν γραμμές
  κώδικα· τα presets του panel είναι σκέτη ευκολία πληκτρολόγησης.
- **Το `enabled: false` δεν πέφτει σε ≤10s**, σε αντίθεση με την αναστολή
  συνδρομής: οι προορισμοί διαβάζονται μία φορά, στην αρχή της εκπομπής
  (`apps/stream/app.js#postPublish`), οπότε η αλλαγή ισχύει από την επόμενη. Το
  να πέφτει και να ξανασηκώνεται ο ffmpeg κάθε φορά που ο πελάτης πειράζει τη
  λίστα θα έκοβε τους υπόλοιπους προορισμούς για ένα πράγμα που κανείς δεν
  περιμένει να γίνει άμεσα.
- **Ο έλεγχος του URL είναι θέμα ασφάλειας, όχι μορφής.** Είναι το μοναδικό
  σημείο όπου το API δέχεται διεύθυνση δικτύου από τον χρήστη και τη δίνει σε
  μηχάνημα δικό μας να τη συνδεθεί: `destinations.ts` κόβει ό,τι δεν είναι
  `rtmp`/`rtmps` και ό,τι δείχνει σε loopback ή ιδιωτικό δίκτυο (το
  `169.254.169.254` είναι το metadata endpoint κάθε cloud provider). Ο stream
  server κρατάει τη μία εγγύηση που μόνο αυτός μπορεί να δώσει — ποτέ πίσω στη
  **δική του** θύρα, που θα ήταν βρόχος τροφοδοσίας.
- **`-c copy`, καμία επανακωδικοποίηση.** Μηδέν CPU, αλλά τα όρια της
  πλατφόρμας (keyframe interval 2s, ήχος AAC, το ~6 Mbps του Twitch) τα πληρώνει
  το πρόγραμμα εκπομπής του πελάτη. Το `rtmps` που απαιτεί το Facebook θέλει
  ffmpeg χτισμένο με TLS — ο stream server το ελέγχει στο boot και γράφει
  προειδοποίηση, γιατί αλλιώς το μόνο ορατό σύμπτωμα είναι ένα relay που κάνει
  «επανασύνδεση» για πάντα.

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
  σε λείποντα πεδία) — δεν αξίζει άλλη εξάρτηση για λίγα endpoints. Με ένα
  συμπλήρωμα που δεν είναι προαιρετικό: κανένα service δεν κάνει **spread** του
  σώματος στο Prisma, γράφει ρητά τα πεδία του σχήματος. Με spread, ό,τι έστελνε
  ο caller παραπάνω περνούσε αυτούσιο — άγνωστο κλειδί έβγαζε 500, γνωστό
  (`id`, `lastSeen`) γραφόταν χωρίς να το ζητήσει κανείς.
- **Χωρίς `@nestjs/throttler`.** Το φρενάρισμα του login είναι ένα `Map` με
  μετρητή αποτυχιών (`src/auth/throttle.ts`, ~30 γραμμές): ένα instance, ένα
  process — η βιβλιοθήκη θα έδινε storage adapters και decorators που δεν
  χρησιμοποιεί κανείς. Με δεύτερο instance αλλάζει αυτό, όχι τα call sites.
