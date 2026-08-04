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

## Χειροκίνητη εγκατάσταση
Άνοιξε έναν server.

Πρέπει να έχεις ένα πραγματικό URL που να δείχνει στον server (A Record).
Παρακάτω θα χρησιμοποιήσουμε το υποθετικό `stream.example.com`.

Χρειάζονται **δύο** A Records στην ίδια IP, με διαφορετικό ρόλο το καθένα:

| Record | Ρόλος | Cloudflare |
|---|---|---|
| `rtmp.stream.example.com` | εκπομπή — εδώ στέλνει το OBS (RTMP, 1935) | **DNS only** (γκρι) |
| `stream.example.com` | αναπαραγωγή — HLS/FLV για τους players | proxied (πορτοκαλί) |

Το `rtmp.` πρέπει να μείνει DNS only: το Cloudflare proxy περνάει μόνο HTTP(S) ports,
οπότε με πορτοκαλί σύννεφο το publish στο 1935 δεν φτάνει ποτέ στον server. Τα HLS
segments αντίθετα θέλουμε να περνάνε από το Cloudflare, γι' αυτό κασάρονται.

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

# Ρητά και τα δύο schemes: σκέτο hostname σημαίνει automatic HTTPS με redirect
# 80->443, που με Cloudflare Flexible γίνεται redirect loop πριν βγει το certificate.
http://stream.example.com, https://stream.example.com, http://rtmp.stream.example.com, https://rtmp.stream.example.com {
        # Το admin UI ακούει μόνο στο loopback — το auth το κάνει εδώ ο Caddy
        handle /admin* {
                basic_auth {
                        admin <hash από: caddy hash-password --plaintext "<admin password>">
                }
                reverse_proxy localhost:8001
        }

        handle {
                reverse_proxy localhost:8000
        }

        # HLS: το playlist δεν πρέπει ποτέ να κασάρεται, τα segments είναι immutable
        header *.m3u8 Cache-Control "no-store"
        header *.ts Cache-Control "public, max-age=31536000, immutable"

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

### Cloudflare

Ο Caddyfile βάζει ήδη τα σωστά `Cache-Control`. Στο Cloudflare χρειάζεται Cache Rule που να
σέβεται τα origin headers — αν κασάρει το `.m3u8`, ο player κολλάει σε παλιό playlist.
Προσοχή επίσης στο ToS 2.8 της Cloudflare για video μέσω CDN σε non-Enterprise plan.

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

Το `stats.db` είναι στο `.gitignore`. Έλεγχος του collector: `node test-stats.js`.

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