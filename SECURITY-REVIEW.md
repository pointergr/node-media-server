# Security Review — 2026-08-16

Έλεγχος ολόκληρου του monorepo (`apps/stream`, `apps/api`, `apps/panel`), των deployment
configs (Dockerfiles, Caddyfiles, compose, `install`) και των dependencies — συμπεριλαμβανομένου
του vendored `node-media-server@4.2.8` ώστε να επαληθεύονται οι υποθέσεις πάνω στο πώς φτάνει
το `streamPath` μέχρι το filesystem.

Τι είναι καθαρό (επαληθεύτηκε, όχι απ΄ άποψη):

- **SQL injection**: όλα τα queries στο sqlite μέσω prepared statements με bound parameters
  (`stats.js`), το API χρησιμοποιεί αποκλειστικά Prisma.
- **OS command injection**: ο ffmpegspawn είναι με πίνακα ορισμάτων, χωρίς shell (`app.js:76`).
- **IDOR / broken access control**: το `/me/*` παίρνει scope από το `clientId` του token,
  ποτέ από παράμετρο του caller· το sync προστατεύεται από per-server token με `timingSafeEqual`.
- **CSRF**: δεν εφαρμόζεται — το auth είναι Bearer header, όχι cookie.
- **Path traversal στο HLS**: κλείνει upstream από το `SAFE_NAME_PATTERN` του RTMP layer
  (βλ. #10 για το υπόλοιπο ρίσκο).
- **CVEs στον άμεσο κορμό**: `node-media-server@4.2.8`, `jsonwebtoken@9.0.3`, `express@4.22.2`,
  `aws4fetch@1.0.20` — κανένα γνωμένο advisory (Snyk, Αύγουστος 2026). Τα hits του `npm audit`
  είναι μεταβατικά (βλ. #5).

Σειρά προσθετικής αξίας: **#1** (δύο γραμμές, Total bypass), **#2** (αυτό που θα σε page-άρει
στην παραγωγή), μετά τα Medium.

---

## High

### 1. Hardcoded JWT secret fallback — πλήρης παράκαμψη auth

- [x] **Έγινε** (2026-08-27): `src/auth/secret.ts` — τυχαίο ≥32 χαρακτήρων ή η διεργασία δεν ξεκινάει· `HS256` καρφωμένο σε sign και verify· `.env.example` με κενή τιμή.
- **Αρχείο**: `apps/api/src/auth/auth.module.ts:15`
- **Πρόβλημα**: Το JWT signing secret πέφτει σε hardcoded string όταν λείπει το `JWT_SECRET`.
  Το compose το επιβάλλει (`${JWT_SECRET:?...}`), αλλά ο μη-Docker δρόμος όχι: το `start:dev`
  δεν φορτώνει καθόλου `.env`, και το `start` φορτώνει `.env` χωρίς να απαιτεί τη μεταβλητή.
- **Επίπτωση**: Όποιος έχει το public source φτιάχνει admin JWT (`{ sub: 1, role: "admin",
  clientId: null }`) και παίρνει πλήρη έλεγχο — πελάτες, stream keys, restart servers, kill
  sessions. Αποτυχία σιωπηλή: ο server τρέχει κανονικά με το αδύναμο secret.
- **Evidence**:
  ```ts
  JwtModule.register({
    secret: process.env.JWT_SECRET ?? 'dev-only-secret-ΑΛΛΑΞΕ-ΤΟ',
    signOptions: { expiresIn: '12h' },
  })
  ```
- **Fix**: Fail fast αντί για fallback — κρασάρει η διεργασία, δεν υποβαθμίζεται:
  ```ts
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set (≥32 chars) — refusing to start');
  }
  JwtModule.register({ secret, signOptions: { expiresIn: '12h', algorithm: 'HS256' } });
  ```
  Και pin `algorithms: ['HS256']` στο `verifyAsync` του `jwt-auth.guard.ts:29` ως
  defense-in-depth.
- **CWE**: CWE-798, CWE-1188

### 2. Viewer-count poisoning — κόβει πληρωμένους θεατές + memory exhaustion

- [ ] Fix
- **Αρχεία**: `apps/stream/stats.js:152-195` (`trackHls`), `stats.js:118-122` (`overLimit`),
  `stats.js:244` (`postPlay`)
- **Πρόβλημα**: Οι HLS θεατές μετρώνται ανά μοναδικό cookie `nmsv` (το στέλνει ο επιτιθέμενος)
  ή `IP + User-Agent` (και τα δύο πλαστογραφήσιμα — το `x-forwarded-for` εμπιστεύεται ασυζητητί
  στο `stats.js:160`). Το `seen` map δεν έχει όριο μεγέθους και τα playlist URLs είναι δημόσια.
  Επιπλέον, οι εγγραφές του `hlsSeen` για paths **χωρίς** publisher δεν καθαρίζονται ποτέ (το
  cleanup τρέχει μόνο μέσα στο `hlsViewersOf`, που καλείται μόνο για ζωντανα streams) — άρα
  requests σε τυχαία ανύπαρκτα `.m3u8` paths μεγαλώνουν το map αόριστα.
- **Επίπτωση**: Δύο unauthenticated DoS διόδοι:
  1. Ο επιτιθέμενος ζητά το playlist του θύματος με N rotating cookies → το stream «δείχνει»
     N θεατές → `overLimit()` → οι νέοι νόμιμοι θεατές παίρνουν 404 rewrite
     (`req.url = "/__full.m3u8"`) και τα νέα RTMP/FLV players αποσυνδέονται βίαια. Ρίχνει
     πελάτη από το δικό του stream όσο έχει όριο πακέτου, και αλλοιώνει το μετρικό που
     χρεώνεται ανά θεατή.
  2. Memory exhaustion: κάθε μοναδικό ζεύγος path/cookie αφήνει μόνιμη εγγραφή (~100 bytes)·
     συνεχόμενα requests γεμίζουν το heap μέχρι να πεθάνει η διεργασία.
- **Evidence**:
  ```js
  const token = req.headers.cookie?.match(/(?:^|;\s*)nmsv=([^;]+)/)?.[1];
  ...
  if (!seen.has(token ?? key) && !seen.has(key) && overLimit(stream)) {
    req.url = "/__full.m3u8";   // νέος θεατής silently 404
    return;
  }
  if (token) { seen.delete(key); seen.set(token, Date.now()); return; }
  ```
- **Fix**: Όριο στο map και μηδενική εμπιστοσύνη σε client-supplied ταυτότητα για enforcement:
  ```js
  const MAX_SEEN = 200; // ανά stream, άνετα πάνω από κάθε πραγματικό όριο
  if (seen.size >= MAX_SEEN) return;           // σταματά να μετρά, δεν μεγαλώνει
  ```
  Πραγματική IP από το socket (ή την τελευταία XFF hop που έβαλε ο δικός μας Caddy) αντί για
  την πρώτη, και περιοδικό σκούπισμα του `hlsSeen` για paths χωρίς publisher:
  ```js
  setInterval(() => {
    for (const stream of hlsSeen.keys()) if (!publishers.has(stream)) hlsSeen.delete(stream);
  }, HLS_TTL_MS);
  ```
  Μακροπρόθεσμα: τα όρια πακέτου να επιβάλλονται σε σήμα που δεν πλαστογραφείται δωρεάν
  (π.χ. signed playback tokens) — το cookie counting είναι εκ φύσεως παιχνιδιάρικο.
- **CWE**: CWE-770, CWE-348

---

## Medium

### 3. Publish auth ανοίγει όταν το clients.json λείπει ή έχει χαλάσει

- [ ] Fix
- **Αρχείο**: `apps/stream/config.js:93-100` (`publishAllowed`)
- **Πρόβλημα**: Αν το `clients.json` είναι μη αναγνώσιμο ή άκυρο JSON, `cache.ok = false` και
  **κάθε** publish γίνεται δεκτό. Είναι τεκμηριωμένο fallback διαθεσιμότητας, αλλά σημαίνει:
  δίσκος που γέμισε και truncate το αρχείο, χαλασμένο panel sync, ή φρέσκια εγκατάσταση χωρίς
  `generate-passwords` = ανοιχτός relay στην 1935.
- **Επίπτωση**: Όποιος φτάνει το RTMP port εκπέμπει σε οποιοδήποτε `[a-zA-Z0-9_-]+` path,
  σηκώνει ffmpeg jobs, ανεβάζει segments στο R2 bucket, σερβίρει περιεχόμενο από το domain σου.
- **Evidence**:
  ```js
  export function publishAllowed(streamPath, key) {
    loadClients();
    if (!cache.ok) return true;   // χαλασμένο/χαμένο αρχείο = δεκτός ο καθένας
  ```
- **Fix**: Fail closed για *χαλασμένο* (υπάρχον αλλά μη αναγνώσιμο) αρχείο· fail open μόνο για
  *αρρύθμιστο* server, δυνατά:
  ```js
  let firstBoot = !fs.existsSync(CLIENTS);   // μία φορά στο startup
  ...
  if (!cache.ok) {
    if (firstBoot) return true;              // γνήσια αρρύθμιστο
    console.error(`clients.json unreadable — refusing new publishes`);
    return false;
  }
  ```
- **CWE**: CWE-636 (Not Failing Securely)

### 4. Καμία rate limiting στο login + το scrypt το κάνει CPU-DoS amplifier

- [x] **Έγινε για το API** (2026-08-27): `src/auth/throttle.ts` (10 αποτυχίες ανά IP+username → 429/15'), ασύγχρονο `scrypt` στο `password.ts`, `trust proxy` στο `main.ts`. **Ανοιχτό**: το admin HTTP του `apps/stream/stats.js` (rate limit στον Caddy ή delay στο `authorized()`).
- **Αρχεία**: `apps/api/src/auth/auth.controller.ts:9-17`,
  `apps/api/src/auth/password.ts:13-21`, εξίσου `apps/stream/stats.js:401-413`
  (admin Basic auth, δημόσια εκτεθειμένο μέσω `apps/api/Caddyfile` → `handle /admin*`)
- **Πρόβλημα**: Ούτε το login του panel ούτε το admin API του stream server έχουν throttling,
  lockout ή delay. Κάθε προσπάθεια login τρέχει `scryptSync` (N=16384, 64-byte key ≈ 50-100ms
  CPU) συγχρόνως στο event loop.
- **Επίπτωση**: Online brute force σε χρήστες του panel και στον admin· φθηνό unauthenticated
  CPU exhaustion — ~10 συνεχόμενα requests/s κλειδώνουν έναν πυρήνα και ανεβάζουν latency
  παντού.
- **Evidence**: Κανένα `@nestjs/throttler` στο `apps/api/package.json`, καθόλου middleware στο
  `main.ts`, σκέτο `http.createServer` στο `stats.js` χωρίς όρια.
- **Fix**: `@nestjs/throttler` με αυστηρή πολιτική στο `/auth/login` (π.χ. 5 προσπάθειες/
  λεπτό/IP) και μετατροπή του `verifyPassword` σε ασύγχρονο `scrypt` (promisified) ώστε να μην
  μπλοκάρει το event loop. Στο admin port του stream server: per-IP failure delays στο
  `authorized()` ή rate limit στο Caddy πάνω στο `/admin*`.
- **CWE**: CWE-307

### 5. Critical `tar@6.2.1` στο runtime image μέσω `@hosterai/passwords` → `bcrypt` → `node-pre-gyp`

- [x] **Έγινε** (2026-08-27): έφυγε το `@hosterai/passwords`, τα δύο strings βγαίνουν με `crypto.randomBytes` στο `passwords.js`. `npm audit`: 0 ευρήματα.
- **Αρχεία**: dependency chain `apps/stream/package.json` → `@hosterai/passwords@1.1.0` →
  `bcrypt@5.1.1` → `@mapbox/node-pre-gyp@1.0.11` → `tar@6.2.1`· επίσης `esbuild 0.27.3`
  (low) μέσω `fontless`
- **Πρόβλημα**: `npm audit`: 1 critical / 1 high / 1 low. Τα σφάλματα του `tar` (path traversal
  στην εξαγωγή, DoS) εκτελούνται κατά το `npm ci` στο Docker build — ένας παραβιασμένος registry
  mirror θα μπορούσε να γράψει εκτός φακέλου εξαγωγής. Το `@hosterai/passwords` είναι ένα obscure
  single-purpose πακέτο (ο generator του είναι εντάξει — `crypto.randomBytes` με rejection
  sampling, το διάβασα) που τραβιέται **μόνο** για να φτιάξει δύο τυχαία strings που το
  `node:crypto` παράγει ήδη στο ίδιο αρχείο.
- **Επίπτωση**: Supply-chain έκθεση σε κάθε `docker build`, και μια περιττή native εξάρτηση
  (`bcrypt`) που υπαγορεύει το glibc base image.
- **Evidence**: `apps/stream/passwords.js:42-50` χρησιμοποιεί `Password` για `adminPassword` και
  `streamSecret` — ενώ στη συνέχεια το `passwords.js:70` χρησιμοποιεί σκέτο
  `crypto.randomBytes(18).toString("base64url")` για το μόνο secret που μετράει.
- **Fix**: Αφαίρεση του `@hosterai/passwords` και γέννηση με node:crypto:
  ```js
  const adminPassword = crypto.randomBytes(9).toString("base64url"); // 12 chars, ~64 bits
  ```
  Φεύγουν μαζί `bcrypt`, `node-pre-gyp`, `tar` και ο glibc constraint του Dockerfile. Μετά
  `npm audit fix` για το esbuild advisory.
- **CWE**: CWE-1104

### 6. Admin credentials του stream server: αδύναμος generator, plaintext στο rest, γνωστό default στο example config

- [x] **Εν μέρει** (2026-08-27): ο generator είναι πια `crypto.randomBytes` (16/24 χαρακτήρες) και το `GET /servers` δεν επιστρέφει `token`/`adminPass` — φεύγουν μόνο στην απάντηση του `POST`. **Ανοιχτό**: plaintext στη sqlite, `MySuperPassword` στο `config.example.json`.
- **Αρχεία**: `apps/stream/stats.js:388-394`, `apps/stream/passwords.js:44`,
  `apps/stream/config.example.json:33`, `apps/api/prisma/schema.prisma:19` (`adminPass String`)
- **Πρόβλημα**: Ο κωδικός admin API είναι 10 chars από pool ~54 συμβόλων (≈57 bits) για
  endpoint εκτεθειμένο στο internet χωρίς rate limiting (βλ. #4). Το `config.example.json`
  έχει `MySuperPassword` — το install τον αντικαθιστά, αλλά μια χειροκίνητη εγκατάσταση που
  παραλείπει το `generate-passwords` τρέχει με δημόσια γνωστό credential. Το API επιπλέον
  κρατά `adminUser`/`adminPass` και sync tokens σε plaintext sqlite, και το `GET /servers`
  τα επιστρέφει.
- **Επίπτωση**: Κατάληψη της βάσης του panel (ή leak backup του config.json) = admin πρόσβαση
  σε όλους τους stream servers. Deployments με default password απαλλάσσονται.
- **Evidence**: `config.example.json`: `"password": "MySuperPassword"`· `schema.prisma`:
  `adminPass String` (χωρίς κρυπτογράφηση).
- **Fix**: Generator σε `crypto.randomBytes(12)` (~19 chars)· fail closed στο boot αν
  `config.auth.jwt.users[0].password === 'MySuperPassword'` εκτός dev· τα secrets εκτός
  responses (`GET /servers` χωρίς `adminPass`/`token` — καλύτερα dedicated
  `POST /servers/:id/rotate` παρά read-back).
- **CWE**: CWE-798, CWE-312

---

## Low

### 7. Username enumeration μέσω timing στο login

- [x] **Έγινε** (2026-08-27): σύγκριση με dummy hash όταν λείπει ο χρήστης (`auth.service.ts#dummyHash`) — πάντα ένα scrypt.
- **Αρχείο**: `apps/api/src/auth/auth.service.ts:18` — το `!user ||` short-circuit.skipάρει
  το scrypt για άγνωστο username, άρα ο χρόνος απόκρισης ξεχωρίζει «υπάρχει ο χρήστης» από
  «δεν υπάρχει» (το ενιαίο μήνυμα λάθους καλύπτει το περιεχόμενο, όχι το timing).
- **Fix**: Σύγκριση με dummy hash όταν λείπει ο χρήστης. **CWE-204**.

### 8. JWT στο localStorage· κανένα CSP/security headers στο panel

- [ ] Fix
- **Αρχεία**: `apps/panel/app/composables/useApi.ts:4`, σερβίρεται από `apps/api/Caddyfile`
  χωρίς `Content-Security-Policy`/`X-Frame-Options`. Μελλοντικό XSS στο SPA κλέβει token 12
  ωρών. Τεκμηριωμένο tradeoff για στατικό SPA — και οι σημερινοί DOM sinks είναι καθαροί
  (`dash.ts` κάνει interpolate μόνο RTMP-validated `[a-zA-Z0-9_-]` ονόματα streams στο
  `innerHTML`).
- **Fix**: CSP header στο Caddy (`default-src 'self'` + media/img hosts) και ενδεχόμενα
  μικρότερο token lifetime. **CWE-522/CWE-693**.

### 9. Install script: `curl | sh` και port 8000 ανοιχτό δημόσια

- [ ] Fix
- **Αρχείο**: `apps/stream/install` — get.docker.com/get.volta.sh pipeαρισμένα σε shell·
  `ufw allow 8000` στον μη-Docker δρόμο. Το ανοιχτό 8000 επιτρέπει στους clients να
  παρακάμψουν τελείως τον Caddy — unrested playback, χωρίς managed cache headers, και
  απευθείας πρόσβαση που κάνει την εμπιστοσύνη XFF του #2 πιο εκμεταλλεύσιμη.
- **Fix**: Αφαίρεση του `ufw allow 8000` (ο Caddy κάνει proxy σε loopback, δεν το χρειάζεται)·
  pin/checksum στα installer scripts αν μείνουν. **CWE-829**.

### 10. Latent path-traversal footgun στο regex των client paths

- [x] **Εν μέρει** (2026-08-27): το regex του API δεν δέχεται πια κομμάτια που αρχίζουν από τελεία. **Ανοιχτό**: το sanity check στο `streamPath` πριν το `rmSync` του `app.js` — το invariant εξακολουθεί να κρέμεται από τον έλεγχο του RTMP layer.
- **Αρχείο**: `apps/api/src/clients/clients.controller.ts:52` — το
  `/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/` δέχεται και `.`/`..` segments (π.χ. `/../x`).
  Σήμερα δεν εκμεταλλεύσιμο ως traversal: το RTMP layer απορρίπτει τελείες
  (`rtmp_session.js:16`) και ο stream server χτίζει paths μόνο από `session.streamPath`. Αλλά
  το `app.js:166` κάνει `fs.rmSync(`${config.static.root}${session.streamPath}`,
  { recursive: true, force: true })` χωρίς δικό του validation — η ασφάλεια κρέμεται
  αποκλειστικά από έναν έλεγχο μέσα σε dependency.
- **Fix**: Απόρριψη `.`/`..` segments στο API regex (`(?!\.\.?$)` ανά segment) **και**
  ένα γρήγορο sanity check στο `streamPath` του `app.js` πριν το `rmSync`, ώστε το invariant
  να μην ζει σε εξάρτηση. **CWE-22**.

### 11. Μικροευρήματα

- [ ] Fix
  - `stats.js:409`: το 500 επιστρέφει σκέτο `err.message` (πρόσβαση σε εσωτερικά του stack) —
    τύλιξε γενικά. **CWE-209**.
  - Tokens διαγραμμένων clients μένουν έγκυρα έως 12h χωρίς revocation — τα `/me/*`
    υποβαθμίζονται κοσμίως σε κενές λίστες, αλλά η ταυτότητα στο `/auth` επιμένει. Αποδεκτό
    σε αυτή την κλίμακα· σημείωση για το μέλλον.
  - IPs συνεδριών κρατούνται 30 μέρες στο `stats.db` και εμφανίζονται στο
    `/admin/api/sessions` — σκεψου retention/GDPR θέμα για EU πελάτες.
  - `passwords.js:79-89`: τυπώνει admin password και stream key στο stdout — καταλήγει στα
    logs του pm2/journald/docker. Στο docker-compose το rotation το οριοθετεί, σε bare metal
    το credential ζει στα logs επ΄ αόριστον.

---

## Πηγές

- [Snyk Security Database — node-media-server](https://security.snyk.io/package/npm/node-media-server)
- Τοπικό `npm audit --workspaces` επί του `package-lock.json` (2026-08-16)

---

## Δεύτερος έλεγχος — 2026-08-27

Επανέλεγχος του `apps/api` μετά τις αλλαγές του καλοκαιριού (πλάνα, συνδρομές,
API keys, αναδιανομή). Τι έκλεισε:

| # | Εύρημα | Πού |
|---|---|---|
| 1 | `JWT_SECRET` fail-open (fallback + τιμή που «δουλεύει» στο `.env.example`) | `auth/secret.ts`, `auth.module.ts`, `.env.example` |
| 2 | Τα `/servers` επέστρεφαν `token`/`adminPass` σε κάθε `GET` | `servers.service.ts#noSecrets` |
| 3 | Κάθε API key = πλήρης admin | `auth/human-only.ts` — κλειδιά και restart/kill session μόνο από άνθρωπο |
| 4 | Καμία rate limiting στο login, `scryptSync` στον event loop | `auth/throttle.ts`, `auth/password.ts` |
| 5 | Mass assignment (spread του σώματος στο Prisma) | `clients.service.ts`, `servers.service.ts#fields` |
| 6 | Username enumeration μέσω timing | `auth.service.ts#dummyHash` |
| 7 | Path regex δεχόταν `.`/`..` κομμάτια | `clients.controller.ts` |
| 8 | SSRF bypass με μη δεκαδικά IPv4 στους προορισμούς | `clients/destinations.ts#isPrivateHost` |
| 9 | Αναστολή αόρατη στο API (`/me` δεχόταν γραψίματα) | `me.controller.ts#writable` |
| 10 | Host header στο login-link | `PANEL_URL` από το compose |
| 11 | Καμία πολιτική κωδικού | `auth/password.ts#MIN_PASSWORD` (8) |
| 12 | Container ως root | `Dockerfile`: `USER node` |

Και το εκτός πεδίου: η αλυσίδα `@hosterai/passwords → bcrypt → tar` έφυγε από το
`apps/stream` (δες #5 παραπάνω) — `npm audit` καθαρό σε όλο το monorepo.

Τι **δεν** έκλεισε, συνειδητά:

- **Scopes στα API keys.** Ένα κλειδί εξακολουθεί να μπορεί ό,τι κι ένας admin
  στο provisioning — και το `login-link` είναι ακριβώς η δουλειά του billing,
  οπότε δεν κόβεται. Έκλεισαν οι δύο δρόμοι που καμία υπηρεσία δεν χρειάζεται.
- **Κρυπτογράφηση των secrets στη sqlite.** Το κλειδί θα ζούσε δίπλα στη βάση
  (ίδιο μηχάνημα, ίδιο backup) — προστατεύει μόνο από αντίγραφο *μόνο* της βάσης.
- **`POST /servers/:id/rotate-token`.** Το `PATCH /servers/:id {token}` κάνει ήδη
  το ίδιο με ένα endpoint λιγότερο.
- Τα υπόλοιπα ανοιχτά του πρώτου ελέγχου (#2, #3, #8, #9, #11 και τα μισά #4/#6/#10).
