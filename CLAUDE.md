# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Γλώσσα

Τα σχόλια στον κώδικα, το README και τα μηνύματα των commits είναι **στα ελληνικά**. Κράτα το ίδιο ύφος: το σχόλιο εξηγεί *γιατί*, όχι *τι*.

## Εντολές

Το repo είναι npm workspaces monorepo — ο stream server ζει σε `apps/stream/`, οι εντολές
παρακάτω τρέχουν από τη **ρίζα**:

```bash
cp apps/stream/config.example.json apps/stream/config.json  # απαραίτητο πριν από οτιδήποτε άλλο
npm start                           # -w apps/stream, δηλ. node app.js
npm test                            # --workspaces, όλα τα workspaces· σήμερα μόνο apps/stream
cd apps/stream && node test-stats.js   # ένα μόνο test — σκέτα node scripts, χωρίς framework
npm run test-stream [-- <rtmp host>] # δοκιμαστική εκπομπή με ffmpeg testsrc, χωρίς OBS
npm run generate-passwords <hostname>  # γράφει κωδικούς σε apps/stream/config.json + apps/stream/data/passwords.json
npm run seed -w apps/api            # φτιάχνει τον πρώτο admin χρήστη του κεντρικού panel
```

Το `npm test` της ρίζας τρέχει **και τα δύο** workspaces — `apps/stream` (σκέτα scripts) και
`apps/api` (`nest build && node --test dist/test/*.js`, δες [apps/api/README.md](apps/api/README.md)).

Θέλει **Node 24** (το `node:sqlite` του `stats.js`) — pinned στο volta. Σε Docker: `docker compose exec stream npm test` (μέσα στο container το cwd είναι ήδη `apps/stream`).

Τα tests είναι `assert`-based scripts με χειροποίητα mocks (δες το fake `nms` στην αρχή του `test-stats.js`, το `globalThis.fetch` override στο `test-r2.js`). Νέο test = νέο `test-*.js` + μια γραμμή στο `apps/stream/package.json`. Όποιο test αγγίζει πελάτες βάζει `process.env.CLIENTS_FILE` σε προσωρινό αρχείο και κάνει **δυναμικό** import (το path διαβάζεται στο import του `config.js`) — και `clearClientsCache()` μετά από κάθε γράψιμο.

## Αρχιτεκτονική

Λεπτό wrapper γύρω από το `node-media-server` v4, στο workspace `apps/stream/`. Τα δύο πράγματα που δεν κάνει το v4 και τα κάνουμε εμείς: HLS, στατιστικά (JSON API — η οθόνη διαχείρισης ζει στο κεντρικό panel, `apps/api`).

**`app.js`** — orchestrator. Το v4 δεν βγάζει HLS, οπότε σε κάθε `postPublish` σπρώχνει ένα `ffmpeg -c copy` (remux) που διαβάζει από το δικό μας RTMP στο loopback και γράφει segments στο `config.static.root`. Τα jobs κλειδώνονται με **`session.streamPath`, όχι `session.id`**: το v4 βγάζει `postPublish` πριν απορρίψει διπλό publisher, οπότε το reconnect του OBS αφήνει ζόμπι ffmpeg στον ίδιο φάκελο (δες το σχόλιο στο `app.js:35`).
Το `ff.on("exit")` σβήνει το job από τον χάρτη: χωρίς αυτό, ένας ffmpeg που πεθαίνει μόνος
του κλειδώνει το streamPath και το HLS μένει νεκρό μέχρι να αποσυνδεθεί ο publisher.

**`ertmp.js`** — monkey patch στο `Flv.parserTag` του nms. Το v4.2.8 αναγνωρίζει enhanced RTMP μόνο για av01/vp09/hvc1· το `avc1` του OBS πέφτει έξω από κάθε κλάδο και μένει με `flags=0` («audio sequence header»), οπότε το avcC δεν μπαίνει ποτέ στο `rtmpVideoHeader`. Όποιος συνδεθεί μετά τον publisher — δηλαδή και ο ffmpeg του HLS, που κοστίζει ένα spawn — δεν παίρνει ποτέ SPS/PPS.

**`r2.js`** — προαιρετικό, ενεργό μόνο αν `config.hls.r2.accessKeyId` δεν είναι κενό. Αλλάζει τη ροή του HLS σε δύο επίπεδα:

| | R2 off | R2 on |
|---|---|---|
| ffmpeg γράφει | `index.m3u8` | `ff.m3u8` με `-hls_base_url` (απόλυτα URLs) |
| segments | σερβίρονται από τον static server | PUT στο R2 |
| `index.m3u8` | το ίδιο αρχείο | το γράφει το `r2.js` **μετά** τα uploads |

Η σειρά upload-πριν-publish είναι η ουσία: ανάποδα ο player ζητάει segment που δεν έχει ανέβει. Το playlist μένει πάντα στο origin — εκεί μετριούνται οι θεατές.

**`stats.js`** — collector + admin HTTP server (δικό του `http.createServer` στο 8001, ξεχωριστό από του nms). Σημεία που δεν φαίνονται από ένα αρχείο:
- Οι RTMP/FLV θεατές βγαίνουν από τα events του nms· οι **HLS θεατές** από `prependListener("request")` πάνω στον HTTP server του nms, με cookie `nmsv` (fallback IP+User-Agent). Το `prepend` χρειάζεται για να προλάβει το `Set-Cookie` πριν απαντήσει ο express.
- Ό,τι έρχεται από `127.0.0.1` εξαιρείται — αλλιώς ο ffmpeg του HLS μετράει ως θεατής.
- Bitrate δεν υπάρχει στο API του v4: βγαίνει από διαφορά δύο δειγμάτων ανά 10s, με τα bytes των κλειστών sessions συσσωρευμένα (αλλιώς αρνητικό bitrate όταν φεύγει θεατής). Το πρώτο δείγμα κάθε stream μπαίνει στο `postPublish`, αλλιώς το dashboard δείχνει «0 bps» μέχρι το δεύτερο tick.
- Basic auth **μέσα στην εφαρμογή**, με τον κωδικό του `config.json` — σκόπιμα όχι στον Caddy, ώστε να μην υπάρχει δεύτερο αντίγραφο του κωδικού που ξεχνιέται.
- Επιστρέφει `{ sample, snapshot, series, db, server }` για να το οδηγούν τα tests.

**`config.js`** — `config.json` (κατάσταση deployment, εκτός git), `data/passwords.json` (στο data volume, με migration από την παλιά ρίζα) και ο loader του `data/clients.json`. Το `app.js` γράφει το jwt secret στο `config.json` στο πρώτο boot· γι' αυτό το compose το κάνει bind mount.

**Πελάτες (`data/clients.json`)** — `{ πελάτης: { limit, paths: { "/live/x": "KEY" } } }`, η μόνη τοπική πηγή αλήθειας· το γράφει το `panel.js`, το διαβάζουν όλοι με 5s cache (το playlist ζητιέται κάθε 2s ανά θεατή — χωρίς cache ο δίσκος το καταλαβαίνει).
- Ο έλεγχος εκπομπής είναι δικός μας (`auth.publish: false`), σε **μία** συνάρτηση, την `publishAllowed`: την καλεί το `app.js` στο `postPublish` (τη στιγμή της σύνδεσης, με `session.rejected` ώστε να μην τον μετρήσει το `stats.js`) και το `stats.js` στο `sample()` (ανάκληση εν ώρα εκπομπής, ≤10s). Δύο αντίγραφα θα άφηναν τρύπα στο ένα από τα δύο σημεία.
- **Άγνωστο path = μπλόκο.** Ο διακόπτης της επιβολής είναι η **ύπαρξη** του αρχείου, όχι το περιεχόμενό του: αρχείο που λείπει ή χάλασε δεν ρίχνει τις εκπομπές (δρόμος αναδίπλωσης), αλλά ένα έγκυρο `{}` σημαίνει «κανένας πελάτης σε αυτόν τον server» και κλείνει τα πάντα — αλλιώς ένας server που μόλις μπήκε στο panel, ή του οποίου απενεργοποιήθηκαν όλοι οι πελάτες, θα γινόταν ορθάνοιχτος με το πρώτο sync. Γι' αυτό το `passwords.js` φτιάχνει πελάτη `default` στην πρώτη εγκατάσταση — αλλιώς καθαρός server χωρίς αρχείο ακόμα = ορθάνοιχτος server.
- Το `limit` είναι αθροιστικό σε όλα τα paths του πελάτη και επιβάλλεται στα δύο κανάλια αναπαραγωγής: `trackHls` (rewrite του `req.url` σε ανύπαρκτο αρχείο, γιατί δική μας απάντηση θα διπλογραφόταν με του express) και `postPlay`. Ο ήδη μετρημένος θεατής περνάει πάντα, και ο έλεγχος έρχεται **μετά** το `isLocal` — ο ffmpeg του HLS δεν κόβεται ποτέ από όριο, αλλιώς σταματά όλο το HLS του stream.

**`panel.js`** — προαιρετικό, ενεργό μόνο αν `config.panel.url` δεν είναι κενό (ίδιο μοτίβο με το `hls.r2.accessKeyId`). POST ανά 10s με το `snapshot()`, η απάντηση γράφεται με tmp+rename στο `clients.json` (ο loader διαβάζει σύγχρονα και δεν πρέπει να δει μισό JSON). Σφάλμα = log και τίποτα άλλο: panel κάτω δεν σημαίνει εκπομπές κάτω.

## apps/api

Το κεντρικό panel: NestJS, διαχειρίζεται πολλούς stream servers, πελάτες, paths, κλειδιά
εκπομπής και όρια θεατών — η άλλη άκρη του `panel.js` παραπάνω. Πλήρες συμβόλαιο των
endpoints στο [apps/api/README.md](apps/api/README.md), δεν το ξαναγράφουμε εδώ.

Sqlite με Prisma 6 (**όχι 7** — θα έφερνε driver adapters για ένα σχήμα λίγων πινάκων), και
`prisma db push` σε **κάθε boot** αντί για migrations: δεν υπάρχει migrations directory, το
`schema.prisma` είναι η μόνη πηγή αλήθειας — αρκεί όσο το σχήμα δεν έχει ιστορικό αλλαγών σε
production. Auth σε δύο επίπεδα και κανένα passport: JWT (`@nestjs/jwt`) για χρήστες
(admin/customer, global guard εκτός `@Public()`), και static bearer token ανά server μόνο
για το `POST /servers/:host/sync` — ο stream server δεν συνδέεται ποτέ σαν χρήστης. Κωδικοί
με `node:crypto` `scryptSync`/`timingSafeEqual`, όχι bcrypt — καμία native εξάρτηση στο
image. Tests: `nest build` πρώτα, μετά σκέτο `node --test` πάνω στο compiled output
(`dist/test/*.js`) — ίδια φιλοσοφία με τα `test-*.js` του `apps/stream`, όχι jest/supertest.

Τα live snapshots (`GET /live`) ζουν **μόνο στη μνήμη** — μετά από restart του API είναι
άδεια μέχρι το επόμενο sync tick (≤10s) από κάθε server. Δεν αποθηκεύονται στη sqlite: το
ιστορικό (series) το κρατάει ήδη κάθε stream server στο δικό του `stats.db` και το API κάνει
proxy σε αυτό, δεν το αντιγράφει κεντρικά.

## Deploy

Ένα `apps/stream/install <hostname> [--docker]` για bare metal (caddy + volta + pm2) και Docker (compose με caddy container). Ένα `Caddyfile` και για τα δύο — το `STREAM_HOST` πέφτει σε `localhost` χωρίς Docker. Τα `header` directives θέλουν **`defer`**, αλλιώς προστίθεται από πάνω το `Cache-Control` του `express.static` και βγαίνουν δύο τιμές στην ίδια απόκριση.

`.m3u8` → ποτέ cache (αλλιώς σπάει η μέτρηση θεατών). `.ts` → immutable. Το `rtmp.<domain>` πρέπει να είναι DNS only στο Cloudflare — το proxy δεν περνάει το 1935.
