# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Γλώσσα

Τα σχόλια στον κώδικα, το README και τα μηνύματα των commits είναι **στα ελληνικά**. Κράτα το ίδιο ύφος: το σχόλιο εξηγεί *γιατί*, όχι *τι*.

## Εντολές

```bash
cp config.example.json config.json  # απαραίτητο πριν από οτιδήποτε άλλο
npm start                           # node app.js
npm test                            # test-stats.js && test-r2.js && test-passwords.js
node test-stats.js                  # ένα μόνο test — σκέτα node scripts, χωρίς framework
npm run test-stream [-- <rtmp host>] # δοκιμαστική εκπομπή με ffmpeg testsrc, χωρίς OBS
npm run generate-passwords <hostname>  # γράφει κωδικούς σε config.json + data/passwords.json
```

Θέλει **Node 24** (το `node:sqlite` του `stats.js`) — pinned στο volta. Σε Docker: `docker compose exec stream npm test`.

Τα tests είναι `assert`-based scripts με χειροποίητα mocks (δες το fake `nms` στην αρχή του `test-stats.js`, το `globalThis.fetch` override στο `test-r2.js`). Νέο test = νέο `test-*.js` + μια γραμμή στο `npm test`.

## Αρχιτεκτονική

Λεπτό wrapper γύρω από το `node-media-server` v4. Τα τρία πράγματα που δεν κάνει το v4 και τα κάνουμε εμείς: HLS, στατιστικά, admin UI.

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

**`config.js`** — `config.json` (κατάσταση deployment, εκτός git) και `data/passwords.json` (στο data volume, με migration από την παλιά ρίζα). Το `app.js` γράφει το jwt secret στο `config.json` στο πρώτο boot· γι' αυτό το compose το κάνει bind mount.

**`admin/`** — δύο στατικά HTML (dashboard + hls.js player) που σερβίρει το `stats.js` από το `PAGES` map και τρέφονται από `/admin/api/{live,series,sessions}`.

## Deploy

Ένα `./install <hostname> [--docker]` για bare metal (caddy + volta + pm2) και Docker (compose με caddy container). Ένα `Caddyfile` και για τα δύο — το `STREAM_HOST` πέφτει σε `localhost` χωρίς Docker. Τα `header` directives θέλουν **`defer`**, αλλιώς προστίθεται από πάνω το `Cache-Control` του `express.static` και βγαίνουν δύο τιμές στην ίδια απόκριση.

`.m3u8` → ποτέ cache (αλλιώς σπάει η μέτρηση θεατών). `.ts` → immutable. Το `rtmp.<domain>` πρέπει να είναι DNS only στο Cloudflare — το proxy δεν περνάει το 1935.
