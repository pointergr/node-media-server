# API του κεντρικού panel

Αναφορά για όποιον καλεί το API απ' έξω — π.χ. το site που πουλάει τα πλάνα και
πρέπει να φτιάξει πελάτη, συνδρομή και stream χωρίς άνθρωπο στη μέση.

Για το **γιατί** πίσω από τις αποφάσεις (γιατί η συνδρομή είναι η μονάδα των
πάντων, γιατί ο server παγώνει στην αγορά) δες το [README.md](README.md). Εδώ
είναι μόνο το συμβόλαιο.

## Βασικά

| | |
|---|---|
| Base URL | `https://<panel host>/api` (ο Caddy κόβει το `/api` και προωθεί στο Nest) |
| Μορφή | JSON σε αίτηση και απάντηση· `content-type: application/json` σε κάθε POST/PATCH |
| Έκδοση | καμία — το API αλλάζει μαζί με το repo, δεν υπάρχει `/v1` |
| Κωδικοποίηση | UTF-8· τα ονόματα πελατών είναι ελληνικά, τα `path` **μόνο** ASCII |

Δεν υπάρχουν webhooks. Ό,τι θέλει ζωντανή εικόνα το ρωτάει: `GET /live` για
όλους τους servers, `GET /me/streams` για τα streams ενός πελάτη. Τα δεδομένα
είναι το πολύ **10 δευτερόλεπτα** παλιά — τόσο είναι το tick του κάθε stream
server προς το panel.

## Αυθεντικοποίηση

Πάντα `Authorization: Bearer <token>`. Τρία είδη, ίδια κεφαλίδα:

| Είδος | Πώς βγαίνει | Λήξη | Για ποιον |
|---|---|---|---|
| **API key** (`pk_…`) | `apikey.js "<υπηρεσία>"` στον host | ποτέ (ανάκληση με `apikey.js revoke`) | εξωτερικές υπηρεσίες — **αυτό θέλεις** |
| **JWT** | `POST /auth/login` | 12 ώρες | άνθρωποι στο panel |
| **Server token** | `Server.token` | ποτέ | μόνο ο stream server, μόνο για το `POST /servers/:host/sync` |

Για να **στείλεις χρήστη** στο panel χωρίς κωδικούς υπάρχει τέταρτο, βραχύβιο
token που δεν το βάζεις σε κεφαλίδα αλλά σε URL: `POST /auth/login-link`, βήμα 6
παρακάτω.

Το API key έχει **δικαιώματα admin**: ό,τι λέει παρακάτω «admin» το δέχεται και
από key. Μοναδική εξαίρεση το `PATCH /auth/me` — ένα key δεν έχει λογαριασμό να
αλλάξει και παίρνει 401.

```bash
curl -H "authorization: Bearer pk_…" https://panel.example.com/api/plans
```

Χωρίς κεφαλίδα → `401 {"message":"λείπει το token"}`. Με άγνωστο key → `401
{"message":"άκυρο api key"}`.

## Σφάλματα

Μορφή του Nest, πάντα ίδια:

```json
{ "statusCode": 409, "message": "το path /live/kamera1 χρησιμοποιείται ήδη σε αυτόν τον server", "error": "Conflict" }
```

Το `message` είναι **ελληνικό κείμενο για άνθρωπο** — μη το κάνεις parse, κρίνε
από το status:

| Status | Σημαίνει | Τι κάνεις |
|---|---|---|
| `400` | λείπει ή είναι άκυρο πεδίο (`planId`, όρια < 1, κακοσχηματισμένο `path`) | διόρθωσε το σώμα |
| `401` | κακό ή απόν token/key | μην ξαναδοκιμάσεις με το ίδιο |
| `403` | ο ρόλος δεν επιτρέπεται (πελάτης σε admin endpoint) | — |
| `404` | το id δεν υπάρχει **ή ανήκει σε άλλον πελάτη** | δες παρακάτω |
| `409` | σύγκρουση: path/όνομα/username που υπάρχει, πλάνο γεμάτο, διαγραφή με εξαρτήσεις | άλλαξε δεδομένα ή σβήσε πρώτα |
| `502` | ο stream server δεν απάντησε στο proxy | retry |
| `5xx` | δικό μας σφάλμα | retry με backoff |

**Το 404 καλύπτει και το «ξένο»:** αν δώσεις `subscriptionId` ή `pathId` που
ανήκει σε άλλον πελάτη, η απάντηση είναι 404 και όχι 403 — το API δεν
επιβεβαιώνει ότι υπάρχει.

Retry έχει νόημα μόνο στα 502/5xx. Τα 4xx είναι δεδομένα, όχι τύχη.

## Το μοντέλο

```
Plan  (κατάλογος: τι πουλάμε, με τα όριά του και τον server των επόμενων αγορών)
  │
  └─ Subscription  (μία αγορά· δικός της server, τα όριά της από το πλάνο)
       │            ←── η μονάδα των πάντων
       └─ Path  (ένα stream: διαδρομή + κλειδί εκπομπής)

Client (πελάτης: όνομα + προαιρετικά χρήστης για το panel) ─ έχει 0..Χ Subscriptions
```

Τρία πράγματα που εκπλήσσουν αν τα μάθεις αργά:

1. **Τίποτα δεν αθροίζεται.** Δύο συνδρομές των 50 θεατών είναι δύο όρια των 50,
   όχι ένα των 100. Το όριο επιβάλλεται ανά συνδρομή, στα δικά της paths.
2. **Το path κρέμεται από τη συνδρομή**, όχι από τον πελάτη — από εκεί παίρνει
   και τον server και το όριο θεατών.
3. **Ο server παγώνει στην αγορά.** Το `Plan.serverId` λέει πού πέφτουν οι
   *επόμενες* συνδρομές· οι υπάρχουσες δεν μετακομίζουν ποτέ. Τα **όρια**
   αντίθετα διαβάζονται ζωντανά από το πλάνο.

## Ροή provisioning

```bash
API=https://panel.example.com/api
KEY=pk_…
auth=(-H "authorization: Bearer $KEY" -H 'content-type: application/json')
```

### 1. Διάλεξε πλάνο

```bash
curl "${auth[@]}" $API/plans
```

```json
[{ "id": 1, "name": "basic", "maxViewers": 50, "maxStreams": 1, "serverId": 1, "ladder": null,
   "server": { "id": 1, "host": "stream.example.com", "...": "" },
   "_count": { "subscriptions": 12 } }]
```

> ⚠️ Το `server` block περιέχει και τα διαπιστευτήρια διαχείρισης του stream
> server. Μην προωθείς την απάντηση αυτούσια σε browser ή σε log.

### 2. Φτιάξε τον πελάτη

```bash
curl -X POST "${auth[@]}" -d '{"name":"Πελάτης ΑΕ","username":"pelatis","password":"…"}' $API/clients
```

`201` → `{ "id": 7, "name": "Πελάτης ΑΕ", "disabled": false }`

Τα `username`/`password` είναι προαιρετικά και φτιάχνουν μαζί τον χρήστη που θα
μπαίνει στο panel· χωρίς αυτά ο πελάτης υπάρχει αλλά δεν συνδέεται πουθενά.
Ίδιο όνομα δεύτερη φορά → `409`.

### 3. Πούλα του το πλάνο

```bash
curl -X POST "${auth[@]}" -d '{"planId":1}' $API/clients/7/subscriptions
```

`201` → `{ "id": 3, "disabled": false, "clientId": 7, "planId": 1, "serverId": 1,
"plan": {…}, "server": { "id": 1, "host": "stream1.example.com" }, "paths": [] }`

Μία αγορά = μία κλήση. **Δεν υπάρχει ποσότητα**: δύο φορές το ίδιο πλάνο = δύο
κλήσεις = δύο συνδρομές με χωριστά όρια.

Αν πουλάς στον ίδιο πελάτη δεύτερη φορά το ίδιο πλάνο, δώσ' του και όνομα:

```bash
curl -X PATCH "${auth[@]}" -d '{"label":"Εκκλησία Αγ. Νικολάου"}' \
  $API/clients/7/subscriptions/3
```

Χωρίς αυτό, οι δύο συνδρομές είναι δύο φορές «basic» — και στη δική σου οθόνη και
στου πελάτη, που ομαδοποιεί τα streams του ανά συνδρομή. Ως 60 χαρακτήρες· κενό
ή `null` το σβήνει. Μπορεί να το αλλάξει και ο ίδιος ο πελάτης
(`PATCH /me/subscriptions/:id`).

### 4. Φτιάξε το stream

```bash
curl -X POST "${auth[@]}" -d '{"subscriptionId":3}' $API/clients/7/paths
```

`201` → `{ "id": 11, "path": "/live/c7-s3-1", "key": "N7bJ…", "subscriptionId": 3, "serverId": 1 }`

Χωρίς `path` το ονομάζει μόνο του (`/live/c<πελάτης>-s<συνδρομή>-<ν>`) — προτίμησέ
το: το path είναι μόνιμο, ενώ το όνομα του πελάτη αλλάζει και δεν είναι ASCII. Αν
το δώσεις εσύ, η μορφή είναι αυστηρά `/<app>/<stream>` με `[A-Za-z0-9_.-]`.

Γεμάτο πλάνο (`maxStreams`) → `409`. Path που υπάρχει ήδη σε **αυτόν** τον server
→ `409`.

### 5. Δώσε τα στοιχεία εκπομπής

Κανένα endpoint δεν επιστρέφει έτοιμο RTMP URL — συντίθεται από τον `host` της
συνδρομής και το `path`:

| | Τύπος | Παράδειγμα |
|---|---|---|
| Server (OBS) | `rtmp://rtmp.<host>/<app>` | `rtmp://rtmp.stream.example.com/live` |
| Stream Key | `<stream>?key=<key>` | `c7-s3-1?key=N7bJ…` |
| Προβολή (HLS) | `https://<host><path>/index.m3u8` | `https://stream.example.com/live/c7-s3-1/index.m3u8` |

όπου `<app>` και `<stream>` είναι τα δύο κομμάτια του `path`. Το ίδιο κάνει και
το panel (`apps/panel/app/pages/index.vue`).

Ο stream server μαθαίνει το νέο path στο επόμενο tick — η εκπομπή δουλεύει σε
**≤10 δευτερόλεπτα** από το βήμα 4, όχι ακαριαία.

### 6. Στείλε τον χρήστη στο panel του (χωρίς κωδικούς)

```bash
curl -X POST "${auth[@]}" -d '{"clientId":7}' $API/auth/login-link
```

`200` → `{ "url": "https://panel.example.com/login#t=eyJ…", "expiresIn": 300 }`

Κάνε **redirect** τον χρήστη εκεί: το panel ανταλλάσσει μόνο του το token με
κανονική 12ωρη συνεδρία και τον προσγειώνει στα streams του. Δεν χρειάζεται —
και δεν πρέπει — να ξέρεις τον κωδικό του.

Το link είναι **μιας χρήσης** και ζει **5 λεπτά**: φτιάξε ένα τη στιγμή που
πατάει το κουμπί, μην το αποθηκεύσεις και μην το στείλεις με email. Το token
είναι στο fragment (`#`), οπότε δεν καταγράφεται σε server log — μη το
μετακινήσεις σε query string. Ληγμένο ή ξαναχρησιμοποιημένο link → η σελίδα
δείχνει τη φόρμα σύνδεσης με μήνυμα λήξης.

`400` αν ο πελάτης δεν έχει χρήστη σύνδεσης (δεν έδωσες `username`/`password`
στο βήμα 2) — φτιάξ' τον με `PATCH /clients/7`.

## Reference

Όπου γράφει «admin», περνάει και API key.

### Πελάτες

| Endpoint | Σώμα | Απάντηση / σφάλματα |
|---|---|---|
| `GET /clients` | — | όλοι οι πελάτες με `subscriptions[]` (μαζί `plan`, `server`, `paths`) και `users: [{id, username}]` — ποτέ hash κωδικού |
| `POST /clients` | `{name, username?, password?}` | `201` ο πελάτης· `400` χωρίς `name`, `409` διπλό `name`/`username` |
| `GET /clients/:id` | — | ο πελάτης· `404` |
| `PATCH /clients/:id` | `{name?, disabled?, username?, password?}` | ό,τι δεν σταλεί μένει· `disabled: true` κόβει **όλες** τις συνδρομές του σε ≤10s· μόνο `password` σε πελάτη χωρίς χρήστη → `400`· διπλό username → `409` |
| `DELETE /clients/:id` | — | σβήνει συνδρομές και paths (cascade) — τα κλειδιά εκπομπής χάνονται |

### Συνδρομές

| Endpoint | Σώμα | Απάντηση / σφάλματα |
|---|---|---|
| `POST /clients/:id/subscriptions` | `{planId}` | `201` η συνδρομή με `plan`, `server` (μόνο `{id, host}` — τα μυστικά του server μόνο στο `/servers`) και `paths`· `400` άγνωστο πλάνο, `404` άγνωστος πελάτης |
| `PATCH /clients/:id/subscriptions/:subId` | `{disabled}` ή/και `{label}` | **αναστολή/επαναφορά μιας μόνο συνδρομής**· η εκπομπή πέφτει σε ≤10s, paths και κλειδιά μένουν ανέπαφα. Το `label` είναι το φιλικό όνομα της αγοράς (≤60 χαρακτήρες, κενό/`null` το σβήνει)· `400` σε λάθος τύπο ή άδειο σώμα, `404` αν είναι άλλου πελάτη |
| `DELETE /clients/:id/subscriptions/:subId` | — | `409` όσο κρατάει streams (σβήσ' τα πρώτα, για να μη χαθούν σιωπηλά κλειδιά) |

Για «έληξε η συνδρομή» χρησιμοποίησε `disabled`, όχι `DELETE`: η επαναφορά είναι
τότε ένα PATCH και ο πελάτης βρίσκει τα ίδια κλειδιά.

### Streams (paths)

| Endpoint | Σώμα | Απάντηση / σφάλματα |
|---|---|---|
| `POST /clients/:id/paths` | `{subscriptionId, path?}` | `201` το path με το `key`· `409` γεμάτο πλάνο ή path σε χρήση· `400` κακή μορφή path· `404` ξένη συνδρομή |
| `POST /clients/:id/paths/:pathId/key` | — | **νέο κλειδί στο ίδιο path** (για εκτεθειμένο κλειδί): διεύθυνση προβολής και ό,τι έχει ενσωματωθεί μένουν, ο publisher με το παλιό κόβεται σε ≤10s |
| `DELETE /clients/:id/paths/:pathId` | — | `404` αν είναι άλλου πελάτη |

### Πλάνα

| Endpoint | Σώμα | Απάντηση / σφάλματα |
|---|---|---|
| `GET /plans` | — | ο κατάλογος με `server` και `_count.subscriptions`, ταξινομημένος κατά `maxViewers` |
| `POST /plans` | `{name, maxViewers, maxStreams, serverId, ladder?}` | τα δύο όρια ακέραιοι **≥1** (`400`), άγνωστος server → `400`. Το `ladder` (επιπλέον αναλύσεις, ABR) είναι csv από ύψη σε φθίνουσα σειρά, χωρίς διπλά, από τα `1080,720,480,360,240` — αλλιώς `400`· κενό = `null` |
| `PATCH /plans/:id` | ίδια πεδία, όλα προαιρετικά | αλλαγή ορίων ισχύει **και για τις υπάρχουσες** συνδρομές· αλλαγή `serverId` μόνο για τις επόμενες |
| `DELETE /plans/:id` | — | `409` αν το έχουν συνδρομές |

### Ζωντανή εικόνα και ιστορικό

| Endpoint | Τι δίνει |
|---|---|
| `GET /live` | το τελευταίο snapshot **κάθε** server: `[{host, ts, online, snapshot}]`. `online: false` αν το τελευταίο tick είναι >30s παλιό. Ζει στη μνήμη — μετά από restart του API είναι άδειο για ≤10s |
| `GET /servers/:host/series?range=1h\|24h\|7d\|30d` | ιστορικό θεατών/bitrate, proxy στο sqlite του stream server |
| `GET /servers/:host/sessions` | ιστορικό συνδέσεων του server |
| `DELETE /servers/:host/sessions/:id` | κόβει μία σύνδεση |
| `POST /servers/:host/restart` | restart του stream server (απαντάει `202`, τον ξανασηκώνει ο supervisor του) |

Τα series/sessions είναι **ανά server**, γιατί εκεί ζουν — το panel δεν τα
αντιγράφει κεντρικά. Ο σωστός `host` για έναν πελάτη είναι ο
`subscription.server.host`.

### Πελατικά endpoints (JWT πελάτη)

Δουλεύουν με το token του **πελάτη**, όχι με API key (το key δεν έχει `clientId`,
οπότε παίρνει άδεια λίστα):

| Endpoint | Τι δίνει |
|---|---|
| `GET /me/streams` | τα streams του πελάτη με `host`, `path`, `key`, `streamKey`, `plan`, `subscriptionId`, `subscriptionLabel`, `suspended`, `limit`, `viewers`, `since` (`null` = δεν εκπέμπει), `in_bps`, `out_bps`, `r2Estimate` |
| `POST /me/streams/:id/key` | νέο κλειδί, από τον ίδιο τον πελάτη |
| `PATCH /me/subscriptions/:id` | `{label}` — ο πελάτης ονομάζει τα πακέτα του· μόνο το `label` (η αναστολή μένει στον admin) |
| `GET /me/series?range=` | ιστορικό μόνο των δικών του paths, χωρίς CPU/μνήμη του μηχανήματος |

### Χρήστες και σύνδεση

| Endpoint | Σώμα | Σημείωση |
|---|---|---|
| `POST /auth/login` | `{username, password}` | `200 {access_token}` (12ωρο)· `401` σε λάθος στοιχεία — ίδιο μήνυμα για άγνωστο χρήστη και για λάθος κωδικό |
| `POST /auth/login-link` | `{clientId}` | `200 {url, expiresIn}` — link **μιας χρήσης**, 5 λεπτά, για τον χρήστη του πελάτη (δες βήμα 6)· `400` αν ο πελάτης δεν έχει χρήστη |
| `POST /auth/exchange` | `{token}` | το καλεί **το panel**, όχι εσύ: ανταλλάσσει το token του link με 12ωρη συνεδρία· `401` σε ληγμένο, ξοδεμένο ή σκέτο token συνεδρίας |
| `GET /auth/me` | — | `{username, role, clientId}` του token — το χρησιμοποιεί το panel· με API key `401` |
| `PATCH /auth/me` | `{currentPassword, username?, password?}` | αλλάζει **τα δικά του** στοιχεία (το id βγαίνει από το token)· `401` λάθος τρέχων κωδικός, `409` username σε χρήση |

Δεν υπάρχει users endpoint: ο χρήστης ενός πελάτη φτιάχνεται και αλλάζει από τα
`POST /clients` και `PATCH /clients/:id`.

### Εσωτερικά

`POST /servers/:host/sync` — το καλεί **μόνο** ο stream server, με το δικό του
`Server.token`, κάθε 10s. Στέλνει snapshot, παίρνει πίσω το `clients.json` του.
Μην το καλείς: η απάντηση περιέχει τα κλειδιά εκπομπής όλων των πελατών αυτού
του μηχανήματος.

Τα `GET/POST /servers`, `GET/PATCH/DELETE /servers/:id` διαχειρίζονται τα ίδια
τα μηχανήματα (admin) — δεν αφορούν provisioning πελατών, και οι απαντήσεις τους
περιέχουν διαπιστευτήρια.

## Χρόνοι

| Ενέργεια | Πότε ισχύει στην πράξη |
|---|---|
| νέο path / νέο κλειδί | ≤10s (επόμενο tick του stream server) |
| αναστολή συνδρομής ή πελάτη | ≤10s — η τρέχουσα εκπομπή κόβεται |
| αλλαγή ορίου στο πλάνο | ≤10s, σε όλες τις συνδρομές του |
| θεατές / bitrate στο `GET /live` | δείγμα ανά 10s |
| μετακόμιση συνδρομής σε άλλο server | **ποτέ** αυτόματα — ο server παγώνει στην αγορά |
