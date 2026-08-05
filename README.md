# Node Media Server

## Αυτόματη εγκατάσταση

Αντικατάστησε το `server.example.com` με το hostname του server σου:
```bash
apt update
apt install git -y
git clone https://github.com/pointergr/node-media-server.git
cd node-media-server
git checkout master
./install server.example.com
```

## Docker

```bash
docker build -t nms .

docker run -d --name stream --restart unless-stopped \
  -p 1935:1935 \
  -p 8000:8000 \
  -p 127.0.0.1:8001:8001 \
  -v $PWD/config.json:/app/config.json \
  -v nms-media:/app/media \
  -v nms-data:/app/stats.db \
  nms
```

Πριν το πρώτο run, στο `config.json` βάλε `"admin": { "host": "0.0.0.0", ... }`. Το loopback
μέσα στο container είναι του container — χωρίς αυτό ο Caddy του host δεν φτάνει ποτέ στο
admin UI. Η έκθεση την κρατάει το `-p 127.0.0.1:8001:8001`: η θύρα δένεται μόνο στο loopback
του host, ακριβώς όπως και χωρίς Docker.

Τα τρία volumes είναι απαραίτητα:

| Volume | Γιατί |
|---|---|
| `config.json` | ο server γράφει μέσα το jwt secret στο πρώτο boot — χωρίς mount χάνεται σε κάθε recreate και ακυρώνονται όλα τα tokens |
| `/app/media` | τα HLS segments· χωρίς R2 σερβίρονται από εδώ |
| `/app/stats.db` | τα στατιστικά 30 ημερών |

Ο Caddy μένει στο host, με το ίδιο ακριβώς Caddyfile — δείχνει σε `localhost:8000` και
`localhost:8001`, που τώρα είναι published ports του container. Το `ufw` το ίδιο.

Οι κωδικοί βγαίνουν μία φορά, πριν σηκωθεί το container:

```bash
docker run --rm -v $PWD:/app -w /app node:24-slim \
  sh -c "npm install --omit=dev && npm run generate-passwords stream.example.com"
```

## Χειροκίνητη εγκατάσταση
Άνοιξε έναν server.

Πρέπει να έχεις ένα πραγματικό URL που να δείχνει στον server (A Record).
Παρακάτω θα χρησιμοποιήσουμε το υποθετικό `stream.example.com`.

Χρειάζονται **δύο** A Records στην ίδια IP, με διαφορετικό ρόλο το καθένα:

| Record | Ρόλος | Cloudflare |
|---|---|---|
| `rtmp.stream.example.com` | εκπομπή — εδώ στέλνει το OBS (RTMP, 1935) | **DNS only** (γκρι) |
| `stream.example.com` | playlist, FLV, admin | proxied (πορτοκαλί) |

Το `rtmp.` πρέπει να μείνει DNS only: το Cloudflare proxy περνάει μόνο HTTP(S) ports,
οπότε με πορτοκαλί σύννεφο το publish στο 1935 δεν φτάνει ποτέ στον server.

Με [R2](#segments-στο-r2-προαιρετικό-αλλά-ο-σωστός-τρόπος) προστίθεται και τρίτο hostname,
`media.stream.example.com`, για τα `.ts` — αυτό όμως **δεν** το φτιάχνεις εσύ, το βάζει
μόνο του το R2 ως CNAME όταν κάνεις Connect Domain.

Αν λείπει το `rtmp.` record, ο Caddy δεν μπορεί να βγάλει certificate γι' αυτό και
γεμίζει τα logs με ACME errors.

### Εγκατάσταση πακέτων στο λειτουργικό
```bash
apt update
apt install caddy git ffmpeg ufw
```

### Ενεργοποίηση του firewall
```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw allow 8000
ufw allow 1935
ufw default deny incoming
ufw default allow outgoing
ufw enable
```

### Ρύθμιση Caddy (άλλαξε το `stream.example.com` με το σωστό URL)
```bash
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

cat <<EOF > /etc/caddy/Caddyfile
{
        # runtime errors: certificates, ACME, config
        log {
                output file /var/log/caddy/error.log
                level ERROR
        }
}

# Χωρίς scheme ο Caddy εξυπηρετεί και τα δύο: βγάζει μόνος του certificate, ακούει
# στο 443 και κάνει redirect 80->443. Θέλει Cloudflare SSL mode Full — με Flexible
# το CF χτυπάει το origin σε http και ο redirect γίνεται loop.
stream.example.com, rtmp.stream.example.com {
        # Το admin UI ακούει μόνο στο loopback — το auth το κάνει εδώ ο Caddy
        handle /admin* {
                # basicauth, όχι basic_auth: το νέο όνομα δεν υπάρχει πριν τον Caddy 2.8,
                # ενώ το παλιό δουλεύει και στις δύο (με deprecation warning στις νέες)
                basicauth {
                        admin <hash από: caddy hash-password --plaintext "<admin password>">
                }
                reverse_proxy localhost:8001
        }

        handle {
                reverse_proxy localhost:8000
        }

        # HLS: το playlist δεν πρέπει ποτέ να κασάρεται, τα segments είναι immutable
        @m3u8 path *.m3u8
        @ts path *.ts
        header @m3u8 Cache-Control "no-store"
        header @ts Cache-Control "public, max-age=31536000, immutable"

        # Οι online HLS players τρέχουν σε άλλο origin — χωρίς αυτό το hls.js
        # μπλοκάρεται από τον browser και δεν βλέπει ούτε segments ούτε bitrates
        @hls path *.m3u8 *.ts
        header @hls Access-Control-Allow-Origin "*"

        log {
                output file /var/log/caddy/access.log
        }
}
EOF
```

### Logs του Caddy
```bash
tail -f /var/log/caddy/error.log     # certificates, ACME, config
tail -f /var/log/caddy/access.log    # requests, 4xx/5xx
journalctl -u caddy -f               # ό,τι σκάει πριν φορτώσει το config
```
Ο Caddy κάνει μόνος του rotate (100MiB ανά αρχείο, 10 αρχεία, 90 μέρες) — δεν θέλει logrotate.

### Εγκατάσταση του Volta
```bash
curl https://get.volta.sh | bash
source ~/.bashrc
volta install node@20
volta install npm@bundled
```

### Εγκατάσταση του stream server
```bash
git clone git@github.com:pointergr/node-media-server.git
cd node-media-server
npm install
```

### Εγκατάσταση του pm2
```bash
npm install pm2 -g
source ~/.bashrc
```

### Παραγωγή κωδικών
```bash
npm run generate-passwords stream.example.com
```

### Ξεκινώντας τον server σαν pm2 process
```bash
pm2 start app.js --name stream
```

### Για επανεκκίνηση του stream εκτελούμε
```bash
pm2 restart stream
```

### Για logs του stream εκτελούμε
```bash
pm2 logs stream
```

## HLS

Το node-media-server v4 δεν κάνει transcoding — το HLS το βγάζει το `app.js` σπρώχνοντας ένα
`ffmpeg -c copy` (remux, όχι transcode) ανά stream όταν ξεκινάει το publish, και το σταματάει
όταν κλείνει. Τα segments γράφονται στο `./media/<app>/<name>/` και σερβίρονται από τον static
server του v4:

```
https://stream.example.com/live/stream/index.m3u8
```

Θέλει keyframe interval ≤ 2s στον encoder (OBS: Output → Keyframe Interval = 2), αλλιώς τα
segments βγαίνουν μεγαλύτερα από το `hls_time` και αυξάνει το latency. Το path του ffmpeg
ρυθμίζεται στο `config.json` (`hls.ffmpeg`). Λάθη του ffmpeg φαίνονται στο `pm2 logs stream`.

### Segments στο R2 (προαιρετικό, αλλά ο σωστός τρόπος)

Το ToS 2.8 της Cloudflare απαγορεύει το σερβίρισμα βίντεο μέσω του CDN σε non-Enterprise
plan — δηλαδή ακριβώς το κασάρισμα των `.ts`, που όμως είναι όλο το bandwidth. Το R2 δεν
είναι CDN αλλά storage με μηδενικό egress· το να φεύγει βίντεο από R2 custom domain είναι
η προβλεπόμενη χρήση του.

Γι' αυτό σπάμε το HLS στα δύο:

| | Πού | Γιατί |
|---|---|---|
| `index.m3u8` | origin, όπως και πριν | ψίχουλα bytes, ήδη bypass cache — δεν αγγίζει το 2.8 |
| `*.ts` | R2 + custom domain | εδώ είναι το 100% του bandwidth |

Το playlist **πρέπει** να μείνει στο origin: πάνω στα requests του μετράμε τους θεατές
(δες [Admin UI](#admin-ui)). Αν πήγαινε κι αυτό στο R2, το admin UI θα έδειχνε μόνιμα μηδέν.

Ρύθμιση στο Cloudflare:

1. R2 → Create bucket (π.χ. `stream`).
2. Settings → **Public access → Connect Domain**: `media.stream.example.com` (χωριστό
   subdomain από το `stream.example.com` — προστίθεται αυτόματα ως CNAME).
3. Settings → **CORS Policy**: `AllowedOrigins: ["*"]`, `AllowedMethods: ["GET"]`. Χωρίς
   αυτό ο browser μπλοκάρει τα segments, επειδή το playlist έρχεται από άλλο origin.
4. Settings → **Object lifecycle rules**: delete μετά από 1 μέρα. Τα segments είναι
   εφήμερα· χωρίς τον κανόνα το bucket μεγαλώνει για πάντα.
5. Manage R2 API Tokens → **Object Read & Write** token για το bucket.

Και στο `config.json`:

```json
"hls": {
  "ffmpeg": "/usr/bin/ffmpeg",
  "r2": {
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket": "stream",
    "accessKeyId": "<από το API token>",
    "secretAccessKey": "<από το API token>",
    "publicUrl": "https://media.stream.example.com"
  }
}
```

Άδειο `accessKeyId` σημαίνει R2 off: τα segments σερβίρονται από τον ίδιο τον server, όπως πριν.

Πώς δουλεύει (`r2.js`): ο ffmpeg γράφει το playlist του σε `ff.m3u8` με απόλυτα URLs
(`-hls_base_url`), το `r2.js` ανεβάζει τα segments που δείχνει και **μετά** το δημοσιεύει
ως `index.m3u8`. Αν γινόταν ανάποδα, ο player θα ζητούσε από το R2 segment που δεν έχει
ανέβει ακόμα — το R2 είναι strongly consistent, οπότε μετά το upload είναι αμέσως εκεί.

Κόστος σε latency: μόνο ο χρόνος του upload, ~100–300 ms για segment των 2s. Αν ένα PUT
αργήσει πάνω από 2 δευτερόλεπτα, τα uploads μένουν πίσω και το latency μεγαλώνει μόνιμα —
βγαίνει warning στο `pm2 logs stream`. Έλεγχος: `node test-r2.js`.

### Cloudflare cache rules

Ο Caddyfile βάζει ήδη τα σωστά `Cache-Control`. Στο Cloudflare (Caching → Cache Rules)
χρειάζονται τρεις κανόνες με **αμοιβαία αποκλειόμενα** expressions, ώστε να μην παίζει
ρόλο η σειρά τους:

| # | Expression | Ρύθμιση |
|---|---|---|
| 1 | `ends_with(http.request.uri.path, ".ts")` | **Μόνο χωρίς R2:** Eligible for cache · Edge TTL: use origin cache-control |
| 2 | `ends_with(http.request.uri.path, ".m3u8")` | **Bypass cache** |
| 3 | `ends_with(http.request.uri.path, ".flv") or starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/admin")` | **Bypass cache** |

Γιατί:

- **`.ts` — κασάρισέ τα, αν δεν έχεις R2.** Εδώ είναι όλο το bandwidth. Είναι ασφαλές επειδή
  κάθε publish γράφει segments με μοναδικό prefix (`<timestamp>-0.ts`), οπότε ένα όνομα δεν
  ξαναχρησιμοποιείται ποτέ για διαφορετικό περιεχόμενο. Με R2 ο κανόνας φεύγει εντελώς: τα
  segments δεν περνάνε καν από αυτό το domain.
- **`.m3u8` — ποτέ.** Ξαναγράφεται κάθε ~2 δευτερόλεπτα. Ακόμα και 10 δευτερόλεπτα cache
  σημαίνει ότι ο player ζητάει segments που έχουν ήδη σβηστεί, δηλαδή 404 και κόλλημα.
  Είναι επίσης προϋπόθεση για τη μέτρηση θεατών: κάθε request στο playlist πρέπει να
  φτάνει στο origin, αλλιώς το admin UI δείχνει μηδέν θεατές (δες [Admin UI](#admin-ui)).
  Και το `Set-Cookie` του πρώτου request δεν πρέπει ποτέ να κασαριστεί, αλλιώς πολλοί
  players μοιράζονται το ίδιο cookie και μετράνε ως ένας.
- **`.flv` — ποτέ.** Είναι ατέρμονο chunked response· αν το πιάσει κανόνας τύπου
  «Cache Everything», το Cloudflare προσπαθεί να το ολοκληρώσει και ο player δεν ξεκινάει ποτέ.
- **`/api/`, `/admin` — ποτέ.** Δυναμικά, και το `/admin` έχει credentials.

Εκτός των rules:

- Caching → Configuration → Browser Cache TTL: **Respect Existing Headers**. Αλλιώς το
  Cloudflare επιβάλλει δικό του TTL στον browser και ακυρώνει το `no-store` του playlist.
- **Tiered Cache: On** — με πολλούς θεατές μειώνει αισθητά τα requests στο origin. Σε
  αντάλλαγμα, τα segments που σερβίρει το edge δεν μετράνε στο bitrate εξόδου του admin UI —
  το πραγματικό bandwidth προς τους θεατές το δείχνει το dashboard της Cloudflare.
- Το `rtmp.` υποdomain δεν αφορά καθόλου το cache: είναι DNS only, δεν περνάει από το Cloudflare.
- Ποτέ «Cache Everything» σε όλο το domain, ποτέ Edge TTL override στα `.m3u8`.

Το κασάρισμα των `.ts` στο CDN αντιβαίνει στο ToS 2.8 της Cloudflare σε non-Enterprise plan —
η καθαρή λύση είναι το [R2](#segments-στο-r2-προαιρετικό-αλλά-ο-σωστός-τρόπος).

## Admin UI

Στο `https://stream.example.com/admin` (χρήστης `admin`, ο κωδικός από το
`generate-passwords`). Το v4 δεν έχει δικό του panel — αυτό είναι δικό μας.

Δείχνει ενεργά streams (θεατές, bitrate, codec, ανάλυση, διάρκεια), γραφήματα για
1h / 24h / 7d / 30d, ενεργές συνδέσεις με κουμπί kill, και log πρόσφατων συνδέσεων.

Πώς δουλεύει:

- Ο collector στο `stats.js` κρεμιέται στα events του server και κρατάει δείγμα κάθε
  60 δευτερόλεπτα σε SQLite (`stats.db`), με διατήρηση 30 ημερών. Το bitrate δεν υπάρχει
  πουθενά στο API του v4 — βγαίνει από τη διαφορά δύο δειγμάτων.
- Το UI σερβίρεται από δικό μας HTTP server στο `127.0.0.1:8001`. **Δεν** ακούει σε
  εξωτερικό interface, οπότε δεν χρειάζεται άνοιγμα στο ufw· περνάει μόνο μέσω Caddy,
  που κάνει και το basic_auth.
- Το ffmpeg του HLS συνδέεται ως θεατής στο 127.0.0.1 και εξαιρείται από τα στατιστικά,
  αλλιώς κάθε stream θα έδειχνε έναν φανταστικό θεατή παραπάνω.
- Το HLS σερβίρεται ως στατικά αρχεία (`express.static`), χωρίς session και χωρίς events.
  Οι θεατές του μετριούνται από τα requests στο `index.m3u8`: στο πρώτο request ο server
  βάζει cookie `nmsv` και μετά μετράει ένα θεατή ανά cookie, ενεργό για 30 δευτερόλεπτα
  μετά το τελευταίο request. Έτσι δύο συσκευές πίσω από το ίδιο NAT μετράνε σωστά ως δύο.
  Το `no-store` του Caddy στα `.m3u8` είναι προϋπόθεση — αν κασαριστεί το playlist,
  τα requests δεν φτάνουν καν εδώ.
- Client που δεν κρατάει cookies (`wrk`, `curl`, player σε άλλο origin που δεν στέλνει
  credentials) μετράει με την IP του, οπότε ένα load test από ένα μηχάνημα δείχνει έναν
  θεατή όσα connections κι αν ανοίξει. Η IP βγαίνει από το `X-Forwarded-For` του Caddy.
- Τα bytes των segments προστίθενται στο bitrate εξόδου του stream. Με ενεργό CDN cache
  στα `.ts` ένα μέρος τους δεν φτάνει στο origin και το out_bps βγαίνει μικρότερο — και με
  R2 πέφτει σχεδόν στο μηδέν, αφού τα segments δεν περνάνε καθόλου από εδώ. Ο αριθμός των
  θεατών παραμένει σωστός· το πραγματικό bandwidth το δείχνουν τα R2 metrics.

Το `stats.db` είναι στο `.gitignore`. Έλεγχος του collector: `node test-stats.js`.

## Demo player

Στο `https://stream.example.com/admin/player` — πίσω από το ίδιο basic auth με το admin UI.
Κλικ στο όνομα ενός ενεργού stream στο admin το ανοίγει απευθείας.

Παίζει το `<stream>/index.m3u8` με [hls.js](https://github.com/video-dev/hls.js) από CDN
(σε Safari με το native HLS του browser) και ξαναδοκιμάζει κάθε 3 δευτερόλεπτα όσο δεν
εκπέμπει κανείς — μπορείς να την αφήσεις ανοιχτή και να ξεκινήσεις το OBS μετά.
Το stream path αλλάζει από το πεδίο πάνω δεξιά ή από το `?stream=`:

```
https://stream.example.com/admin/player?stream=/live/stream
```

Ο preview μετράει ως κανονικός θεατής στα στατιστικά — είναι ο ευκολότερος τρόπος να
επαληθεύσεις ότι δουλεύει η μέτρηση, αλλά μην τον αφήνεις ανοιχτό όταν κοιτάς νούμερα.

## Admin API

Το v4 άλλαξε το API: `/api/v1/{health,info,streams,sessions,stats}` με JWT αντί για basic auth.
Το login είναι challenge-response σε δύο βήματα (δεν ταξιδεύει ποτέ ο κωδικός):

```bash
CHALLENGE=$(curl -s -X POST https://stream.example.com/api/v1/login \
  -H "Content-Type: application/json" -d '{"username":"admin"}' | jq -r .data.challenge)

RESPONSE=$(echo -n "$CHALLENGE" | openssl dgst -sha256 -hmac "<admin password>" | awk '{print $NF}')

TOKEN=$(curl -s -X POST https://stream.example.com/api/v1/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"challenge\":\"$CHALLENGE\",\"response\":\"$RESPONSE\"}" | jq -r .data.token)

curl -H "Authorization: Bearer $TOKEN" https://stream.example.com/api/v1/streams
```