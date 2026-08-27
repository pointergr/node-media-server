// Ανεβάζει τα HLS segments στο R2 και δημοσιεύει το playlist που τα δείχνει.
// Τα playlists μένουν πάντα στο origin (εκεί μετράμε τους θεατές), τα segments
// φεύγουν από το R2 — έτσι δεν περνάει βίντεο από το CDN του domain.
//
// Ό,τι δεν προλάβει να ανέβει μέσα σε ένα segment δημοσιεύεται με την *τοπική*
// του διαδρομή και το σερβίρει ο static server, όπως χωρίς R2: το R2 είναι
// βελτιστοποίηση της κίνησης, ποτέ εξάρτηση της αναπαραγωγής. Ο κανόνας αυτός
// είναι όλη η διαφορά ανάμεσα σε «το R2 αργεί σήμερα» και «η εκπομπή δεν παίζει»:
// όσο το playlist περίμενε τα uploads, ένας γύρος που ξεπερνούσε τα 2s άφηνε
// segment πίσω, ο επόμενος γύρος έβρισκε δύο, και από εκεί και πέρα το playlist
// δεν ξαναπρολάβαινε ποτέ.
import fs from "fs";
import { AwsClient } from "aws4fetch";
import { SEGMENT_SEC } from "./ladder.js";

// Τα segments ενός playlist: κάθε γραμμή που δεν είναι directive. Με -hls_base_url
// είναι απόλυτα URLs, οπότε κρατάμε μόνο το όνομα του αρχείου.
export const playlistSegments = (playlist) =>
  playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("/").pop());

// onUpload(name, bytes): κλήση μετά από κάθε *επιτυχημένο* PUT, για να τρέφει τον
// εκτιμητή bitrate εξόδου του stats.js (τα segments δεν περνάνε ποτέ από το δικό
// μας HTTP server όταν σερβίρονται από το R2). onFallback(name): κλήση μία φορά
// για κάθε segment που δεν πρόλαβε και δημοσιεύτηκε από το origin — έτσι η
// υποβάθμιση φαίνεται στο snapshot (και στο panel) όσο συμβαίνει. Το r2.js δεν
// κάνει require το stats.js — δεν ξέρει καν ότι υπάρχει — το app.js περνάει τα
// callbacks.
export function startR2Sync(dir, streamPath, r2, onUpload, onFallback) {
  const aws = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: "s3",
    region: "auto",
    // Το aws4fetch κάνει από μόνο του 10 retries με exponential backoff, δηλαδή
    // κρατάει την αλυσίδα έως ~50s για ένα segment που μετά από 4s δεν το θέλει
    // πια κανένας player. Σε live: δύο γρήγορες προσπάθειες ή τίποτα.
    retries: 2,
  });

  const uploaded = new Set();
  // Ό,τι δημοσιεύτηκε με τοπική διαδρομή. Μία προσπάθεια ανά segment και τέλος:
  // από τη στιγμή που ο θεατής το παίρνει από εμάς, ένα δεύτερο PUT στέλνει bytes
  // που κανείς δεν πρόκειται να ζητήσει από το R2 — και τα στέλνει ακριβώς όταν
  // το uplink χρειάζεται για να σερβίρει. Έτσι ο γύρος βλέπει μόνο ό,τι γέννησε ο
  // ffmpeg από τον προηγούμενο και μετά, και το backlog δεν πολλαπλασιάζεται.
  const fromOrigin = new Set();
  // Αν αυτή τη στιγμή η εκπομπή πληρώνεται από το uplink μας. Κρατιέται μόνο και
  // μόνο για να γραφτούν δύο γραμμές στα logs — η αρχή και το τέλος.
  let degraded = false;
  // Ο ffmpeg γράφει εδώ, με τα *τελικά* ονόματα· εμείς δημοσιεύουμε τα ίδια
  // ονόματα ένα επίπεδο πάνω. Ένας κανόνας για όλες τις περιπτώσεις: με ή χωρίς
  // ladder, ένα playlist ή πέντε, το ff/ είναι η σκαλωσιά και ο φάκελος του
  // stream είναι ό,τι βλέπει ο θεατής.
  const src = `${dir}/ff`;
  let stopped = false;
  // Ό,τι έχει ήδη δημοσιευτεί, ανά όνομα: ο γύρος που δεν αλλάζει τίποτα δεν
  // ξαναγράφει.
  const published = new Map();

  const put = async (name, body) => {
    const res = await aws.fetch(`${r2.endpoint}/${r2.bucket}${streamPath}/${name}`, {
      method: "PUT",
      body,
      headers: {
        "Content-Type": "video/mp2t",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      // Η προθεσμία είναι όσο ένα segment, όχι όσο αντέχει η σύνδεση: ό,τι δεν
      // ανέβηκε μέχρι να γεννηθεί το επόμενο segment είναι ήδη αργά, και ο
      // θεατής το θέλει *τώρα* — φεύγει από το origin. Χωρίς προθεσμία μια
      // κολλημένη σύνδεση πάγωνε το playlist για λεπτά (undici headersTimeout
      // 300s) χωρίς ούτε ένα log. Το signal μετράει για όλες τις προσπάθειες μαζί.
      signal: AbortSignal.timeout(SEGMENT_SEC * 1000),
    });
    if (!res.ok) throw new Error(`PUT ${name} -> ${res.status} ${await res.text()}`);
    uploaded.add(name);
    onUpload?.(name, body.length);
  };

  // Το writeFileSync είναι open(O_TRUNC) και μετά write: όποιος player ζητήσει
  // το playlist ανάμεσα στις δύο κλήσεις παίρνει 0 bytes και ο hls.js πεθαίνει
  // με levelParsingError. Ίδιος λόγος που ο ffmpeg γράφει με temp_file — και
  // αυτό εδώ είναι το αρχείο που ζητάνε στ' αλήθεια οι θεατές.
  const publish = (name, body) => {
    // Ο φάκελος μπορεί να ανήκει ήδη στην επόμενη εκπομπή: ίδιο path, άλλα
    // segments. Χωρίς αυτό ο καθυστερημένος γύρος δημοσιεύει το playlist της
    // προηγούμενης, που υπάρχει ακόμα στο R2 και παίζει κανονικά.
    if (stopped || published.get(name) === body) return;
    fs.writeFileSync(`${dir}/${name}.tmp`, body);
    fs.renameSync(`${dir}/${name}.tmp`, `${dir}/${name}`);
    published.set(name, body);
  };

  // Το playlist όπως το βλέπει ο θεατής: ό,τι έγραψε ο ffmpeg (απόλυτο URL του
  // R2, από το -hls_base_url) για όσα segments ανέβηκαν, η τοπική διαδρομή για
  // τα υπόλοιπα. Το ένα ή το άλλο ανά *segment*, όχι ανά εκπομπή: μια στιγμιαία
  // αναλαμπή του R2 κοστίζει ένα segment από το origin, όχι όλη την εκπομπή.
  const localize = (body) =>
    body
      .split("\n")
      .map((line) => {
        const url = line.trim();
        if (!url || url.startsWith("#")) return line;
        const name = url.split("/").pop();
        return uploaded.has(name) ? line : `ff/${name}`;
      })
      .join("\n");

  const sync = async () => {
    const started = Date.now();
    // Ο ffmpeg δεν έχει γράψει ακόμα playlist (πρώτο segment, ή respawn μετά από
    // rmSync). Χωρίς αυτό ο περιοδικός γύρος παρακάτω γεμίζει τα logs με ENOENT.
    if (!fs.existsSync(src)) return;
    const lists = fs.readdirSync(src)
      .filter((name) => name.endsWith(".m3u8"))
      .map((name) => ({ name, body: fs.readFileSync(`${src}/${name}`, "utf8") }));
    // Το master δεν έχει segments, έχει variants: αντιγράφεται αυτούσιο, γιατί
    // δείχνει σε *σχετικά* ονόματα playlist που μένουν στο origin — εκεί
    // μετράμε τους θεατές. Το -hls_base_url αγγίζει μόνο τα segments *μέσα* στα
    // variants.
    const media = lists.filter((l) => !l.body.includes("#EXT-X-STREAM-INF"));
    // Τα bytes διαβάζονται εδώ, πριν από το πρώτο await: ο ffmpeg σβήνει όσα
    // segments βγαίνουν από το παράθυρο, και μέσα στον γύρο δεν υπάρχει κενό
    // όπου να χαθεί αρχείο που μόλις είδαμε στο playlist. Μόνο για όσα θα
    // δοκιμαστούν — ό,τι έφυγε στο origin δεν ξαναδιαβάζεται καν.
    const bytes = new Map();
    for (const l of media) {
      l.segments = playlistSegments(l.body);
      l.pending = l.segments.filter((name) => !uploaded.has(name) && !fromOrigin.has(name));
      for (const name of l.pending) {
        // Το αρχείο μπορεί να έχει χαθεί από κάτω μας (rmSync του respawn):
        // ένας γύρος που σκάει εδώ δεν δημοσιεύει *κανένα* playlist. Χωρίς
        // bytes δεν γίνεται PUT, οπότε το όνομα φεύγει στο origin παρακάτω —
        // σαν κάθε segment που δεν πρόλαβε.
        try { bytes.set(name, fs.readFileSync(`${src}/${name}`)); } catch (err) { l.readError ??= err; }
      }
    }
    // Ό,τι βγήκε από το παράθυρο ξεχνιέται: τα ονόματα είναι μοναδικά (prefix
    // από Date.now()), οπότε χωρίς κλάδεμα τα δύο sets μιας 24/7 εκπομπής
    // μεγαλώνουν για πάντα. Ακίνδυνο για τον γύρο: ό,τι κλαδεύεται δεν υπάρχει
    // σε κανένα playlist, άρα ούτε στο pending ούτε στο localize.
    const live = new Set(media.flatMap((l) => l.segments));
    for (const name of uploaded) if (!live.has(name)) uploaded.delete(name);
    for (const name of fromOrigin) if (!live.has(name)) fromOrigin.delete(name);

    // Ανά variant, όχι όλα μαζί: ένα σκαλοπάτι που δεν ανεβαίνει (PUT 5xx) δεν
    // επιτρέπεται να παγώσει τα υπόλοιπα — ο θεατής θα έπρεπε να πέσει σε αυτό
    // ακριβώς που δουλεύει. Παράλληλα μέσα σε κάθε variant: ο γύρος που
    // προλαβαίνει στοιχίζει ένα RTT, όχι τρία.
    // Πόσα segments έπεσαν στο origin *σε αυτόν τον γύρο* — μετρητής και όχι
    // διαφορά μεγέθους του fromOrigin: το κλάδεμα του παραθύρου αλλάζει το set
    // ταυτόχρονα, και μια πτώση συν ένα κλάδεμα θα έβγαζαν «μηδέν».
    let fell = 0;
    const rounds = await Promise.allSettled(media.map(async (l) => {
      const tries = await Promise.allSettled(
        l.pending.filter((name) => bytes.has(name)).map((name) => put(name, bytes.get(name)))
      );
      // Δημοσίευση πρώτα, παράπονα μετά: ο γύρος δεν χάνεται ποτέ ολόκληρος για
      // ένα segment που δεν πρόλαβε — βγαίνει με την τοπική του διαδρομή.
      publish(l.name, localize(l.body));
      // onFallback(name): μία φορά ανά segment, όσο και οι προσπάθειες — το
      // stats.js μετράει επεισόδιο, όχι γύρους που ξαναείδαν το ίδιο όνομα.
      for (const name of l.pending) if (!uploaded.has(name)) {
        fromOrigin.add(name);
        fell++;
        onFallback?.(name);
      }
      return tries.find((t) => t.status === "rejected")?.reason;
    }));

    // Δύο γραμμές ανά επεισόδιο, η αρχή και το τέλος — όχι μία ανά segment. Όταν
    // το R2 δεν προλαβαίνει αποτυγχάνουν *όλα* τα segments, οπότε μια γραμμή ανά
    // segment είναι δύο το δευτερόλεπτο ανά εκπομπή: θόρυβος ακριβώς την ώρα που
    // τα logs πρέπει να διαβαστούν. Η επαναφορά θέλει segment που όντως ανέβηκε,
    // όχι απλώς γύρο χωρίς αποτυχία: ο γύρος που δεν είχε τίποτα να ανεβάσει δεν
    // αποδεικνύει τίποτα.
    const attempted = media.reduce((n, l) => n + l.pending.length, 0);
    const reason = rounds.map((r) => r.value ?? r.reason).find(Boolean)
      ?? media.find((l) => l.readError)?.readError;
    if (fell && !degraded) {
      degraded = true;
      console.warn(`R2 ${streamPath}: δεν προλαβαίνει — τα segments φεύγουν από το origin (${reason?.message ?? reason})`);
    } else if (attempted && !fell && degraded) {
      degraded = false;
      console.warn(`R2 ${streamPath}: ξαναπρολαβαίνει, τα segments ξαναπάνε στο R2`);
    }

    // Το master μόνο αφού δημοσιευτεί το πρώτο variant: αλλιώς οι πρώτοι 2-4s
    // δίνουν 404 σε variant που το master υπόσχεται.
    if (media.some((l) => published.has(l.name))) {
      for (const l of lists) if (!media.includes(l)) publish(l.name, l.body);
    }

    // Ο γύρος που αργεί περισσότερο από ένα segment δεν προλαβαίνει τον ffmpeg:
    // δεν σπάει πια τίποτα (τα segments φεύγουν από το origin), αλλά είναι το
    // σήμα ότι το R2 δεν κρατάει τον ρυθμό και ότι το uplink του server πληρώνει
    // τη διαφορά.
    const took = Date.now() - started;
    if (took > SEGMENT_SEC * 1000) console.warn(`R2 sync ${streamPath}: ${took}ms, πιο αργό από το segment`);

    const failed = rounds.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  };

  // Watch στο directory, όχι στο αρχείο: με το temp_file flag ο ffmpeg γράφει
  // .tmp και κάνει rename, οπότε ένα watch πάνω στο αρχείο θα χανόταν στο πρώτο
  // κιόλας update.
  //
  // Ένας γύρος τη φορά, και *ένας* στην αναμονή. Τα events έρχονται πιο γρήγορα
  // απ' όσο κλείνει ένας αργός γύρος — ένα playlist ανά variant σε κάθε segment,
  // συν ο περιοδικός γύρος — και μια ουρά που δεν αδειάζει ποτέ σπρώχνει κάθε
  // φορά πιο πίσω τον μόνο γύρο που μετράει, τον επόμενο. Τίποτα δεν χάνεται:
  // ο γύρος διαβάζει την κατάσταση από τον δίσκο, οπότε δέκα events και ένα
  // βλέπουν ακριβώς το ίδιο πράγμα.
  let running = null;
  let waiting = false;
  const queue = () => {
    if (running) {
      waiting = true;
      return;
    }
    running = sync()
      .catch((err) => console.error(`R2 sync ${streamPath}: ${err.message}`))
      .finally(() => {
        running = null;
        if (waiting) {
          waiting = false;
          queue();
        }
      });
  };

  const watcher = fs.watch(src, (_, file) => {
    if (file?.endsWith(".m3u8")) queue();
  });
  // Χωρίς listener, ένα σφάλμα του watcher βγαίνει ως uncaught exception και
  // ρίχνει ολόκληρο τον server — μαζί και τα streams που δεν έφταιγαν σε τίποτα.
  watcher.on("error", (err) => console.error(`R2 watch ${streamPath}: ${err.message}`));

  // Το fs.watch είναι το γρήγορο μονοπάτι, όχι το μόνο. Ένα inotify watch που
  // πεθαίνει σιωπηλά — όριο συστήματος, φάκελος που αντικαταστάθηκε — παγώνει το
  // playlist για πάντα, με τον ffmpeg να γράφει κανονικά δίπλα. Ο περιοδικός
  // γύρος δεν κοστίζει τίποτα όταν δεν άλλαξε τίποτα: το sync() δεν ξαναγράφει
  // ίδιο playlist.
  const poll = setInterval(queue, 2000);

  return () => {
    stopped = true;
    clearInterval(poll);
    watcher.close();
  };
}
