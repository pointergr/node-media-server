# Πλάνο: monorepo, NestJS API, Nuxt panels

Κατάσταση: **σχέδιο, δεν έχει υλοποιηθεί**. Γραμμένο 2026-08-13.
Συμπληρώνει το [PLAN-multitenant.md](PLAN-multitenant.md) — εκεί περιγράφεται *τι*
κάνει η κεντρική διαχείριση, εδώ *πού ζει και πώς χτίζεται*.

Σήμερα το repo είναι ένα package: ο stream server στη ρίζα και δύο στατικά HTML
στο `admin/`, που τα σερβίρει ο ίδιος ο `stats.js` από το `PAGES` map. Ο στόχος
είναι monorepo με τρία apps: ο stream server όπως είναι, ένα NestJS API για την
κεντρική διαχείριση, και ένα Nuxt SPA που καλύπτει και το admin και το user panel.

## Αποφάσεις

**Το per-server dashboard μεταναστεύει στο Nuxt.** Ο `stats.js` κρατάει μόνο το
JSON API (`/admin/api/{live,series,sessions}`, DELETE session, restart), το
`PAGES` map και ο φάκελος `admin/` σβήνουν. Ο browser δεν χτυπάει ποτέ ξανά
απευθείας στο 8001 ενός stream server — μιλάει μόνο στο NestJS, που κάνει proxy.

**Ένα Nuxt app για τα δύο panels, όχι δύο.** Το admin ζει σε `/admin/*` πίσω από
role guard. Δύο apps σημαίνουν δύο builds, δύο auth flows και κοινά components
που ζητάνε αμέσως shared library. Χωρίζεις όταν το user panel αποκτήσει δικό του
domain ή branding — μέχρι τότε είναι ίδια εφαρμογή με άλλα δικαιώματα.

**npm workspaces, όχι pnpm/turbo/nx.** Το repo είναι ήδη σε npm με volta pin στο
Node 24. Τρία packages δεν χρειάζονται ούτε remote cache ούτε task graph. Πέρνα σε
pnpm μόνο αν αρχίσει να πονάει ο χρόνος install ή ο δίσκος στο CI.

**Χωρίς `packages/shared` στην αρχή.** Θα ήταν ο φυσικός τόπος για τους τύπους του
sync contract, αλλά ο stream server είναι JavaScript χωρίς types και δεν θα τους
χρησιμοποιούσε· θα κέρδιζε μόνο το NestJS, δηλαδή το ένα από τα δύο άκρα. Πρόσθεσέ
το όταν το contract αλλάξει δεύτερη φορά και σπάσει κάτι σιωπηλά — τότε μπαίνει και
build order στα images, που τώρα δεν υπάρχει.

**Nuxt με `ssr: false`**, `nuxt generate` → στατικά αρχεία που τα σερβίρει ο
Caddy. Κανένα Node runtime για το UI, καμία τρίτη διεργασία στο deployment.

## Δομή

```
node-media-server/                 (ίδιο git repo)
├─ package.json                    workspaces + scripts που τρέχουν τα πάντα
├─ CLAUDE.md, README.md
├─ PLAN-*.md
├─ apps/
│  ├─ stream/                      ό,τι είναι σήμερα στη ρίζα
│  │  ├─ app.js stats.js r2.js ertmp.js config.js passwords.js
│  │  ├─ test-*.js
│  │  ├─ config.example.json .env.example
│  │  ├─ Dockerfile docker-compose.yml Caddyfile install
│  │  └─ package.json
│  ├─ api/                         NestJS
│  │  ├─ src/{clients,servers,sync,auth,stats}/
│  │  ├─ prisma/schema.prisma
│  │  ├─ Dockerfile docker-compose.yml   (μαζί με το panel + Caddy)
│  │  └─ package.json
│  └─ panel/                       Nuxt SPA (admin + user)
│     ├─ nuxt.config.ts            ssr: false
│     ├─ pages/{index,streams/[id]}.vue, pages/admin/**
│     ├─ middleware/auth.ts        role guard
│     └─ package.json
└─ docs/  (προαιρετικά, αν τα PLAN-*.md πληθύνουν)
```

Κάθε app κουβαλάει τα δικά του αρχεία deployment. Ο stream server παραμένει
αυτοτελώς deployable ακριβώς όπως σήμερα — αυτό δεν είναι αισθητική επιλογή, είναι
η προϋπόθεση για να μη γίνει το monorepo λόγος να ξαναγγιχτούν 40 μηχανήματα.

## Τι κάνει το NestJS

| Endpoint | Ποιος καλεί | Σημείωση |
|---|---|---|
| `POST /servers/:host/sync` | stream server ανά 10s | bearer token ανά server· σώμα = snapshot, απάντηση = clients |
| `GET /clients`, `POST/PATCH/DELETE /clients/:id` | admin panel | πελάτες, paths, κλειδιά, `limit` |
| `GET /me/streams` | user panel | μόνο τα paths του πελάτη + stream key |
| `GET /live` | admin panel | το τελευταίο snapshot όλων των servers, από τη μνήμη |
| `GET /servers/:host/series` | admin panel | proxy στο `/admin/api/series` του server |
| `DELETE /servers/:host/sessions/:id` | admin panel | proxy, για άμεσο κόψιμο |

Το ιστορικό μένει στο sqlite κάθε stream server (υπάρχει ήδη, `stats.js`) και το
τραβάει ο Nest με proxy. Μην το αντιγράψεις κεντρικά: server κάτω σημαίνει ούτως ή
άλλως ότι δεν υπάρχει τίποτα ζωντανό να δεις.

**Δεδομένα του Nest**: πελάτες, paths, κλειδιά, όρια, χρήστες, servers. Λίγες
εκατοντάδες γραμμές — sqlite με Prisma φτάνει και πάει σε Postgres αλλάζοντας
provider. **Auth**: JWT με `@nestjs/jwt` και ένα guard με ρόλους (`admin` /
`customer`), χωρίς passport. Ο guard του sync είναι ξεχωριστός: static token ανά
server, από το `config.panel.token`.

## Σειρά υλοποίησης

Κάθε βήμα αφήνει το production λειτουργικό και μπορεί να σταματήσει εκεί.

### 0. Lockfile στο git και `npm ci` (ανεξάρτητο, γίνεται σήμερα)

Δεν έχει σχέση με το monorepo και δεν χρειάζεται να περιμένει κανένα από τα
επόμενα βήματα — αλλά πρέπει να προηγηθεί, γιατί αλλιώς κάθε βήμα παρακάτω
δοκιμάζεται πάνω σε διαφορετικά δέντρα εξαρτήσεων.

Σήμερα το `package-lock.json` είναι στο `.gitignore` και το `Dockerfile:16` κάνει
`npm install --omit=dev`: κάθε build τραβάει ό,τι υπάρχει εκείνη τη στιγμή στο npm
registry, άρα δύο servers που στήθηκαν σε διαφορετικές μέρες δεν τρέχουν τον ίδιο
κώδικα — και ένα σπασμένο minor release τρίτου πακέτου εμφανίζεται μόνο στα
καινούρια μηχανήματα, ενώ τα παλιά συνεχίζουν μια χαρά.

- βγάλε το `package-lock.json` από το `.gitignore` και κάνε το commit
- `Dockerfile`: `npm install --omit=dev` → `npm ci --omit=dev`, και το `COPY
  package.json ./` γίνεται `COPY package.json package-lock.json ./` (χωρίς το
  lock στο image, το `npm ci` σκάει)
- `install:76`: `npm install` → `npm ci`
- σβήσε το πλέον άκυρο σχόλιο του `Dockerfile:14` («το package-lock.json είναι στο
  .gitignore, οπότε install»)

Επαλήθευση: `docker compose build --no-cache` και `npm test` — δύο builds στη
σειρά πρέπει να δίνουν ίδιες εκδόσεις στο `npm ls`.

### 1. Μετακόμιση σε workspaces (κανένα λειτουργικό κέρδος, όλο το ρίσκο)

`git mv` όλα τα αρχεία της ρίζας στο `apps/stream/` (με `git mv` ώστε να μη χαθεί
το ιστορικό), ρίζα:

```json
{ "private": true, "workspaces": ["apps/*"],
  "scripts": { "test": "npm test -ws --if-present", "start": "npm start -w apps/stream" } }
```

Τι πρέπει να ελεγχθεί ένα προς ένα, γιατί όλα υποθέτουν ότι το cwd είναι η ρίζα:

- `install:39` — το `if [ ! -f config.example.json ]` και το `cd` μετά το clone
  θέλουν `cd apps/stream`.
- `docker-compose.yml` — `build: .` γίνεται `build: ./` σχετικά με τη νέα του θέση·
  το bind mount `./config.json:/app/config.json` επίσης.
- `Dockerfile` — **εδώ σπάει η αυτοτέλεια του app**: με workspaces το
  `package-lock.json` είναι ένα και ζει στη ρίζα, οπότε ένα context στο
  `apps/stream` δεν το βλέπει και το `npm ci` του Βήματος 0 αποκλείεται. Το
  context γίνεται η ρίζα του monorepo:

  ```dockerfile
  COPY package.json package-lock.json ./
  COPY apps/stream/package.json apps/stream/
  RUN npm ci --omit=dev -w apps/stream
  COPY apps/stream/ apps/stream/
  WORKDIR /app/apps/stream
  ```

  και στο compose `build: { context: ../.., dockerfile: apps/stream/Dockerfile }`.
  Θέλει και `.dockerignore` στη ρίζα, αλλιώς μπαίνουν στο context τα `apps/api`,
  `apps/panel` και όλα τα `node_modules` τους.
- Όλα τα σχετικά paths του κώδικα (`./config.json`, `./data`, `./media`,
  `./stats.db`) είναι σχετικά με το **cwd**, όχι με το αρχείο: το
  `pm2 start app.js` πρέπει να τρέξει μέσα στο `apps/stream`, αλλιώς ο server
  σηκώνεται και γράφει σε λάθος φάκελο χωρίς κανένα σφάλμα.
- `npm test` του stream server μένει ως έχει (σκέτα node scripts).

Επαλήθευση: καθαρή εγκατάσταση σε VM με `./install`, και στα δύο μονοπάτια
(bare metal + `--docker`), μέχρι να παίξει εκπομπή. Αυτό το βήμα δεν έχει tests
που να το πιάνουν — μόνο πραγματικό deploy.

### 2. NestJS σκελετός + sync

`apps/api` με modules `auth`, `servers`, `clients`, `sync`. Πρώτο πράγμα που
δουλεύει: το `POST /servers/:host/sync` που δέχεται snapshot και επιστρέφει
clients — δηλαδή η Φάση 5 του άλλου πλάνου, με το `panel.js` του stream server
απέναντι. e2e test: token λάθος → 401, σωστό → επιστρέφει μόνο τους πελάτες αυτού
του server.

Από εδώ και πέρα η κεντρική διαχείριση λειτουργεί χωρίς UI (curl/seed), και ο
stream server έχει ήδη ό,τι χρειάζεται.

### 3. Nuxt admin σε ισοδυναμία με το σημερινό dashboard

`apps/panel` με `ssr: false`, login → JWT, `pages/admin/index.vue` που δείχνει ό,τι
δείχνει σήμερα το `admin/dashboard.html` (live streams, θεατές, bitrate, πρόσφατες
συνδέσεις, restart) αλλά για **όλους** τους servers, μέσω `GET /live`. Ο player
(`admin/player.html`, hls.js) γίνεται σελίδα `/admin/streams/[id]`.

Ισοδυναμία σημαίνει: δεν σβήνεις τίποτα πριν δεις τα ίδια νούμερα και στα δύο.

### 4. Σβήσιμο του παλιού UI

Από τον `stats.js` φεύγουν το `PAGES` map και το σερβίρισμα HTML, μαζί ο φάκελος
`apps/stream/admin/`. Μένουν το JSON API και το basic auth — τώρα το καταναλώνει
ο Nest, όχι browser. Στον `Caddyfile` το `/admin` μπορεί πλέον να περιοριστεί στην
IP του κεντρικού server· δεν είναι απαραίτητο, το basic auth μένει ούτως ή άλλως.

### 5. User panel

`pages/index.vue`: τα streams του πελάτη, το stream key του (`όνομα?key=...`)
έτοιμο για αντιγραφή στο OBS, ο μετρητής θεατών σε σχέση με το όριό του, και ο
player. Καμία νέα λειτουργία στο API πέρα από το `GET /me/streams`.

## Deployment μετά την αλλαγή

- **Κάθε stream server**: ό,τι και σήμερα (`./install <hostname> [--docker]`),
  απλώς μέσα από `apps/stream`.
- **Ένας κεντρικός host**: `apps/api/docker-compose.yml` με τρεις υπηρεσίες —
  Nest, Caddy, και το build output του Nuxt ως στατικά αρχεία (`file_server` με
  SPA fallback στο `index.html`, `/api/*` → Nest). Το Nuxt δεν τρέχει, μεταγλωττίζεται.

## Τι δεν κάνουμε

Turborepo/nx (τρία packages, κανένα cache να κερδίσεις), shared UI library, SSR,
GraphQL, microservices, μετατροπή του stream server σε TypeScript. Το τελευταίο
ειδικά: ο κώδικας του stream server είναι πυκνός σε σχόλια που εξηγούν συμπεριφορά
του nms — μια μετάφραση σε TS θα τα ρισκάρει χωρίς να λύσει κανένα πρόβλημα που
έχουμε σήμερα.

## Ανοιχτά

- Ένα domain για το panel (`panel.example.com`) ή subdomain ανά πελάτη;
- Ο Nest κρατάει τα snapshots μόνο στη μνήμη — μετά από restart το `/live` είναι
  άδειο μέχρι το επόμενο tick (≤10s). Αποδεκτό, αλλά να το ξέρει το UI.
- Ενημέρωση `CLAUDE.md`: οι εντολές αλλάζουν (`npm start -w apps/stream`), και
  ίσως θέλει δικό του `CLAUDE.md` κάθε app.
