# Security review — Admin API & επιφάνειας του server

**Ημερομηνία:** 2026-08-16
**Σκοπός:** `stats.js` (admin HTTP server, port 8001), `app.js`, `config.js`, `r2.js`, `passwords.js`, `admin/*.html`, `Caddyfile`, `docker-compose.yml`, plus το upstream `node-media-server@4.2.8` όπου αφορά.

Κατάταξη σοβαρότητας: **ΜΕΣΑΙΑ** = εκμεταλλεύσιμο με προϋποθέσεις, **ΧΑΜΗΛΗ** = άμυνα σε βάθος / hardening.

| # | Σοβαρότητα | Θέμα | Τοποθεσία |
|---|---|---|---|
| 1 | ΜΕΣΑΙΑ | CSRF στο `POST /admin/api/restart` και `DELETE /admin/api/sessions/:id` | `stats.js:329` |
| 2 | ΜΕΣΑΙΑ | Unauthenticated memory exhaustion μέσω `trackHls` | `stats.js:146-176` |
| 3 | ΜΕΣΑΙΑ | Το `auth.secret` δεν ελέγχεται ποτέ — silent bypass του publish auth | `app.js:35`, `config.example.json:30` |
| 4 | ΜΕΣΑΙΑ | hls.js από CDN χωρίς SRI σε authenticated σελίδες | `admin/index.html:177`, `admin/player.html:122` |
| 5 | ΧΑΜΗΛΗ | Κανένα rate limit στο basic auth | `stats.js:369` |
| 6 | ΧΑΜΗΛΗ | Διαρροή εσωτερικών σφαλμάτων στο 500 | `stats.js:377` |
| 7 | ΧΑΜΗΛΗ | Cookie `nmsv` χωρίς `Secure` | `stats.js:174` |
| 8 | ΧΑΜΗΛΗ | Χωρίς CSP / `X-Frame-Options` / HSTS | `stats.js:342-344`, `Caddyfile` |
| 9 | ΧΑΜΗΛΗ | Plaintext secrets με default permissions (0644) | `config.js:25-41` |
| 10 | ΧΑΜΗΛΗ | Stream key χωρίς ουσιαστική λήξη (50 χρόνια) | `passwords.js:49` |
| 11 | ΧΑΜΗΛΗ | `rmSync` σε path που ελέγχεται μόνο από το upstream | `app.js:149-150` |
| 12 | ΧΑΜΗΛΗ | `x-forwarded-for` παίρνει την πρώτη (spoofable) τιμή | `stats.js:154` |

---

## 1. CSRF στα state-changing endpoints — ΜΕΣΑΙΑ

**Τοποθεσία:** `stats.js:329` (`POST /admin/api/restart`), `stats.js:323` (`DELETE /admin/api/sessions/:id`)

**Πρόβλημα:** Τα δύο state-changing endpoints βασίζονται μόνο σε basic auth. Ο browser στέλνει αυτόματα τα cached basic-auth credentials και σε **cross-site** requests (form POST, `fetch` με `credentials: 'include'` — όχι, το fetch χωρίς credentials δεν τα στέλνει, αλλά ένα κρυφό `<form method="POST" action="https://host/admin/api/restart">` με auto-submit ναι). Ένας admin που έχει συνδεθεί και επισκέπτεται κακόβουλη σελίδα μπορεί να προκαλέσει:

- Restart του server → κομμένη η ενεργή εκπομπή (DoS) — το κουμπί του UI μάλιστα ρωτάει επιβεβαίωση, το CSRF την παρακάμπτει.
- Kill οποιουδήποτε session μέσω DELETE (το session id πρέπει όμως να μαντευτεί, οπότε λιγότερο πρακτικό).

Το cookie `nmsv` έχει `SameSite=Lax` αλλά αυτό αφορά το δικό μας cookie — το basic auth δεν καλύπτεται από SameSite.

**Διόρθωση:** Έλεγχος `Sec-Fetch-Site` (και fallback στο `Origin`/`Referer` για παλιούς browsers) μόνο για POST/DELETE, πριν από το routing:

```js
// Μέσα στο route() ή πριν από αυτό — μόνο για state-changing μεθόδους
if (req.method === "POST" || req.method === "DELETE") {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return json(res, 403, { error: "cross-site request" });
  }
  // Fallback για browsers χωρίς Sec-Fetch-Site: Origin πρέπει να λείκει ή να ταιριάζει
  const origin = req.headers.origin ?? req.headers.referer;
  if (origin && !origin.startsWith(`https://${expectedHost}`)) {
    return json(res, 403, { error: "cross-origin request" });
  }
}
```

Το `Sec-Fetch-Site: none` επιτρέπεται σκόπιμα (curl/έγγραφα αιτήματα από bookmarks). Πρόσεξε ότι πίσω από Caddy το Host header είναι το domain, όχι `localhost:8001`.

**Κόστη/κίνδυνοι:** Μικρά. Το admin UI κάνει same-origin fetches, δεν σπάει τίποτα.

---

## 2. Unauthenticated memory exhaustion μέσω `trackHls` — ΜΕΣΑΙΑ

**Τοποθεσία:** `stats.js:146-176` (`trackHls`), τρέχει ως `prependListener("request")` στον **δημόσιο** HTTP server του nms (port 8000), χωρίς auth.

**Πρόβλημα:** Δύο unbounded Maps τροφοδοτούνται από οποιονδήποτε επισκέπτη:

1. `hlsSeen` (`stats.js:156-157`): κάθε request σε path που τελειώνει σε `.m3u8` με δικό του `Cookie: nmsv=<οτιδήποτε>` προσθέτει entry στο inner Map. Entry διαγράφεται μόνο από το `hlsViewersOf()` (`stats.js:110`) — που καλείται **μόνο για paths που έχουν ενεργό publisher**. Για οποιοδήποτε άλλο path τα entries δεν καθαρίζονται ποτέ.
2. `accBytes` μέσω `addOut` (`stats.js:99-102`, καλείται στο `finish` event του response): κάθε **μοναδικό** path (`/foo/bar.m3u8`, `/foo2/bar.m3u8`, …) δημιουργεί μόνιμο entry.

Attack: `while true; curl -H 'Cookie: nmsv=$RANDOM' https://host/junk$i/x.m3u8; done` — ανά request λίγα bytes, αλλά grows μονότονα μέχρι OOM. Δεν χρειάζεται authentication.

**Διόρθωση (δύο στρώσεις):**

```js
function trackHls(req, res) {
  const p = req.url.split("?")[0];
  if (!p.endsWith(".m3u8") && !p.endsWith(".ts")) return;
  const stream = p.slice(0, p.lastIndexOf("/"));
  // Άμυνα 1: κανένα path χωρίς ενεργό publisher δεν χρειάζεται μέτρηση
  if (!publishers.has(stream)) return;
  // ...
  // Άμυνα 2 (belt & suspenders στο token branch):
  if (seen.size > 10_000) return; // ή delete το παλαιότερο entry
}
```

Το `accBytes` προστατεύεται αυτόματα από το guard #1 για καινούργια paths· τα orphaned entries παλιών streams μένουν — προαιρετικά καθαρισμός στο `finish()` του publisher ή αδιάφορο (bounded πλέον στον αριθμό των πραγματικών streams).

Σημείωση: πίσω από Cloudflare το attack κοστίζει bandwidth στο CF edge πρώτα, αλλά το CF δεν είναι ρυθμισμένο ως prerequisite — bare metal deployments εκτίθενται πλήρως.

**Κόστη/κίνδυνοι:** Μηδενικά λειτουργικά — δεν υπάρχει περίπτωση όπου θέλουμε να μετρήσουμε θεατές stream που δεν εκπέμπει.

---

## 3. Το `auth.secret` δεν ελέγχεται ποτέ — ΜΕΣΑΙΑ

**Τοποθεσία:** `app.js:35` (ελέγχει μόνο `config.auth.jwt.secret`), `config.example.json:30` (`"MySuperSecret"`), upstream `broadcast_server.js:59-62`.

**Πρόβλημα:** Το publish auth του nms λειτουργεί έτσι (upstream code):

```js
verifyAuth = (authKey, session) => {
  if (authKey === "") {
    return true;               // ← ΚΕΝΟ secret = ΔΕΝ ΓΙΝΕΤΑΙ ΚΑΝ ΕΛΕΓΧΟΣ
  }
  // ... md5(streamPath-exp-secret) σύγκριση
};
```

και `postPublish` καλεί `verifyAuth` μόνο αν `config.auth.publish === true` (το example το έχει `true`, σωστά).

Δύο σενάρια:

- **Κενό secret:** αν το `auth.secret` μείνει κενό με `auth.publish: true`, οποιοσδήποτε μπορεί να εκπέμψει. Το `passwords.js` το γεμίζει, αλλά αν κάποιος στήσει server χωρίς να τρέξει `generate-passwords`, τίποτα δεν προειδοποιεί.
- **Default secret:** το `"MySuperSecret"` του `config.example.json` είναι δημόσια γνωστή τιμή σε κάθε checkout του repo. Η υπογραφή `sign = md5("/live/stream-<expire>-MySuperSecret")` μπορεί να υπολογιστεί από οποιονδήποτε — πλήρης παρακάμψηση του publish auth.

Το `app.js` κάνει ήδη αυστηρό startup validation για το R2 (`noSlash`, `app.js:21-32` — «Καλύτερα να μη σηκωθεί καθόλου») — ίδια λογική λείπει εδώ.

**Διόρθωση (στο `app.js`, μετά το `loadConfig`):**

```js
// Το nms κάνει silent bypass του publish auth με κενό secret (broadcast_server.js:60)
// και το default του example είναι δημόσια γνωστή τιμή — δεν σηκώνουμε με κανένα από τα δύο.
if (config.auth.publish) {
  const s = config.auth.secret;
  if (!s || s === "MySuperSecret") {
    throw new Error("config.auth.secret: κενό ή default — τρέξε npm run generate-passwords");
  }
}
```

**Κόστη/κίνδυνοι:** Κανένα σε σωστά στημένο deployment (το `passwords.js` γράφει ισχυρό secret). Το μήνυμα σφάλματος πρέπει να λέει τη διόρθωση.

---

## 4. hls.js από CDN χωρίς SRI σε authenticated σελίδες — ΜΕΣΑΙΑ

**Τοποθεσία:** `admin/index.html:177`, `admin/player.html:122` — και τα δύο:

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
```

**Πρόβλημα:** Floating major version (`@1`) από τρίτο μέρος (jsdelivr), χωρίς `integrity` hash. Αν το CDN παραβιαστεί ή ένα μη malicious bad publish περάσει, ο εκτελούμενος κώδικας τρέχει στο origin του admin με τα basic-auth credentials του admin ήδη προσβάσιμα στο script (μπορεί να κάνει authenticated fetches στο `/admin/api/restart` κ.λπ.). Το script φορτώνεται σε **κάθε** φόρτωση των admin σελίδων — όχι σε κάποια σπάνια ροή. Μοναδική προϋπόθεση: παραβίαση του CDN ή ένα κακόβουλο/λάθος publish στο πακέτο.

Το SRI με floating tag είναι εφικτό technically (το jsdelivr σερβίρει stable hash ανά major), αλλά το σωστό είναι:

**Διόρθωση (προτιμώμενη):** vendoring — κατέβασε ένα pinned `hls.min.js` στον `admin/` φάκελο και σερβίρισέ το από το ίδιο το `stats.js`:

```html
<script src="/admin/hls.min.js"></script>
```

(ο φάκελος `admin/` σερβίρεται ήδη μέσω του `PAGES` map — προσθέστε το mapping ή ένα generic static route με allowlist, όχι directory listing.)

**Εναλλακτική:** pin ακριβή έκδοση + SRI:

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js"
        integrity="sha384-<hash>" crossorigin="anonymous"></script>
```

και ανανέωση του hash σε κάθε upgrade (χειροκίνητο, αλλά το script ελέγχεται).

**Κόστη/κίνδυνοι:** Το vendoring αφαιρεί την εξάρτηση από εξωτερικό CDN (πλεονεκτήματα και για privacy/uptime)· κόστος: ένα αρχείο ~500KB στο repo.

---

## 5. Κανένα rate limit στο basic auth — ΧΑΜΗΛΗ

**Τοποθεσία:** `stats.js:369-374`.

Basic auth χωρίς rate limiting = απεριόριστα online brute-force προσπάθειες στον admin password. Το `timingSafeEqual` προστατεύει από timing leaks, όχι από brute force. Σε deployments πίσω από Cloudflare το CF απορροφά μέρος, αλλά το path `/admin*` είναι proxied κανονικά — τα requests φτάνουν.

**Διόρθωση:** Απλός in-memory counter (IP → attempts, reset on success) αφού το admin έχει έναν χρήστη και έναν server:

```js
const fails = new Map(); // ip -> { count, until }
const allowed = (req) => { /* ... στο authorized() wrapper ... */ };
```

Ή pi-hole style: `fail2ban`/Caddy rate limit module στο deployment. Το in-memory αρκεί — το restart του process το καθαρίζει, αποδεκτό.

---

## 6. Διαρροή εσωτερικών σφαλμάτων — ΧΑΜΗΛΗ

**Τοποθεσία:** `stats.js:377` — `json(res, 500, { error: err.message })`.

Το `err.message` μπορεί να περιέχει filesystem paths (SQLite errors), URLs με tokens κ.λπ. προς οποιονδήποτε authenticated χρήστη — χαμηλός κίνδυνος (απαιτεί ήδη έγκυρο admin), αλλά δωρεάν μη δίνουμε τίποτα:

**Διόρθωση:** `console.error(err)` στο server, `json(res, 500, { error: "internal error" })` στον client.

---

## 7. Cookie `nmsv` χωρίς `Secure` — ΧΑΜΗΛΗ

**Τοποθεσία:** `stats.js:174`.

Το cookie δεν κουβαλάει τίποτα ευαίσθητο (random UUID για μέτρηση θεατών), αλλά χωρίς `Secure` μπορεί να σταλεί σε http:// αν παρακαμφθεί το scheme. Πίσω από Caddy πάντα HTTPS, οπότε κυρίως hardening:

**Διόρθωση:** Προσθήκη ` Secure` στο Set-Cookie string. Προσοχή μόνο σε bare-metal debug sessions μέσω plain http στο localhost — εκεί το Secure cookie δεν θα σωθεί, αλλά το fallback (IP+User-Agent) ήδη το καλύπτει.

---

## 8. Χωρίς CSP / `X-Frame-Options` / HSTS — ΧΑΜΗΛΗ

**Τοποθεσία:** `stats.js:342-344` (HTML responses), `Caddyfile`.

- Οι admin σελίδες δεν στέλνουν `Content-Security-Policy` — με το finding #4 διορθωμένο (vendored script), ένα αυστηρό CSP κλειδώνει και μελλοντικές injections: `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self'`.
- Χωρίς `X-Frame-Options: DENY` το admin dashboard μπορεί να φορτωθεί σε iframe (clickjacking στο «Restart server» / «kill» κουμπιά).
- Χωρίς HSTS από τον Caddy, ένα man-in-the-middle downgrade μπορεί να κλέψει τα basic-auth credentials στο πρώτο http request.

**Διόρθωση (Caddyfile):**

```caddyfile
header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    defer
}
```

και CSP από το `stats.js` στα HTML responses (ή και αυτό από τον Caddy, απλούστερο — μόνο στα `/admin*`).

---

## 9. Plaintext secrets με default permissions — ΧΑΜΗΛΗ

**Τοποθεσία:** `config.js:25-41` (`saveConfig`), `config.js:84-101` (`savePasswords`).

Το `config.json` περιέχει admin password, R2 access keys, `auth.secret`, jwt secret — όλα plaintext (αναγκαστικά, δεν γίνεται αλλιώς για τα symmetric keys), αλλά γράφονται με default mode **0644** (world-readable σε shared host). Το `data/passwords.json` αντίστοιχα.

**Διόρθωση:** Στις δύο `fs.writeFile` κλήσεις, τρίτο όρισμα `{ mode: 0o600 }`. Σημείωση: δεν διορθώνει ήδη υπάρχοντα αρχεία — μια φορά `chmod 600 config.json data/passwords.json` στο deploy, ή το `install` script μπορεί να το κάνει. Ο composer bind-mount διατηρεί τα permissions του host.

---

## 10. Stream key χωρίς ουσιαστική λήξη — ΧΑΜΗΛΗ

**Τοποθεσία:** `passwords.js:49` — `expire = now + 50 χρόνια`.

Το `sign=<expire>-<md5>` είναι μακροχρόνιο διαπιστευτήριο εκπομπής: αν διαρρεύσει (OBS config σε screenshot, μοιρασμένο log, shoulder-surfing), ισχύει για δεκαετίες και δεν ανακαλείται παρά μόνο με αλλαγή του `auth.secret` (που ακυρώνει και το παλιό key — okay, αλλά τότε πρέπει re-setup του OBS).

**Διόρθωση (επιλογές):**
- Μειωμένο horizon (π.χ. 90 μέρες) με `${force}` re-generation — αλλά δυσχεραίνει τον χρήστη.
- Καλύτερα: κράτα το 50 χρόνια ως «κλειδί συσκευής» και πρόσθεσε εντολή `npm run rotate-stream-key` που αλλάζει μόνο το streamSecret, με σαφείς οδηγίες OBS στο output. Τουλάχιστον το rotation να είναι μια εντολή, όχι hand-editing του config.json.

---

## 11. `rmSync` σε path που ελέγχεται μόνο από το upstream — ΧΑΜΗΛΗ

**Τοποθεσία:** `app.js:149-151`:

```js
const dir = `${config.static.root}${session.streamPath}`;
fs.rmSync(dir, { recursive: true, force: true });
```

Το `session.streamPath` είναι client-controlled input (`/live/<name>` από RTMP/FLV handshake). Η μόνη προστασία από path traversal είναι το upstream `SAFE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/` (`rtmp_session.js:56`, `flv_session.js:58`). Αν κάποια μελλοντική upstream έκδοση χαλαρώσει το pattern (ή ένα νέο protocol session ξεχάσει τον έλεγχο), αυτό το `rmSync` γίνεται arbitrary directory deletion με δικαιώματα του server process.

**Διόρθωση:** One-line defense-in-depth πριν από κάθε χρήση του streamPath ως filesystem path (και στο `startFfmpeg`, `app.js:68`):

```js
// Το upstream ήδη φιλτράρει (SAFE_NAME_PATTERN), αλλά το rmSync βασίζεται
// εξ ολοκλήρου σε εκείνο — ένας τοπικός έλεγχος επιβιώνει των upstream αλλαγών.
const SAFE_STREAM = /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/;
if (!SAFE_STREAM.test(session.streamPath)) return;
```

---

## 12. `x-forwarded-for` παίρνει την πρώτη τιμή — ΧΑΜΗΛΗ

**Τοποθεσία:** `stats.js:154`:

```js
const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
```

Η πρώτη τιμή της λίστας είναι ό,τι έστειλε ο client (spoofable)· η σωστή (όταν ο μόνος trusted proxy είναι ο Caddy) είναι η **τελευταία**. Στην πράξη πίσω από Cloudflare+Caddy χωρίς `trusted_proxies` στο Caddy, το XFF το γράφει ο CF και η τιμή βγαίνει λάθος ούτως ή άλλως (CF edge IP ή client-supplied). Επηρεάζει την ακρίβεια της **μέτρησης θεατών** (spoofed `nmsv` cookie ανεξάρτητο, αλλά το fallback key IP+UA χειροτερεύει), όχι αυστηρά ασφάλεια.

**Διόρθωση:**

```js
const xff = req.headers["x-forwarded-for"];
const ip = ((xff ? xff.split(",").pop() : "") || req.socket.remoteAddress || "").trim();
```

Μακροπρόθεσμα: Caddy `trusted_proxies` με Cloudflare IP ranges + CF-Connecting-IP header.

---

## Ό,τι είναι σωστό (να μη χαθεί σε refactor)

- **`timingSafeEqual` με length check** στο basic auth — `stats.js:360-363`.
- **SQLite αποκλειστικά prepared statements** — κανένα string-concatenated SQL σε όλο το `stats.js`.
- **`spawn` με array args, χωρίς shell** — `app.js:75` (κανένα command injection στο ffmpeg args).
- **No path traversal στο `PAGES` routing** — `stats.js:342`, fixed map, όχι filesystem lookup από URL.
- **`ADMIN_HOST` default `127.0.0.1`** και στο Docker η 8001 δεν δημοσιεύεται — μόνο ο Caddy τη φτάνει (`docker-compose.yml:17-22`).
- **Basic auth μέσα στην εφαρμογή** — ένα αντίγραφο του κωδικού, όχι hash σε δεύτερο σημείο (`stats.js:353-355`).
- **R2: upload πριν το publish του playlist** — σωστή σειρά, δεν υπαγορεύει ασφάλεια αλλά ορθότητα.
- **`defer` στα Caddy header directives** — αποτρέπει διπλά Cache-Control на segments.

## Προτεινόμενη σειρά διόρθωσης

1. #3 (auth.secret check) — 5 λεπτά, προστατεύει τη μεγαλύτερη επιφάνεια (publish auth bypass).
2. #2 (trackHls guard) — 5 λεπτά, αφαιρεί το μοναδικό unauthenticated DoS vector.
3. #1 (CSRF guard) — 15 λεπτά.
4. #4 (hls.js vendoring) — 30 λεπτά.
5. #5-#12 — batch hardening, όποτε βολεύει.
