# Node Media Server

## Αυτόματη εγκατάσταση

Αντικατάστησε το `server.example.com` με το hostname του server σου:
```bash
apt update
apt install git -y
git clone https://github.com/pointergr/node-media-server.git
cd node-media-server
git checkout master
cd apps/stream
./install server.example.com            # ή: ./install server.example.com --docker
```

Χωρίς `--docker` στήνεται στο μηχάνημα (caddy + volta/node 24 + pm2). Με `--docker`
εγκαθιστά τον Docker και σηκώνει το compose· τα κοινά (ζώνη ώρας, ufw, clone,
`config.json`, κωδικοί) είναι τα ίδια και στα δύο. Η μόνη διαφορά στο firewall είναι
το 8000: ανοίγει μόνο χωρίς Docker, γιατί στο compose ο admin δεν δημοσιεύει θύρα.
Και τα δύο επιβιώνουν reboot — `pm2 startup`/`pm2 save` στο ένα, restart policy του
compose στο άλλο.

### Με cloud-init

Το script είναι ήδη non-interactive και τρέχει ως root, οπότε μπαίνει αυτούσιο σε
`runcmd` — όλο το στήσιμο γίνεται στο πρώτο boot του VM:

```yaml
#cloud-config
package_update: true
packages: [git]
runcmd:
  - export HOME=/root
  - git clone -b master https://github.com/pointergr/node-media-server.git /opt/node-media-server
  - cd /opt/node-media-server/apps/stream && ./install stream.example.com --docker
```

- **Το `HOME=/root` το θέλει ρητά.** Το `runcmd` δεν εγγυάται `$HOME`· αν λείπει, το
  volta γράφει σε λάθος path και το `pm2 startup --hp "$HOME"` στήνει σπασμένο unit.
  Στο `--docker` δεν παίζει ρόλο, στο bare-metal είναι η διαφορά μεταξύ «σηκώνεται
  μετά από reboot» και «δεν σηκώνεται».
- **Δώσε πρώτα το DNS.** Το cloud-init τρέχει στο πρώτο boot· αν το A record δεν
  δείχνει ακόμα στην IP, ο Caddy αποτυγχάνει στο ACME challenge. Ανακάμπτει μόνος του,
  αλλά μην κάνεις rebuild το VM στο μεταξύ — καις rate limit της Let's Encrypt.
- **Οι κωδικοί τυπώνονται μία φορά,** στο `/var/log/cloud-init-output.log`. Εκεί
  βλέπεις και αν πέτυχε όλο το install.
- **Σε cloud-init προτίμησε το `--docker`:** το bare-metal path κάνει `apt install -y
  caddy`, που θέλει το repo της Caddy — υπάρχει στο Debian, όχι στα σκέτα Ubuntu images.

## Docker

Το compose σηκώνει και τον Caddy, οπότε δεν χρειάζεται τίποτα στο host πέρα από
Docker και τα δύο DNS records. Χειροκίνητα, αν δεν χρησιμοποιήσεις το `./install --docker`:

```bash
cd apps/stream
cp .env.example .env               # βάλε μέσα το DOMAIN σου
cp config.example.json config.json # χωρίς αυτό το bind mount φτιάχνει φάκελο
docker compose up -d --build
docker compose logs -f
```

Μετά από reboot σηκώνονται μόνα τους: τα services έχουν `restart: unless-stopped`.
Προϋπόθεση είναι να ξεκινάει ο ίδιος ο Docker στο boot — μια φορά, στον server
(το `./install --docker` το κάνει ήδη):

```bash
sudo systemctl enable --now docker
```

(Το `unless-stopped` δεν ξαναπιάνει container που το σταμάτησες ρητά με
`docker compose stop` πριν το reboot — αυτό είναι το ζητούμενο, `docker compose up -d`
το ξαναφέρνει.)

Καμία χειροκίνητη αλλαγή στο `config.json`: το compose δίνει `ADMIN_HOST` και `ADMIN_DB`
ως environment variables.

Το `config.json` **δεν** είναι στο git (μόνο το `config.example.json`): κρατάει τους κωδικούς
και το jwt secret του κάθε server, οπότε το `git pull` δεν το αγγίζει ποτέ.

| Volume | Γιατί |
|---|---|
| `./config.json` | ο server γράφει μέσα το jwt secret στο πρώτο boot — χωρίς mount χάνεται σε κάθε recreate και ακυρώνονται όλα τα tokens |
| `media` | τα HLS segments· χωρίς R2 σερβίρονται από εδώ. Named volume, όχι bind mount: ο φάκελος `media/` δίπλα στο compose μένει **πάντα άδειος** — τα αρχεία τα βλέπεις με `docker compose exec stream ls -R /app/media` |
| `data` | το `stats.db` με τα στατιστικά 30 ημερών, το `passwords.json` και το `clients.json` |
| `caddy-data` | τα certificates· χωρίς αυτό κάθε recreate ζητάει νέο cert και η Let's Encrypt κόβει στο rate limit |

Δημοσιεύεται **μόνο** το 1935 (RTMP) πέρα από τα 80/443 του Caddy. Τα 8000/8001 μένουν
στο compose network: τα βλέπει μόνο ο Caddy. Στο `ufw` αρκούν 22, 80, 443, 1935.

### Κωδικοί σε Docker

```bash
docker compose exec stream npm run generate-passwords stream.example.com
docker compose restart stream
```

Τυπώνει admin password, το έτοιμο Stream Key του OBS (`stream?key=...`) και τις υπόλοιπες
ρυθμίσεις, γράφει τα credentials στο mounted `config.json` — γι' αυτό χρειάζεται restart,
διαβάζεται μόνο στο boot — και φτιάχνει τον πελάτη `default` στο `data/clients.json`
αν δεν υπάρχει ήδη (δες [Πελάτες](#πελάτες-κλειδιά-εκπομπής-και-όριο-θεατών)).

**Μέχρι να τρέξει αυτό, ο server δουλεύει με τους κωδικούς-παραδείγματα του `config.example.json`.**

Η ίδια εντολή ξανά τους ξανατυπώνει αντί να φτιάξει καινούργιους, επειδή το `passwords.json`
ζει στο `data` volume και επιβιώνει το recreate. Για νέους κωδικούς θέλει ρητό `force`:

```bash
docker compose exec stream npm run generate-passwords stream.example.com force
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

### Ρύθμιση Caddy

Ένα μόνο Caddyfile, αυτό του repo — το ίδιο χρησιμοποιεί και το Docker setup. Βάλε το
hostname σου στη θέση του placeholder:

```bash
sed "s/{\\$DOMAIN}/stream.example.com/g" Caddyfile > /etc/caddy/Caddyfile
systemctl restart caddy
```

Το `STREAM_HOST` μένει στο default (`localhost`) γιατί εδώ ο Caddy και ο server είναι
στο ίδιο μηχάνημα. Δεν μπαίνει basic auth στο Caddyfile: το κάνει ο ίδιος ο admin server
με τον κωδικό του `config.json` (δες [Admin UI](#admin-ui)).

### Logs του Caddy
```bash
journalctl -u caddy -f               # access logs, certificates, ACME, config
```
Ο Caddy γράφει στο stderr, οπότε τα πάντα είναι στο journal — δεν θέλει logrotate.

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
cd node-media-server/apps/stream
cp config.example.json config.json
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

## Ενημέρωση υπάρχοντος server

Το `config.json` δεν είναι στο git, οπότε οι κωδικοί μένουν ως έχουν:

```bash
cd node-media-server
git pull
cd apps/stream
npm install         # μόνο αν άλλαξαν dependencies
pm2 restart stream
```

### Σε Docker

```bash
cd node-media-server
git pull
cd apps/stream
docker compose up -d --build
docker compose logs -f stream    # Ctrl-C· τα logs συνεχίζουν χωρίς αυτό
```

Χωρίς `npm install`: το `COPY package.json` + `npm install` είναι μέσα στο Dockerfile και
το `--build` τα ξανατρέχει. Χωρίς `--build` το compose ξανασηκώνει το **παλιό** image και
δεν αλλάζει τίποτα — είναι το πιο συνηθισμένο «έκανα deploy και δεν άλλαξε τίποτα».

**Κόβει την εκπομπή.** Το `--build` κάνει recreate το container, οπότε πέφτει το RTMP: το
OBS ξανασυνδέεται μόνο του σε λίγα δευτερόλεπτα, οι θεατές τρώνε ένα κενό στο HLS και το
`media` volume κρατάει τα segments της προηγούμενης εκπομπής μέχρι να τα σβήσει ο νέος
ffmpeg. Κάνε deploy εκτός εκπομπής.

Τι επιβιώνει: το `config.json` (bind mount, εκτός git — το `git pull` δεν το αγγίζει) και
τα named volumes `data` (στατιστικά, κωδικοί), `caddy-data` (certificates), `media`.

Αν άλλαξε **μόνο** το `Caddyfile`, δεν χρειάζεται build — είναι bind mount:

```bash
docker compose restart caddy
```

Έλεγχος μετά το deploy:

```bash
docker compose exec stream npm test
docker compose exec stream npm run test-stream -- rtmp.stream.example.com
```

Σε server που εγκαταστάθηκε **πριν** βγει το `config.example.json`, το `config.json` είναι
ακόμα tracked με τους πραγματικούς κωδικούς μέσα και το `git pull` θα κολλήσει. Μία φορά:

```bash
cp config.json /root/config.json.bak
git checkout -- config.json   # πετάει τους κωδικούς από το working tree
git pull                      # τώρα το config.json φεύγει από το tracking
cp /root/config.json.bak config.json
pm2 restart stream
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

### Δοκιμή χωρίς OBS

```bash
npm run test-stream                              # bare metal
docker compose exec stream npm run test-stream   # Docker
```

Εκπέμπει τις χρωματικές μπάρες του ffmpeg (`testsrc`) με συνθετικό ήχο, παίρνοντας μόνο
του το κλειδί του `/live/stream` από το `clients.json`. Αποδεικνύει σε ένα βήμα ότι δουλεύουν RTMP, publish
auth, ffmpeg και HLS — χωρίς να ανοίξεις OBS. Ctrl-C για τερματισμό.

Με το δημόσιο hostname περνάει από έξω, οπότε ελέγχει και Caddy, DNS και στατιστικά:

```bash
docker compose exec stream npm run test-stream -- rtmp.stream.example.com
```

Η διαφορά μετράει: ό,τι έρχεται από `127.0.0.1` το `stats.js` το θεωρεί δικό μας (όπως τον
ffmpeg του HLS) και **δεν** το δείχνει στο admin. Από εξωτερικό IP εμφανίζεται κανονικά,
με codec, ανάλυση και θεατές.

Ο encoder χρησιμοποιεί `-g 60`, δηλαδή keyframe κάθε 2s στα 30fps — ακριβώς το
Keyframe Interval = 2 που θέλει και το OBS.

### Segments στο R2 (προαιρετικό, αλλά ο σωστός τρόπος)

Η Cloudflare περιορίζει το σερβίρισμα βίντεο μέσω του CDN σε non-Enterprise plan — δηλαδή
ακριβώς το κασάρισμα των `.ts`, που όμως είναι όλο το bandwidth. Το R2 δεν είναι CDN αλλά
storage με μηδενικό egress· το να φεύγει βίντεο από R2 custom domain είναι η προβλεπόμενη
χρήση του.

<a name="tos"></a>
**Το setup με R2 είναι ρητά εντός των όρων** — μην το ξαναψάχνεις. Ο παλιός όρος 2.8
(«Limitation on Serving Non-HTML Content») [καταργήθηκε τον Μάιο 2023](https://blog.cloudflare.com/updated-tos)
ακριβώς επειδή το R2 τον έκανε αντιφατικό. Η ανακοίνωση το λέει ονομαστικά:

> customers can serve video and other large files using the CDN so long as that content is
> hosted by a Cloudflare service like Stream, Images, or R2.

Και το κατοπτρικό, που είναι το μόνο που πρέπει να προσέχεις:

> Video and large files **hosted outside of Cloudflare** will still be restricted on our CDN.

Δηλαδή η *χωρίς R2* παραλλαγή — `.ts` στον δικό μας δίσκο, cached από το πορτοκαλί σύννεφο
(ο κανόνας #1 [παρακάτω](#cloudflare-cache-rules)) — είναι αυτή που πατάει στα όρια, όχι η
R2. Ο ίδιος κανόνας επιβιώνει σήμερα στα
[Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/),
διατυπωμένος ανάποδα: *«specific Paid Services (e.g., the Developer Platform, Images, and
Stream) that you must use in order to serve video […] via the CDN»* — και το R2 **είναι**
το Developer Platform.

Το `index.m3u8` που μένει στο origin δεν αλλάζει τίποτα: κείμενο μερικών εκατοντάδων bytes,
ούτε video ούτε large file.

Γι' αυτό σπάμε το HLS στα δύο:

| | Πού | Γιατί |
|---|---|---|
| `index.m3u8` | origin, όπως και πριν | ψίχουλα bytes, ήδη bypass cache — δεν είναι «large file» |
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

Κάθε PUT κόβεται στα 5s και το `aws4fetch` περιορίζεται σε 2 retries: σε live, ένα segment
που άργησε παραπάνω δεν το θέλει πια κανένας player, ενώ οι default 10 retries με
exponential backoff θα πάγωναν το `index.m3u8` για ~50 δευτερόλεπτα — και χωρίς προθεσμία
μια κολλημένη σύνδεση για λεπτά, χωρίς ούτε ένα log. Ο γύρος που αποτυγχάνει δεν δημοσιεύει
playlist· ο επόμενος, 2s αργότερα, ξαναπροσπαθεί από το σημείο που είναι τότε το stream.

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

Ο κανόνας #1 κασάρει στο CDN βίντεο που φιλοξενείται εκτός Cloudflare — αυτό ακριβώς που
περιορίζουν οι όροι σε non-Enterprise plan. Η καθαρή λύση είναι το
[R2](#segments-στο-r2-προαιρετικό-αλλά-ο-σωστός-τρόπος), που είναι
[ρητά εντός των όρων](#tos) και κάνει τον κανόνα περιττό.

## Πελάτες, κλειδιά εκπομπής και όριο θεατών

Ο έλεγχος της εκπομπής είναι δικός μας, όχι του nms (`auth.publish: false`). Κάθε path
ανήκει σε έναν πελάτη και θέλει το δικό του τυχαίο κλειδί — όλα δηλωμένα στο
`data/clients.json`:

```json
{
  "pelatis-a": {
    "limit": 200,
    "paths": { "/live/kamera1": "KEY1", "/live/kamera2": "KEY2" }
  }
}
```

Στο OBS το κλειδί μπαίνει στο Stream Key: `kamera1?key=KEY1`. Το nms κόβει το query πριν
φτιάξει το path, οπότε φάκελος HLS, στατιστικά και urls αναπαραγωγής δεν αλλάζουν.

- **Άγνωστο path δεν εκπέμπει.** Περνάει μόνο ό,τι είναι δηλωμένο εδώ.
- **Χωρίς `clients.json` (ή με άδειο) δεν επιβάλλεται τίποτα** — ο δρόμος αναδίπλωσης: ένα
  αρχείο που λείπει ή χάλασε δεν ρίχνει τις εκπομπές. Γι' αυτό ακριβώς το
  `generate-passwords` φτιάχνει στην πρώτη εγκατάσταση έναν πελάτη `default` για το
  `/live/stream`: αλλιώς ένας καθαρός server θα ήταν ορθάνοιχτος σε όποιον ξέρει το URL.
- Το `limit` είναι **αθροιστικό σε όλα τα paths του πελάτη** (το πακέτο πουλιέται ανά
  πελάτη, όχι ανά κάμερα)· `0` ή απόν = χωρίς όριο. Ο θεατής πάνω από το όριο παίρνει 404
  στο playlist — ίδιο σήμα με το «δεν εκπέμπει», οπότε ο player μπαίνει στον υπάρχοντα
  δρόμο επανασύνδεσης — ενώ όποιος ήδη μετριέται δεν κόβεται ποτέ. Ο HLS θεατής
  ελευθερώνει τη θέση του 30s μετά το κλείσιμο του player.
- Αλλαγή κλειδιού ή διαγραφή πελάτη κόβει τον publisher **μέσα σε 10s**, χωρίς restart.

### Sync με το panel

Με συμπληρωμένο `panel.url` στο `config.json`, ο server κάνει ανά 10s POST
`<url>/servers/<host>/sync` με το snapshot (τι παίζει, πόσοι θεατές) και γράφει την
απάντηση στο `data/clients.json`. Pull αντί για push: ο server συγχρονίζεται μόνος του
μετά από restart ή deploy, ενώ ένα push προς server εκτός λειτουργίας θα χανόταν και το
panel θα έπρεπε να κρατάει ουρά. Αν το panel είναι κάτω, μένει σε ισχύ το τελευταίο
`clients.json` — panel κάτω δεν σημαίνει εκπομπές κάτω. Κενό `url` = απενεργοποιημένο,
το `clients.json` το γράφει το χέρι.

## Admin UI

Στο `https://stream.example.com/admin` (χρήστης `admin`, ο κωδικός από το
`generate-passwords`). Το v4 δεν έχει δικό του panel — αυτό είναι δικό μας.

Το basic auth το κάνει ο ίδιος ο admin server, με τον κωδικό του `config.json`. Δεν
μπαίνει hash στο Caddyfile: ένα δεύτερο αντίγραφο του κωδικού σε άλλο αρχείο σημαίνει
σίγουρο 401 την πρώτη φορά που θα αλλάξουν οι κωδικοί και δεν θα ενημερωθεί.

Δείχνει ενεργά streams (θεατές, bitrate, codec, ανάλυση, διάρκεια), γραφήματα για
1h / 24h / 7d / 30d, ενεργές συνδέσεις με κουμπί kill, log πρόσφατων συνδέσεων, και
κουμπί **Restart** στο header.

Το Restart δεν ξανασηκώνει τον server μόνο του: κάνει `POST /admin/api/restart`,
που σκοτώνει πρώτα τα ffmpeg jobs του HLS (αλλιώς μένουν ορφανά και κλειδώνουν το
streamPath για το επόμενο process) και μετά τερματίζει με `process.exit(0)`· τον
ξανασηκώνει ο supervisor — pm2 σε bare metal, `restart: unless-stopped` σε Docker.
Το UI ζητάει επιβεβαίωση (και προειδοποιεί ρητά αν υπάρχει ενεργή εκπομπή), δείχνει
«γίνεται restart…» και κάνει poll το `/admin/api/live` μέχρι να ξαναπαντήσει ο server,
πριν κάνει reload τη σελίδα.

Πώς δουλεύει:

- Ο collector στο `stats.js` κρεμιέται στα events του server και κρατάει δείγμα κάθε
  60 δευτερόλεπτα σε SQLite (`stats.db`), με διατήρηση 30 ημερών. Το bitrate δεν υπάρχει
  πουθενά στο API του v4 — βγαίνει από τη διαφορά δύο δειγμάτων.
- Το UI σερβίρεται από δικό μας HTTP server στο `127.0.0.1:8001`. **Δεν** ακούει σε
  εξωτερικό interface, οπότε δεν χρειάζεται άνοιγμα στο ufw· περνάει μόνο μέσω Caddy.
  Σε Docker ακούει στο `0.0.0.0` (`ADMIN_HOST`) γιατί ο Caddy είναι σε άλλο container,
  αλλά η θύρα δεν δημοσιεύεται στο host.
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