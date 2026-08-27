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
npm run seed -w apps/api force      # ...ή ξαναγράφει τον κωδικό του (χαμένος κωδικός admin)
docker compose exec api node dist/src/seed.js force   # το ίδιο σε Docker, από apps/api/
node dist/src/apikey.js <όνομα>|list|revoke <id>      # API keys για εξωτερικές υπηρεσίες (apps/api/README.md)
npm run dev -w apps/panel           # Nuxt dev server, με devProxy /api -> localhost:3000 (χρειάζεται το apps/api να τρέχει)
npm run generate -w apps/panel      # nuxt generate -> apps/panel/.output/public, τα στατικά που σερβίρει ο Caddy
```

Το `npm test` της ρίζας τρέχει **και τα τρία** workspaces — `apps/stream` (σκέτα scripts),
`apps/api` (`nest build && node --test dist/test/*.js`, δες [apps/api/README.md](apps/api/README.md))
και `apps/panel` (`test-dash.js`, σκέτο script).

Θέλει **Node 24** (το `node:sqlite` του `stats.js`) — pinned στο volta. Σε Docker: `docker compose exec stream npm test` (μέσα στο container το cwd είναι ήδη `apps/stream`).

Το `seed` σε Docker θέλει σκέτο `node`, όχι το npm script: το script είναι
`node --env-file=.env …` και μέσα στο container δεν υπάρχει `.env` — τις μεταβλητές τις
δίνει το compose, οπότε το `--env-file` σκάει με `node: .env: not found`.

Τα tests είναι `assert`-based scripts με χειροποίητα mocks (δες το fake `nms` στην αρχή του `test-stats.js`, το `globalThis.fetch` override στο `test-r2.js`). Νέο test = νέο `test-*.js` + μια γραμμή στο `apps/stream/package.json`. Όποιο test αγγίζει πελάτες βάζει `process.env.CLIENTS_FILE` σε προσωρινό αρχείο και κάνει **δυναμικό** import (το path διαβάζεται στο import του `config.js`) — και `clearClientsCache()` μετά από κάθε γράψιμο.

## Αρχιτεκτονική

Λεπτό wrapper γύρω από το `node-media-server` v4, στο workspace `apps/stream/`. Τα δύο πράγματα που δεν κάνει το v4 και τα κάνουμε εμείς: HLS, στατιστικά (JSON API — η οθόνη διαχείρισης ζει στο κεντρικό panel, `apps/api`).

**`app.js`** — orchestrator. Το v4 δεν βγάζει HLS, οπότε σε κάθε `postPublish` σπρώχνει ένα `ffmpeg -c copy` (remux) που διαβάζει από το δικό μας RTMP στο loopback και γράφει segments στο `config.static.root`. Τα jobs κλειδώνονται με **`session.streamPath`, όχι `session.id`**: το v4 βγάζει `postPublish` πριν απορρίψει διπλό publisher, οπότε το reconnect του OBS αφήνει ζόμπι ffmpeg στον ίδιο φάκελο (δες το σχόλιο στο `app.js:35`).
Το `ff.on("exit")` σβήνει το job από τον χάρτη: χωρίς αυτό, ένας ffmpeg που πεθαίνει μόνος
του κλειδώνει το streamPath και το HLS μένει νεκρό μέχρι να αποσυνδεθεί ο publisher.

**`ladder.js`** — το χτίσιμο των args του ffmpeg, καθαρή συνάρτηση σε δικό της αρχείο ώστε
να έχει test χωρίς να σηκωθεί server (το `app.js` έχει top-level side effects). Χωρίς ladder
γυρίζει **byte-για-byte τα σημερινά args** (σκέτο remux, ένα playlist) — αυτός είναι ο δρόμος
αναδίπλωσης και τον κλειδώνει το `test-ladder.js` με ολόκληρο τον πίνακα. Με ladder βγαίνει
master playlist + variants: `split`/`scale` ανά σκαλοπάτι, `-var_stream_map` με **ονόματα**
(`name:720`) ώστε τα αρχεία να λένε μόνα τους πού ανήκουν, η κορυφή πάντα `copy` (και το
`-bsf` **μόνο** σε αυτήν), ήχος `copy` παντού. Τα keyframes κλειδώνονται με
`-force_key_frames` σε **χρόνο** και όχι με `-g` σε καρέ: το fps της πηγής το ορίζει ο
πελάτης. Τα variants είναι **επίπεδα αρχεία** στον ίδιο φάκελο (`v720.m3u8`), όχι υποφάκελοι
— το `stats.js` βγάζει το stream από το dirname του request και ένα `v0/` θα έσπαγε μονομιάς
`clientOf`, `overLimit`, samples και panel. Πλαφόν encoded σκαλοπατιών ανά server
(`config.hls.maxRenditions`), γιατί το πλάνο είναι εμπορική υπόσχεση και το πλαφόν είναι τι
σηκώνει το μηχάνημα.
Ο **encoder** είναι κι αυτός του server (`config.hls.encoder`, πίνακας `ENCODERS`): άγνωστη
ή απούσα τιμή ⇒ `x264` και τα σημερινά args ακριβώς, οπότε ο στόλος χωρίς GPU δεν βλέπει
τίποτα. Το `app.js#usableEncoder` τον δοκιμάζει **μία φορά στο boot** με ένα καρέ από
`lavfi` (ο κατάλογος `-encoders` δείχνει τον nvenc και χωρίς driver) και πέφτει σε x264 με
ένα log αν αποτύχει: αλλιώς λάθος τιμή σκοτώνει τον ffmpeg κάθε εκπομπής μέχρι το
`RESPAWN_MAX`. Με x264 ο probe δεν τρέχει καν. Το scale μένει στη CPU και για τους δύο
GPU encoders — δέχονται software frames, και το `scale_cuda`/`hwupload` θα ήθελε άλλο
filter graph ανά encoder για το φθηνό κομμάτι της δουλειάς.
Το «ποτέ upscale» θέλει το ύψος της πηγής, που **δεν υπάρχει ακόμα στο `postPublish`**: το
`videoHeight` γράφεται όταν φτάσει το `@setDataFrame` (`broadcast_server.js:200`), ενώ το
event εκπέμπεται με την εντολή publish (`:159`). Γι' αυτό το `app.js#spawnWhenReady`
περιμένει (100ms tick, λήξη 2s — `waitForHeight`) πριν σηκώσει ffmpeg, **μόνο** όταν υπάρχει
ladder· χωρίς ladder δεν καθυστερεί ούτε ένα tick. Χωρίς την αναμονή το φίλτρο δεν έκοβε ποτέ
τίποτα και μια πηγή 480p με ladder `[480]` πλήρωνε ένα δεύτερο, ταυτόσημο rendition.

**`ertmp.js`** — monkey patch στο `Flv.parserTag` του nms. Το v4.2.8 αναγνωρίζει enhanced RTMP μόνο για av01/vp09/hvc1· το `avc1` του OBS πέφτει έξω από κάθε κλάδο και μένει με `flags=0` («audio sequence header»), οπότε το avcC δεν μπαίνει ποτέ στο `rtmpVideoHeader`. Όποιος συνδεθεί μετά τον publisher — δηλαδή και ο ffmpeg του HLS, που κοστίζει ένα spawn — δεν παίρνει ποτέ SPS/PPS.

**`r2.js`** — προαιρετικό, ενεργό μόνο αν `config.hls.r2.accessKeyId` δεν είναι κενό. Αλλάζει τη ροή του HLS σε δύο επίπεδα:

| | R2 off | R2 on |
|---|---|---|
| ffmpeg γράφει | στον φάκελο του stream | στο `<φάκελος>/ff/`, με `-hls_base_url` (απόλυτα URLs) |
| segments | σερβίρονται από τον static server | PUT στο R2 — **όσα προλάβουν** |
| playlists | τα ίδια αρχεία | τα γράφει το `r2.js` ένα επίπεδο πάνω, μετά τα uploads του γύρου |

Τα playlists μένουν πάντα στο origin — εκεί μετριούνται οι θεατές. Και ο κανόνας που κρατάει
όρθια την εκπομπή: **το playlist δεν περιμένει ποτέ το R2**. Κάθε γραμμή segment δείχνει στο
R2 αν ανέβηκε και στο δικό μας `ff/<name>.ts` αν δεν πρόλαβε (`localize`) — το R2 είναι
βελτιστοποίηση της κίνησης, ποτέ εξάρτηση της αναπαραγωγής.

Αυτό δεν είναι καλλωπισμός, είναι ο λόγος που ο σχεδιασμός δεν καταρρέει: όσο ο γύρος
δημοσίευε «όλα ή τίποτα», ένας γύρος πάνω από 2s άφηνε ένα segment πίσω, ο επόμενος έβρισκε
δύο και τα ξανάστελνε **παράλληλα** στην ίδια γραμμή, οπότε αργούσε κι άλλο. Θετική
ανάδραση: το playlist πάγωνε 12s (όσο το παράθυρο) και μετά πηδούσε με κενό. Γι' αυτό η
προθεσμία του PUT είναι όσο **ένα segment** (`SEGMENT_SEC` του ladder.js) και η προσπάθεια
**μία ανά segment**: μετά την αναδίπλωση, ένα δεύτερο PUT στέλνει bytes που κανείς δεν θα
ζητήσει από το R2, ακριβώς όταν το uplink χρειάζεται για να τα σερβίρει. Τα logs γράφουν τη
*μετάβαση* (δύο γραμμές ανά επεισόδιο), όχι ένα σφάλμα ανά segment — αλλιώς είναι δύο
γραμμές το δευτερόλεπτο ανά εκπομπή, ακριβώς όταν πρέπει να διαβαστούν. Η ίδια υποβάθμιση
φαίνεται και στο `/admin` του panel όσο συμβαίνει: κάθε πτώση αναφέρεται με το `onFallback`
→ `stats.js#addR2Fallback` → πεδίο `r2: { fallen, degraded }` ανά stream στο snapshot (το
`degraded` σβήνει με το πρώτο segment που όντως ανέβηκε· το πεδίο λείπει χωρίς R2) → badge
«ΕΚΤΟΣ R2». Το API δεν άλλαξε: αποθηκεύει το snapshot αυτούσιο.

Τα `uploaded`/`fromOrigin` κλαδεύονται στο ζωντανό παράθυρο — τα ονόματα είναι μοναδικά και
δεν ξαναγυρίζουν, οπότε χωρίς κλάδεμα μια 24/7 εκπομπή είναι διαρροή μνήμης. Γι' αυτό το
«πόσα έπεσαν» των logs είναι μετρητής του γύρου και **όχι** διαφορά μεγέθους του set:
κλάδεμα συν πτώση στον ίδιο γύρο θα έβγαζαν μηδέν και ψεύτικο «ξαναπρολαβαίνει». Segment
που λείπει από τον δίσκο (race με το rmSync του respawn) αντιμετωπίζεται σαν PUT που δεν
πρόλαβε: ο γύρος δημοσιεύει κανονικά — μία χαμένη ανάγνωση δεν σταματάει τα playlists των
variants που δεν φταίνε.

Η ουρά του `fs.watch` συγχωνεύεται: ένας γύρος τρέχει, **ένας** περιμένει. Ο γύρος διαβάζει
την κατάσταση από τον δίσκο, οπότε δέκα events και ένα βλέπουν το ίδιο πράγμα — ενώ με ABR
ο ffmpeg γράφει ένα playlist ανά variant σε κάθε segment και η αλυσίδα γέμιζε πιο γρήγορα
απ' όσο άδειαζε.

Ένας κανόνας για όλες τις περιπτώσεις: ό,τι `*.m3u8` βρεθεί στο `ff/` δημοσιεύεται με **το
ίδιο όνομα** στον φάκελο του stream (γι' αυτό ο ffmpeg γράφει εκεί με τα τελικά ονόματα).
Το master (`#EXT-X-STREAM-INF`) αντιγράφεται αυτούσιο — δείχνει σε *σχετικά*
ονόματα variants, που μένουν στο origin — και **μόνο αφού δημοσιευτεί το πρώτο variant**,
αλλιώς οι πρώτοι 2-4s δίνουν 404 σε variant που το master υπόσχεται. Τα variants ανεβαίνουν
με `allSettled`: ένα σκαλοπάτι που δεν ανεβαίνει δεν παγώνει τα υπόλοιπα, γιατί εκεί ακριβώς
πρέπει να πέσει ο θεατής.

**`relay.js`** — προαιρετικό, ενεργό μόνο για paths που έχουν προορισμούς στο
`clients.json`. Ένας `ffmpeg -c copy` ανά προορισμό, από το loopback RTMP προς
`rtmp(s)://…` — ό,τι κάνει το HLS job, με flv αντί για segments. **Καθόλου
`-bsf`**, σε αντίθεση με το ladder.js: το flv θέλει AVCC (ό,τι δίνει το RTMP),
ενώ το `h264_mp4toannexb` γυρίζει σε annex-b για το mpegts και θα έσπαγε τον
muxer. Ο stream server δεν ξέρει τι είναι «πλατφόρμα» ή «stream key»: παίρνει
έτοιμο URL, οπότε νέα πλατφόρμα = μηδέν γραμμές εδώ.
Το respawn είναι **αντίθετο** από του HLS: κλιμακούμενη αναμονή (2s→60s) και
ποτέ παραίτηση, γιατί ο πελάτης μπορεί να πατήσει «Go live» στο YouTube δέκα
λεπτά αφότου άρχισε να εκπέμπει σε εμάς — ένα relay που τα παράτησε δεν
ξανασηκώνεται χωρίς restart. Το `usableTarget` κρατάει τη μία εγγύηση που μόνο ο
stream server μπορεί να δώσει (ξέρει τη θύρα του): ποτέ relay πίσω στον εαυτό
μας, που θα ήταν βρόχος τροφοδοσίας. Ο υπόλοιπος έλεγχος —μορφή, ιδιωτικά
δίκτυα— ζει στο `apps/api/src/clients/destinations.ts`, εκεί που μπαίνει η
διεύθυνση.
Το `killFfmpeg` είναι κοινό με το `app.js` και δεν είναι καλλωπισμός: `kill()`
πάνω σε διεργασία που δεν ξεκίνησε ποτέ (λάθος `config.hls.ffmpeg`) έχει `pid`
`undefined`, το περνάει ως 0 στο `kill(2)` — δηλαδή «όλο το process group» — και
ο server σκοτώνει τον εαυτό του στο πρώτο `donePublish`, σιωπηλά.

**`stats.js`** — collector + admin HTTP server (δικό του `http.createServer` στο 8001, ξεχωριστό από του nms). Σημεία που δεν φαίνονται από ένα αρχείο:
- Οι RTMP/FLV θεατές βγαίνουν από τα events του nms· οι **HLS θεατές** από `prependListener("request")` πάνω στον HTTP server του nms, με cookie `nmsv` (fallback IP+User-Agent). Το `prepend` χρειάζεται για να προλάβει το `Set-Cookie` πριν απαντήσει ο express.
- Ό,τι έρχεται από `127.0.0.1` εξαιρείται — αλλιώς ο ffmpeg του HLS μετράει ως θεατής.
- Bitrate δεν υπάρχει στο API του v4: βγαίνει από διαφορά δύο δειγμάτων ανά 10s, με τα bytes των κλειστών sessions συσσωρευμένα (αλλιώς αρνητικό bitrate όταν φεύγει θεατής). Το πρώτο δείγμα κάθε stream μπαίνει στο `postPublish`, αλλιώς το dashboard δείχνει «0 bps» μέχρι το δεύτερο tick.
- Με R2 τα segments δεν περνάνε από εδώ, οπότε το `out_bps` είναι **εκτίμηση**: bytes segment × θεατές. Όσα πέφτουν σε αναδίπλωση όμως περνάνε κανονικά (`/live/x/ff/…​.ts`) και μετριούνται αληθινά — γι' αυτό το `trackHls` κόβει το `/ff` από το dirname, αλλιώς χρεώνονταν σε path χωρίς publisher, δηλαδή πουθενά. Το τρίτο κομμάτι του path είναι σκαλωσιά· το `/live/ff` είναι stream πελάτη που τυχαίνει να λέγεται έτσι. Με ABR ο πολλαπλασιαστής είναι οι θεατές **του συγκεκριμένου variant** (`variantSeen`, τρεφόμενος από τα requests σε `v*.m3u8` — το όνομα του segment λέει σε ποιο σκαλοπάτι ανήκει), αλλιώς κάθε segment μετριόταν σαν να το κατέβασαν όλοι, ×N. Ο `hlsSeen` και το `overLimit` **δεν** το ξέρουν καν: ο θεατής που αλλάζει σκαλοπάτι είναι ένας θεατής, με το ίδιο cookie στον ίδιο φάκελο.
- Basic auth **μέσα στην εφαρμογή**, με τον κωδικό του `config.json` — σκόπιμα όχι στον Caddy, ώστε να μην υπάρχει δεύτερο αντίγραφο του κωδικού που ξεχνιέται.
- Επιστρέφει `{ sample, snapshot, series, db, server }` για να το οδηγούν τα tests.

**`config.js`** — `config.json` (κατάσταση deployment, εκτός git), `data/passwords.json` (στο data volume, με migration από την παλιά ρίζα) και ο loader του `data/clients.json`. Το `app.js` γράφει το jwt secret στο `config.json` στο πρώτο boot· γι' αυτό το compose το κάνει bind mount.

**Πελάτες (`data/clients.json`)** — `{ πελάτης: { limit, paths: { "/live/x": "KEY" } } }`, η μόνη τοπική πηγή αλήθειας· το γράφει το `panel.js`, το διαβάζουν όλοι με 5s cache (το playlist ζητιέται κάθε 2s ανά θεατή — χωρίς cache ο δίσκος το καταλαβαίνει).
- Ο έλεγχος εκπομπής είναι δικός μας (`auth.publish: false`), σε **μία** συνάρτηση, την `publishAllowed`: την καλεί το `app.js` στο `postPublish` (τη στιγμή της σύνδεσης, με `session.rejected` ώστε να μην τον μετρήσει το `stats.js`) και το `stats.js` στο `sample()` (ανάκληση εν ώρα εκπομπής, ≤10s). Δύο αντίγραφα θα άφηναν τρύπα στο ένα από τα δύο σημεία.
- **Άγνωστο path = μπλόκο.** Ο διακόπτης της επιβολής είναι η **ύπαρξη** του αρχείου, όχι το περιεχόμενό του: αρχείο που λείπει ή χάλασε δεν ρίχνει τις εκπομπές (δρόμος αναδίπλωσης), αλλά ένα έγκυρο `{}` σημαίνει «κανένας πελάτης σε αυτόν τον server» και κλείνει τα πάντα — αλλιώς ένας server που μόλις μπήκε στο panel, ή του οποίου απενεργοποιήθηκαν όλοι οι πελάτες, θα γινόταν ορθάνοιχτος με το πρώτο sync. Γι' αυτό το `passwords.js` φτιάχνει πελάτη `default` στην πρώτη εγκατάσταση — αλλιώς καθαρός server χωρίς αρχείο ακόμα = ορθάνοιχτος server.
- Τα προαιρετικά πεδία μπαίνουν **δίπλα** στο `paths`, ποτέ μέσα του: `ladder`
  (της εγγραφής) και `relays` (χάρτης path → `[{name, url}]`, δες `relay.js`).
  Το `paths` είναι path→κλειδί και το διαβάζει η `publishAllowed`
  χαρακτήρα-χαρακτήρα — δεν αλλάζει σχήμα ο έλεγχος ασφαλείας για ένα
  προαιρετικό χαρακτηριστικό. Και τα δύο **λείπουν εντελώς** όταν δεν ισχύουν,
  ώστε το αρχείο των σημερινών πελατών να μένει byte-για-byte ίδιο.
- Το `limit` είναι αθροιστικό σε όλα τα paths **της εγγραφής** (μια εγγραφή = μια συνδρομή, δες apps/api) και επιβάλλεται στα δύο κανάλια αναπαραγωγής: `trackHls` (rewrite του `req.url` σε ανύπαρκτο αρχείο, γιατί δική μας απάντηση θα διπλογραφόταν με του express) και `postPlay`. Ο ήδη μετρημένος θεατής περνάει πάντα, και ο έλεγχος έρχεται **μετά** το `isLocal` — ο ffmpeg του HLS δεν κόβεται ποτέ από όριο, αλλιώς σταματά όλο το HLS του stream.
- Το προαιρετικό `ladder` (`[720, 480]`, δες PLAN-transcoding.md) το διαβάζει το `ladderOf` και **λείπει εντελώς** από τις εγγραφές χωρίς ABR, ώστε τα σημερινά αρχεία να μένουν ίδια. Διαβάζεται **μία φορά, στο `postPublish`**, και μένει σταθερό όσο ζει η εκπομπή — και στο respawn του ffmpeg, αλλιώς ένας ffmpeg που πέθανε θα γύριζε με άλλο σύνολο variants πάνω στα ίδια ονόματα αρχείων. Αλλαγή πλάνου εν ώρα εκπομπής δεν αξίζει 2-3s μαύρη οθόνη· η **ανάκληση** αντίθετα μένει άμεση (≤10s) — εκείνη είναι ασφάλεια, αυτό ποιότητα.

**`panel.js`** — προαιρετικό, ενεργό μόνο αν `config.panel.url` δεν είναι κενό (ίδιο μοτίβο με το `hls.r2.accessKeyId`). POST ανά 10s με το `snapshot()`, η απάντηση γράφεται με tmp+rename στο `clients.json` (ο loader διαβάζει σύγχρονα και δεν πρέπει να δει μισό JSON). Σφάλμα = log και τίποτα άλλο: panel κάτω δεν σημαίνει εκπομπές κάτω.

## apps/api

Το κεντρικό panel: NestJS, διαχειρίζεται πολλούς stream servers, πελάτες, paths, κλειδιά
εκπομπής και **πλάνα** — η άλλη άκρη του `panel.js` παραπάνω.

**Πλάνα και συνδρομές.** Ο κατάλογος (`Plan`) είναι ό,τι πουλάμε· η **συνδρομή**
(`Subscription`) είναι μία αγορά ενός πλάνου και η μονάδα των πάντων: δικός της server,
δικό της όριο θεατών, δικά της streams. Ο πελάτης έχει 0..Χ συνδρομές, καμία ιδιότητα
δική του και **κανένα άθροισμα** — δύο «basic» των 50 είναι δύο πλάνα των 50, όχι ένα
των 100 (γι' αυτό δεν υπάρχει ούτε `qty`: δύο αγορές = δύο γραμμές). Το `Path` κρέμεται
από τη συνδρομή, όχι από τον πελάτη — αλλιώς το όριο της συνδρομής δεν θα είχε πού να
επιβληθεί.

Η συνδρομή έχει και **φιλικό όνομα** (`Subscription.label`, προαιρετικό): δύο
αγορές του ίδιου πλάνου είναι αλλιώς δύο φορές «basic», και επειδή το όριο θεατών
είναι της συνδρομής, ο πελάτης δεν έχει κανέναν τρόπο να δει ποια streams το
μοιράζονται. Το γράφουν και οι δύο πλευρές — ο admin (`PATCH
/clients/:id/subscriptions/:subId`) και ο ίδιος ο πελάτης (`PATCH
/me/subscriptions/:id`, μόνο το `label`· η αναστολή μένει εμπορική απόφαση).

**Ο stream server δεν άλλαξε ούτε γραμμή** και δεν ξέρει τι είναι πλάνο: το sync γράφει
**μία εγγραφή ανά συνδρομή** αντί για μία ανά πελάτη (κλειδί `όνομα#idΣυνδρομής`), και
επειδή ο stream server ομαδοποιεί τους θεατές ανά εγγραφή του `clients.json`
(`config.js#clientOf`, `stats.js#overLimit`), το όριο του κάθε πλάνου επιβάλλεται μόνο του
στα δικά του paths. Το όριο streams μετράει paths και επιβάλλεται μόνο στο
`POST /clients/:id/paths`. Η **αναστολή** (`Subscription.disabled`, ξεχωριστά από το
`Client.disabled` που τα κόβει όλα) δουλεύει με το ίδιο κόλπο: η εγγραφή λείπει από το
clients.json, άρα άγνωστο path = μπλόκο σε ≤10s, χωρίς να χαθεί path ή κλειδί.

**Τι παγώνει στην αγορά:** ο **server**, όχι τα όρια — ούτε καν το ίδιο το πλάνο,
που αλλάζει επιτόπου με `PATCH /clients/:id/subscriptions/:subId {planId}`
(αναβάθμιση/υποβάθμιση χωρίς να χαθούν paths και κλειδιά· 409 όταν τα streams που
υπάρχουν δεν χωράνε στο νέο πλάνο, γιατί ποιο θα κοπεί δεν το αποφασίζει το API).
Ο server όμως δεν ακολουθεί το νέο πλάνο: τα paths ζουν πάνω του. Το `Plan.serverId` λέει πού πέφτουν
οι επόμενες συνδρομές· η κάθε συνδρομή κρατάει το δικό της στιγμιότυπο, οπότε γεμίζει ο
stream1, γυρνάς το basic στον stream2, και μετακομίζει μόνο ο επόμενος που θα αγοράσει.
Τα όρια αντίθετα διαβάζονται ζωντανά από το πλάνο — μία αλλαγή στον κατάλογο τα ενημερώνει
όλα. Το ίδιο ισχύει και για το **`Plan.ladder`** (csv από ύψη, δες PLAN-transcoding.md): ο
κλειστός κατάλογος υψών επικυρώνεται εδώ γιατί ο stream server έχει σταθερό bitrate ανά ύψος
— ύψος εκτός πίνακα θα έσκαγε την ώρα της εκπομπής αντί για την ώρα της αποθήκευσης. Πλήρες
συμβόλαιο των endpoints στο [apps/api/README.md](apps/api/README.md), δεν το ξαναγράφουμε
εδώ.

**Αναδιανομή (`Destination`).** Ο πελάτης κολλάει το Stream URL και το key του
καναλιού του (YouTube, Facebook, Twitch…) και ο stream server σπρώχνει εκεί την
ίδια εκπομπή. Ο προορισμός κρέμεται από το **path** και όχι από τη συνδρομή —
κάθε κάμερα πάει στο δικό της κανάλι. Το όριο (`Plan.maxRelays`) μετριέται ανά
stream και είναι το **μόνο** όριο του σχήματος όπου το `0` σημαίνει «καθόλου»
αντί για «χωρίς όριο»: απεριόριστα αντίγραφα της εκπομπής προς τα έξω δεν
πουλιούνται, ενώ «κανένα» είναι η σωστή προεπιλογή για κάθε πλάνο που υπήρχε
πριν. Το `destinations.ts` είναι το μοναδικό σημείο όπου το API δέχεται
**διεύθυνση δικτύου από τον χρήστη** και τη δίνει σε μηχάνημα δικό μας να τη
συνδεθεί — γι' αυτό κόβει ό,τι δεν είναι rtmp/rtmps και ό,τι δείχνει σε
loopback ή ιδιωτικό δίκτυο. Το `enabled: false` **δεν** πέφτει σε ≤10s όπως η
αναστολή συνδρομής: οι προορισμοί διαβάζονται στην αρχή της εκπομπής, οπότε
ισχύει από την επόμενη.

Sqlite με Prisma 6 (**όχι 7** — θα έφερνε driver adapters για ένα σχήμα λίγων πινάκων), και
`prisma db push` σε **κάθε boot** αντί για migrations: δεν υπάρχει migrations directory, το
`schema.prisma` είναι η μόνη πηγή αλήθειας — αρκεί όσο το σχήμα δεν έχει ιστορικό αλλαγών σε
production. Auth σε τρία επίπεδα και κανένα passport: JWT (`@nestjs/jwt`) για χρήστες
(admin/customer, global guard εκτός `@Public()`), **API key** (`ApiKey`, πρόθεμα `pk_`,
sha256) για εξωτερικές υπηρεσίες που κάνουν provisioning, και static bearer token ανά
server μόνο για το `POST /servers/:host/sync` — ο stream server δεν συνδέεται ποτέ σαν
χρήστης. Το API key το αναγνωρίζει ο **ίδιος** guard από το πρόθεμα και γράφει το ίδιο
`req.user` με `role: "admin"`: έτσι `@Roles`, `/me` και ό,τι άλλο διαβάζει το `req.user`
δεν ξέρουν καν ότι υπάρχει δεύτερος τρόπος εισόδου. Πάνω σε αυτά, το `POST
/auth/login-link` δίνει **link σύνδεσης** για το billing (redirect του πελάτη στο panel
χωρίς κωδικούς): βραχύβιο (5') JWT μιας χρήσης με `once: true`, που το `POST
/auth/exchange` ανταλλάσσει με κανονική 12ωρη συνεδρία — δύο tokens, γιατί ένα θα ήταν ή
συνεδρία πέντε λεπτών ή link δώδεκα ωρών, και το `once` εμποδίζει την επ' άπειρον
ανανέωση συνεδρίας από το `exchange`. Τα ξοδεμένα `jti` ζουν στη μνήμη (πίνακας sqlite
για δεδομένα πέντε λεπτών δεν αξίζει). Κωδικοί
με `node:crypto` `scryptSync`/`timingSafeEqual`, όχι bcrypt — καμία native εξάρτηση στο
image. Tests: `nest build` πρώτα, μετά σκέτο `node --test` πάνω στο compiled output
(`dist/test/*.js`) — ίδια φιλοσοφία με τα `test-*.js` του `apps/stream`, όχι jest/supertest.

Τα live snapshots (`GET /live`) ζουν **μόνο στη μνήμη** — μετά από restart του API είναι
άδεια μέχρι το επόμενο sync tick (≤10s) από κάθε server. Δεν αποθηκεύονται στη sqlite: το
ιστορικό (series) το κρατάει ήδη κάθε stream server στο δικό του `stats.db` και το API κάνει
proxy σε αυτό, δεν το αντιγράφει κεντρικά.

## apps/panel

Nuxt SPA, `ssr: false` + `nuxt generate` → στατικά αρχεία (δες `apps/panel/Dockerfile`,
`apps/api/Caddyfile`) — κανένα Node runtime για το UI, το build τρέχει μόνο στο image του
Caddy. Τα SVG γραφήματα του `/admin` (`app/utils/dash.ts`) είναι μεταφορά αυτούσια από το
παλιό `admin/dashboard.html`. Κάλυψη admin (`/admin/*`: servers, clients,
live streams όλων των servers) και customer (`/`: τα streams του πελάτη **ομαδοποιημένα ανά
συνδρομή** — το όριο θεατών ανήκει στη συνδρομή, οπότε στέκεται στην κεφαλίδα της
ομάδας και όχι δίπλα σε κάθε stream· ο τίτλος είναι το `label` της, με fallback
«Πακέτο ν» κατά σειρά αγοράς — stream key έτοιμο
για αντιγραφή, κατάσταση εκπομπής και γραφήματα 1ώρας/24ώρου/7ημερών/30ημερών — ο
κατάλογος των διαστημάτων είναι το `RANGES` του `dash.ts`, κοινός με το `/admin` και
καθρέφτης του `RANGES` του `stats.js`) στην ίδια εφαρμογή — δες
PLAN-monorepo.md για το γιατί όχι δύο apps. Το `/account` είναι κοινό στους δύο
ρόλους (`PATCH /auth/me`): ο πελάτης αλλάζει μόνος τα στοιχεία σύνδεσής του και ο
admin τον κωδικό που του έδωσε το `seed` — δεν υπάρχει δεύτερος admin να του κάνει
reset. Ο κωδικός **πελάτη** αλλάζει και από το `/admin/clients` (ο admin ορίζει νέο
χωρίς να ξέρει τον παλιό).

**Είσοδος ως πελάτης** (`/admin/clients`): ο admin βλέπει το panel του πελάτη χωρίς
να αποσυνδεθεί. Καμία γραμμή στο API — ξοδεύει επιτόπου το `POST /auth/login-link`
που υπάρχει ήδη για το billing, και φυλάει το δικό του token σε δεύτερο κλειδί του
localStorage (`useApi.ts`). Η αλλαγή συνεδρίας γίνεται με **πλήρη φόρτωση**: το
token δεν είναι reactive, με client-side navigation το layout κρατούσε το παλιό
μενού και σήμα ρόλου. Ο έλεγχος του `/admin/*` μένει ως έχει — όσο βλέπεις ως
πελάτης η συνεδρία *είναι* πελάτη, οπότε κόβεται σωστά· η μόνη επιστροφή είναι η
μπάρα του layout.

**Nuxt UI v4** (Tailwind v4 από κάτω) για ό,τι είναι διεπαφή: header/πλοήγηση, κάρτες,
φόρμες, badges, ειδοποιήσεις. Το `app/assets/dashboard.css` κράτησε μόνο ό,τι δεν δίνει
έτοιμο — τα πλέγματα της κάρτας εκπομπής, τα γραφήματα, τους πίνακες — και τα χρώματά του
**δείχνουν** στα `--ui-*` tokens: μία παλέτα, ένα dark mode. Το dark mode είναι η κλάση
`.dark` του color-mode και όχι `prefers-color-scheme`, αλλιώς ο διακόπτης θέματος στο
header άλλαζε τα components και άφηνε γραφήματα και πίνακες στο θέμα του λειτουργικού.
Οι πίνακες μένουν σκέτα `<table>` (όχι `UTable`): στατικές λίστες χωρίς ταξινόμηση ή
σελιδοποίηση, το TanStack από κάτω θα ήταν εξάρτηση χωρίς αντίκρισμα.

Το πλάτος της σελίδας το δίνει το `UContainer` με `--ui-container: 100rem` — κάτω από αυτό
τα νούμερα δίπλα στο preview σπάνε σε δύο σειρές, πάνω από αυτό τα charts γίνονται σύρματα.
Τα κατώφλια του `.body` (preview δίπλα ή πάνω από τα πεδία) είναι **container queries**, όχι
media queries: με δύο κάρτες δίπλα-δίπλα η στήλη είναι στενή ακόμα και σε μεγάλη οθόνη.

Δύο συστήματα γραφημάτων, σκόπιμα: το `/admin` κρατάει το `lineChart` του `dash.ts` (SVG,
πολλές γραμμές ανά chart, cross-hair), το user panel ζωγραφίζει με **Chart.js**
(`app/components/MiniChart.vue`, μία γραμμή ανά chart). Το Chart.js μπαίνει με ρητό
`Chart.register` μόνο των controllers που χρησιμοποιούμε, και ο άξονας x είναι `linear` με
unix seconds — όχι `TimeScale`, που θα ζητούσε date adapter σαν δεύτερη εξάρτηση. Ο canvas
δεν δέχεται `var(--s2)`: το `MiniChart` λύνει τα CSS variables με `getComputedStyle` σε κάθε
render, αλλιώς το dark mode βγάζει αόρατες γραμμές.

Auth: JWT σε localStorage (`POST /auth/login` του `apps/api`) και ένα global middleware
που κόβει την πρόσβαση σε `/admin/*` χωρίς ρόλο admin. Ο πραγματικός έλεγχος είναι στο
API — το middleware εδώ απλώς δεν δείχνει άδειες οθόνες πριν έρθει το 401.

Series/sessions/restart είναι πάντα **ανά server** (`GET /servers/:host/...`), όχι
συγκεντρωτικά: ζουν στο sqlite του κάθε stream server και το `apps/api` κάνει proxy, δεν τα
αντιγράφει κεντρικά (ίδιο σκεπτικό με το `GET /live` — δες «apps/api» παραπάνω).

Ο πελάτης **δεν** αγγίζει αυτά τα endpoints (είναι `@Roles('admin')` — θα έβλεπε τα streams
των συγκατοίκων του στον ίδιο server): το `GET /me/series` κάνει το ίδιο proxy και κρατάει
μόνο τα paths του `clientId` του token, χωρίς το `server` block (CPU/μνήμη του μηχανήματος).

## Deploy

Ένα `apps/stream/install <hostname> [--docker]` για bare metal (caddy + volta + pm2) και Docker (compose με caddy container). Ένα `Caddyfile` και για τα δύο — το `STREAM_HOST` πέφτει σε `localhost` χωρίς Docker. Τα `header` directives θέλουν **`defer`**, αλλιώς προστίθεται από πάνω το `Cache-Control` του `express.static` και βγαίνουν δύο τιμές στην ίδια απόκριση.

Ό,τι αφορά **μόνο ένα** μηχάνημα (GPU devices, `NVIDIA_DRIVER_CAPABILITIES`, ο iHD driver
μέσω του build arg `EXTRA_PKGS` του Dockerfile) ζει σε `apps/stream/docker-compose.override.yml`,
που είναι στο `.gitignore`: στο κοινό compose ένα `devices: /dev/dri` ή ένας nvidia driver
θα έσκαγε κάθε `up` σε απλό VPS, και μια τοπική αλλαγή στο tracked Dockerfile θα ζητούσε
merge σε κάθε `git pull` της ενημέρωσης. Το ffmpeg του image έχει ήδη χτισμένους τους
nvenc/qsv/vaapi — λείπει πάντα μόνο ο runtime driver.

`.m3u8` → ποτέ cache (αλλιώς σπάει η μέτρηση θεατών). `.ts` → immutable. Το `rtmp.<domain>` πρέπει να είναι DNS only στο Cloudflare — το proxy δεν περνάει το 1935.
