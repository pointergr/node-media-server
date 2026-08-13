# Πλάνο: πολλοί πελάτες, κλειδί ανά path, όριο θεατών, κεντρικό panel

Κατάσταση: **σχέδιο, δεν έχει υλοποιηθεί**. Γραμμένο 2026-08-13.

Σήμερα ο server είναι μονοπελατειακός: ένα `streamSecret` στο `config.json`, ένα
`sign` για το `/live/stream`, ανοιχτή αναπαραγωγή, καμία έννοια «πελάτη».
Ο στόχος είναι πολλοί πελάτες με δικά τους paths, δικό τους κλειδί εκπομπής και
όριο ταυτόχρονων θεατών ανά πακέτο, όλα διαχειριζόμενα από ένα κεντρικό panel που
βλέπει πολλούς servers.

## Αποφάσεις που έχουν ήδη παρθεί

**1. Δικός μας έλεγχος κλειδιού, `auth.publish: false`.**
Το ενσωματωμένο auth του nms (`broadcast_server.js:59-77`) υπολογίζει
`md5(streamPath-exp-secret)` — είναι ήδη δεμένο στο path, οπότε λύνει το «ο ένας
πελάτης εκπέμπει στο path του άλλου». Δεν το κρατάμε γιατί απαιτεί είτε να ξέρει
το panel το `secret` κάθε server για να υπογράφει, είτε να ταξιδεύει το secret
προς τους πελάτες (σήμερα το `passwords.js:69` το τυπώνει — με αυτό υπογράφεις
οποιοδήποτε path). Ένα τυχαίο κλειδί ανά path, ορισμένο από το panel, δεν έχει
λήξεις, ρολόγια και md5, και ανακαλείται σβήνοντάς το.

**2. `data/clients.json` = η μόνη τοπική πηγή αλήθειας.**
Το γράφει το sync, το διαβάζουν όλοι. Δίπλα στο `passwords.json`, δηλαδή μέσα στο
data volume ώστε να επιβιώνει το recreate του container.

```json
{
  "pelatis-a": {
    "limit": 200,
    "paths": { "/live/kamera1": "KEY1", "/live/kamera2": "KEY2" }
  }
}
```

Το `limit` είναι **αθροιστικό σε όλα τα paths του πελάτη** — το πακέτο πουλιέται
ανά πελάτη, όχι ανά κάμερα. `limit: 0` ή απόν = χωρίς όριο.

**3. Επικοινωνία με το panel: ένα POST ανά 10s από τον server προς το panel.**
Το σώμα είναι το `snapshot()` (τι παίζει, πόσοι θεατές), η απάντηση είναι το
`clients.json`. Pull αντί για push γιατί ο server συγχρονίζεται μόνος του μετά
από restart/deploy, ενώ ένα push σε server εκτός λειτουργίας χάνεται και το panel
θα έπρεπε να κρατάει ουρά και να ξέρει ποιος είναι πάνω. Δεν χρειάζεται WebSocket:
η μόνη απαίτηση χαμηλής καθυστέρησης είναι η ανάκληση, και τα 10s φτάνουν.

**4. Επιβολή ορίου σε δύο σημεία**, όσα είναι και τα κανάλια αναπαραγωγής:
HLS στο `trackHls` (`stats.js:146`) και RTMP/FLV στο `postPlay` (`stats.js:218`).

**5. Ανάκληση εν ώρα εκπομπής στο υπάρχον tick των 10s** (`sample()`,
`stats.js:225`) — όχι watcher αρχείου, όχι κλήση από το panel.

## Φάσεις

Κάθε φάση αφήνει τον server λειτουργικό. Χωρίς `data/clients.json` τίποτα από
όλα αυτά δεν ενεργοποιείται και η συμπεριφορά μένει η σημερινή — αυτό είναι και
ο δρόμος αναδίπλωσης αν κάτι πάει στραβά σε production.

### Φάση 1 — loader (`config.js`)

```js
// Το playlist ζητιέται κάθε 2s ανά θεατή· 200 θεατές = 100 reads/s στον δίσκο.
// 5s cache: ο admin βλέπει την αλλαγή του πρακτικά αμέσως, ο δίσκος δεν το καταλαβαίνει.
let cache = { ts: 0, data: {} };
export function loadClients() {
  if (Date.now() - cache.ts < 5000) return cache.data;
  try { cache = { ts: Date.now(), data: JSON.parse(fs.readFileSync(CLIENTS, "utf8")) }; }
  catch { cache = { ts: Date.now(), data: {} }; }   // λείπει/χαλασμένο = χωρίς πελάτες
  return cache.data;
}
export const clientOf = (path) =>
  Object.values(loadClients()).find((c) => c.paths?.[path] !== undefined);
```

Σύγχρονο διάβασμα επίτηδες: καλείται μέσα σε `trackHls` και σε event handlers που
δεν είναι async.

**Έλεγχος** (`test-clients.js`): γράψε προσωρινό αρχείο, `clientOf` βρίσκει το
path, δεύτερη κλήση μέσα σε 5s δεν ξαναδιαβάζει (μέτρα με mock `fs.readFileSync`
ή με mtime), χαλασμένο JSON δεν ρίχνει.

### Φάση 2 — κλειδί εκπομπής (`app.js`)

`config.json`: `auth.publish` → `false`.

Στην αρχή του `nms.on("postPublish", ...)` (`app.js:129`), **πριν** από τον έλεγχο
`hlsJobs.has` και πριν φτιαχτεί οτιδήποτε:

```js
const client = clientOf(session.streamPath);
if (client && client.paths[session.streamPath] !== session.streamQuery?.key) {
  console.error(`publish ${session.streamPath} ${session.ip}: άκυρο κλειδί`);
  session.rejected = true;
  session.close();
  return;
}
```

`client === undefined` (path εκτός panel) σημαίνει «άγνωστο path». Απόφαση προς
λήψη πριν το deploy: το κόβουμε ή το αφήνουμε; Όσο υπάρχει το παλιό
`/live/stream` που δεν έχει περάσει στο panel, το «άφησέ το» είναι το ασφαλές —
γίνε αυστηρός μόλις μεταφερθούν όλοι.

Στο OBS το κλειδί μπαίνει στο Stream Key: `kamera1?key=KEY1`. Το nms κόβει το
query πριν φτιάξει το path (`rtmp.js:714,728`), οπότε `streamPath` και
`streamQuery.key` βγαίνουν καθαρά και τίποτα άλλο (φάκελος HLS, στατιστικά,
`hlsJobs`) δεν αλλάζει.

**Παγίδα:** το `postPublish` το ακούει και το `stats.js:207`, και το event
γίνεται emit μία φορά για όλους — ο απορριφθείς publisher θα καταγραφόταν σαν
κανονικός και θα εμφανιζόταν στο dashboard για ένα κλάσμα. Γι' αυτό το
`session.rejected` παραπάνω· στο `stats.js` μπαίνει δίπλα στον υπάρχοντα έλεγχο
`isLocal`:

```js
if (isLocal(session) || session.rejected) return;
```

Η σειρά είναι εξασφαλισμένη: το `app.js` δηλώνει τον listener του στη γραμμή 129,
το `startStats` καλείται στη 200.

**Έλεγχος** (`test-publish-key.js`, ή επέκταση του fake `nms` του `test-stats.js`):
σωστό κλειδί → δημιουργείται job· λάθος κλειδί → `close()` και κανένα job· path
εκτός `clients.json` → η συμφωνημένη συμπεριφορά της απόφασης παραπάνω.

### Φάση 3 — όριο θεατών (`stats.js`)

Δίπλα στο υπάρχον `viewersOf` (`stats.js:114`), που ήδη αθροίζει RTMP/FLV
sessions και HLS cookies:

```js
function overLimit(stream) {
  const c = clientOf(stream);
  if (!c?.limit) return false;
  return Object.keys(c.paths).reduce((n, p) => n + viewersOf(p), 0) >= c.limit;
}
```

**HLS** — μέσα στο `trackHls`, μετά τον υπολογισμό των `token`/`key` και
**πριν** από κάθε `seen.set` (αλλιώς ο 201ος μπαίνει στο σύνολο και μετά κόβεται
κάποιος άλλος):

```js
// Θεατής που μετριέται ήδη περνάει πάντα — αλλιώς θα κοβόταν στο επόμενο refresh
// του playlist κάποιος που ήδη βλέπει. Ο καινούριος παίρνει 404: ίδιο σήμα με το
// «δεν εκπέμπει», οπότε ο player μπαίνει στον υπάρχοντα δρόμο επανασύνδεσης.
if (!seen.has(token ?? key) && overLimit(stream)) {
  req.url = "/__full.m3u8";
  return;
}
```

Γιατί rewrite και όχι `res.writeHead(403)`: το express είναι ο μόνος άλλος
listener του `"request"` (`http_server.js:53`) και θα έγραφε δεύτερο αν είχαμε
απαντήσει εμείς. Αλλάζοντας το url, το `express.static` βγάζει καθαρό 404.

**RTMP/FLV** — στο υπάρχον `nms.on("postPlay", ...)`, αμέσως **μετά** τον έλεγχο
`isLocal`:

```js
if (overLimit(session.streamPath)) return session.close();
```

Η σειρά είναι κρίσιμη: ο ffmpeg του HLS συνδέεται ως θεατής από το `127.0.0.1`,
και αν κοπεί από το όριο, ένα γεμάτο stream σταματά να παράγει HLS συνολικά.

**Ακρίβεια που πρέπει να ξέρει το panel:** ο HLS θεατής σβήνει 30s μετά το
κλείσιμο του player (`HLS_TTL_MS`), άρα το όριο ελευθερώνεται με καθυστέρηση· και
δύο tabs του ίδιου browser μετράνε ως ένας (υπάρχον `ponytail:` σχόλιο,
`stats.js:163`). Με R2 ενεργό ο περιορισμός δουλεύει κανονικά, γιατί τα `.ts`
φεύγουν από το CDN αλλά το playlist μένει πάντα στο origin.

**Έλεγχος**: το `test-stats.js` έχει ήδη fake `nms` και καλεί το `trackHls` με
χειροποίητα `req`/`res` — πρόσθεσε: 3 θεατές σε δύο paths του ίδιου πελάτη με
`limit: 3` → ο τέταρτος παίρνει `req.url` αλλαγμένο, ο πρώτος (με cookie) όχι.

### Φάση 4 — ανάκληση εν ώρα εκπομπής (`stats.js`)

Μέσα στο `sample()`, που τρέχει ήδη κάθε `SAMPLE_MS` (10s):

```js
// Ο έλεγχος στο postPublish πιάνει μόνο τη στιγμή της σύνδεσης. Πελάτης που
// διαγράφηκε ή του άλλαξε το κλειδί ενώ εκπέμπει πρέπει να κοπεί χωρίς να
// περιμένουμε να σταματήσει μόνος του — και ο έλεγχος στο publish φροντίζει
// ώστε το reconnect του OBS να μην ξαναπεράσει.
for (const [stream, pub] of publishers) {
  const c = clientOf(stream);
  if (c && c.paths[stream] !== pub.streamQuery?.key) pub.close();
}
```

Προαιρετικό στο ίδιο σημείο: κόψιμο θεατών που ξεπερνούν το όριο μετά από αλλαγή
πακέτου προς τα κάτω. Το HLS το κάνει μόνο του (το 404 έρχεται στο επόμενο
refresh)· μόνο RTMP/FLV θα ήθελαν ρητό `close()`.

### Φάση 5 — sync με το panel (`panel.js`, νέο)

```js
export function startPanelSync(config, snapshot) {
  const { url, token, host } = config.panel ?? {};
  if (!url) return;               // χωρίς panel, το clients.json το γράφει το χέρι
  const tick = async () => {
    try {
      const res = await fetch(`${url}/servers/${host}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(snapshot()),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const clients = JSON.stringify(await res.json(), null, 2);
      // tmp+rename: ο loader μπορεί να διαβάζει την ίδια στιγμή, ποτέ μισό JSON
      fs.writeFileSync(`${CLIENTS}.tmp`, clients);
      fs.renameSync(`${CLIENTS}.tmp`, CLIENTS);
    } catch (e) {
      // Το τελευταίο clients.json μένει σε ισχύ: panel κάτω δεν σημαίνει εκπομπές κάτω.
      console.error(`panel sync: ${e.message}`);
    }
  };
  tick();
  setInterval(tick, 10_000).unref();
}
```

`app.js` μετά το `startStats`: `startPanelSync(config, stats.snapshot)`.
`config.example.json`: `"panel": { "url": "", "token": "", "host": "" }` — κενό
`url` σημαίνει απενεργοποιημένο, ίδιο μοτίβο με το `hls.r2.accessKeyId`.

**Έλεγχος** (`test-panel.js`): override του `globalThis.fetch` όπως στο
`test-r2.js` — επιτυχία γράφει το αρχείο, HTTP 500 και timeout δεν το αγγίζουν,
το σώμα του request περιέχει το snapshot.

### Φάση 6 — μεριά του panel

Υλοποιείται στο `apps/api` (NestJS) — δομή, σειρά και deployment στο
[PLAN-monorepo.md](PLAN-monorepo.md). Το συμβόλαιο:

- `POST /servers/:host/sync` — auth με το bearer token του server, αποθηκεύει το
  snapshot (live θεατές/streams ανά server), επιστρέφει το `clients.json` **μόνο**
  των πελατών που ανήκουν σε αυτόν τον server.
- Παραγωγή κλειδιών ανά path (τυχαία, ≥16 χαρακτήρες) και εμφάνιση έτοιμου
  Stream Key `όνομα?key=...` για αντιγραφή στο OBS.
- Το `limit` ανά πελάτη, τα paths ανά πελάτη, ανάθεση πελάτη σε server.
- Απενεργοποίηση πελάτη = αφαίρεση από την απάντηση του sync. Το κόψιμο γίνεται
  μόνο του μέσα σε ≤10s (Φάση 4).
- Άμεση ενέργεια χωρίς αναμονή, αν χρειαστεί: το `DELETE /admin/api/sessions/:id`
  υπάρχει ήδη (`stats.js:323`).

### Φάση 7 — καθάρισμα και τεκμηρίωση

- `passwords.js`: να σταματήσει να τυπώνει το `Stream secret` και το
  `sign=` — με το νέο σχήμα ο πελάτης παίρνει μόνο `όνομα?key=...`. Ο admin
  κωδικός και το jwt μένουν ως έχουν.
- `npm test`: πρόσθεσε τα νέα `test-*.js`.
- `README.md` + `CLAUDE.md`: το νέο μοντέλο auth, το `clients.json`, το sync.
- Caddy/Docker: **καμία αλλαγή**. Το `clients.json` πάει στο υπάρχον data volume.

## Χειροκίνητη δοκιμή πριν το production

1. `npm run test-stream` με σωστό `?key=` → παίζει· με λάθος → η σύνδεση κλείνει
   και δεν δημιουργείται φάκελος HLS.
2. Δεύτερη εκπομπή στο path άλλου πελάτη με το δικό της κλειδί → απορρίπτεται.
3. `limit: 1`, δύο players → ο δεύτερος παίρνει 404 στο playlist, ο πρώτος
   συνεχίζει απρόσκοπτα (κρίσιμο: το refresh του πρώτου δεν πρέπει να κοπεί).
4. Διαγραφή πελάτη από το panel ενώ εκπέμπει → κόβεται μέσα σε 10s και το
   reconnect του OBS αποτυγχάνει συνεχώς.
5. Panel κάτω (σβήσε το `url` ή κόψε το δίκτυο) → οι εκπομπές συνεχίζουν με το
   τελευταίο `clients.json`.

## Ανοιχτά ερωτήματα

- **Άγνωστο path**: μπλόκο ή ελεύθερο; (δες Φάση 2 — επηρεάζει το πότε μπορεί να
  γίνει αυστηρός ο έλεγχος).
- **Αλλαγή κλειδιού εν ώρα εκπομπής**: η Φάση 4 κόβει αμέσως τον publisher με το
  παλιό κλειδί. Αν θέλουμε χάρη μέχρι το επόμενο reconnect, το panel πρέπει να
  στέλνει και τα δύο κλειδιά για ένα διάστημα.
- **Αναπαραγωγή**: σήμερα ανοιχτή. Αν κάποιος πελάτης θέλει κλειστά streams, ο
  ίδιος μηχανισμός `?key=` στο `postPlay` δουλεύει για RTMP/FLV, αλλά το HLS
  θέλει signed URLs — άλλη συζήτηση.
- **Πολλαπλοί servers**: ποιος αποφασίζει σε ποιον server κάθεται ο πελάτης και
  τι γίνεται σε μετακόμιση (το `rtmp.<domain>` του πελάτη αλλάζει).
