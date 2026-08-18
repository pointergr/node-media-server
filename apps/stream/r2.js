// Ανεβάζει τα HLS segments στο R2 και δημοσιεύει το playlist μόνο αφού ανέβουν.
// Το playlist μένει στο origin (εκεί μετράμε τους θεατές), τα segments φεύγουν
// από το R2 — έτσι δεν περνάει βίντεο από το CDN του domain.
import fs from "fs";
import { AwsClient } from "aws4fetch";

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
// μας HTTP server όταν σερβίρονται από το R2). Το r2.js δεν κάνει require το
// stats.js — δεν ξέρει καν ότι υπάρχει — το app.js περνάει το callback.
export function startR2Sync(dir, streamPath, r2, onUpload) {
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
  // Τα bytes όσων δεν ανέβηκαν ακόμα — δες το σχόλιο στο sync().
  const cache = new Map();
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
      // Χωρίς προθεσμία, μια κολλημένη σύνδεση παγώνει το index.m3u8 για λεπτά
      // (undici headersTimeout 300s) χωρίς ούτε ένα log — το warning παρακάτω
      // τυπώνεται μόνο όταν τελειώσει ο γύρος. Το signal μετράει για όλες τις
      // προσπάθειες μαζί.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`PUT ${name} -> ${res.status} ${await res.text()}`);
    uploaded.add(name);
    cache.delete(name);
    // uploaded.add() παραπάνω εγγυάται ότι ένα όνομα φτάνει εδώ μία μόνο φορά όσο
    // ζει αυτό το sync: το pending στο sync() το φιλτράρει έξω μετά, οπότε ένα
    // retry (π.χ. sync() που ξανατρέχει) δεν ξαναπερνάει από εδώ για το ίδιο name.
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

  // Το playlist γράφεται *μετά* τα uploads: αλλιώς ο player διαβάζει ένα segment
  // που δεν έχει ανέβει ακόμα στο R2 και τρώει 404.
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
    // Διαβάζουμε όλα τα segments πριν από το πρώτο upload: ο ffmpeg σβήνει όσα
    // βγαίνουν από το παράθυρο, οπότε ένας αργός γύρος θα έβρισκε ENOENT και θα
    // χανόταν ολόκληρος — ακριβώς τη στιγμή που είμαστε ήδη πίσω. Έτσι το «πίσω»
    // κοστίζει latency, όχι playlist.
    for (const l of media) {
      l.segments = playlistSegments(l.body);
      // Και τα κρατάμε μέχρι να ανέβουν: ένα PUT που σκάει (timeout, 503) ξαναδοκιμάζεται
      // στον επόμενο γύρο, αλλά ως τότε ο ffmpeg μπορεί να έχει σβήσει το αρχείο.
      // Χωρίς το cache, το ENOENT έριχνε *κάθε* επόμενο γύρο όσο το όνομα ήταν ακόμα
      // στο playlist: ένα αργό PUT πάγωνε το index.m3u8 για δευτερόλεπτα, όχι για έναν
      // γύρο, και ο θεατής άδειαζε τον buffer του.
      for (const name of l.segments) {
        if (!uploaded.has(name) && !cache.has(name)) cache.set(name, fs.readFileSync(`${src}/${name}`));
      }
    }
    // Ό,τι βγήκε από το παράθυρο δεν το ζητάει πια κανείς — μην κρατάς τη μνήμη.
    const live = new Set(media.flatMap((l) => l.segments));
    for (const name of cache.keys()) if (!live.has(name)) cache.delete(name);

    // Ανά variant, όχι όλα μαζί: ένα σκαλοπάτι που δεν ανεβαίνει (PUT 5xx) δεν
    // επιτρέπεται να παγώσει τα υπόλοιπα — ο θεατής θα έπρεπε να πέσει σε αυτό
    // ακριβώς που δουλεύει. Παράλληλα μέσα σε κάθε variant: ο γύρος που
    // προλαβαίνει στοιχίζει ένα RTT, όχι τρία.
    const rounds = await Promise.allSettled(media.map(async (l) => {
      await Promise.all(
        l.segments.filter((name) => !uploaded.has(name)).map((name) => put(name, cache.get(name)))
      );
      publish(l.name, l.body);
    }));

    // Το master μόνο αφού δημοσιευτεί το πρώτο variant: αλλιώς οι πρώτοι 2-4s
    // δίνουν 404 σε variant που το master υπόσχεται.
    if (media.some((l) => published.has(l.name))) {
      for (const l of lists) if (!media.includes(l)) publish(l.name, l.body);
    }

    // Αν ένας γύρος αργεί περισσότερο από το hls_time, τα uploads δεν προλαβαίνουν
    // τον ffmpeg και το latency μεγαλώνει μόνιμα. Είναι το μόνο σημείο που σπάει
    // σιωπηλά, γι' αυτό ουρλιάζει.
    const took = Date.now() - started;
    if (took > 2000) console.warn(`R2 sync ${streamPath}: ${took}ms, πιο αργό από το segment`);

    const failed = rounds.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  };

  // Watch στο directory, όχι στο αρχείο: με το temp_file flag ο ffmpeg γράφει
  // .tmp και κάνει rename, οπότε ένα watch πάνω στο αρχείο θα χανόταν στο πρώτο
  // κιόλας update. Οι φορτώσεις μπαίνουν σε σειρά — το sync δεν είναι reentrant.
  let chain = Promise.resolve();
  const queue = () => {
    chain = chain.then(sync).catch((err) => console.error(`R2 sync ${streamPath}: ${err.message}`));
  };
  const watcher = fs.watch(src, (_, file) => {
    if (file?.endsWith(".m3u8")) queue();
  });
  // Χωρίς listener, ένα σφάλμα του watcher βγαίνει ως uncaught exception και
  // ρίχνει ολόκληρο τον server — μαζί και τα streams που δεν έφταιγαν σε τίποτα.
  watcher.on("error", (err) => console.error(`R2 watch ${streamPath}: ${err.message}`));

  // Το fs.watch είναι το γρήγορο μονοπάτι, όχι το μόνο. Ένας γύρος που πέταξε
  // (PUT 5xx, timeout) αφήνει το index.m3u8 στην προηγούμενη έκδοση μέχρι το
  // επόμενο event, κι ένα inotify watch που πεθαίνει σιωπηλά — όριο συστήματος,
  // φάκελος που αντικαταστάθηκε — το παγώνει για πάντα, με τον ffmpeg να γράφει
  // κανονικά δίπλα. Ο περιοδικός γύρος δεν κοστίζει τίποτα όταν δεν άλλαξε
  // τίποτα: το sync() δεν ξαναγράφει ίδιο playlist.
  const poll = setInterval(queue, 2000);

  return () => {
    stopped = true;
    clearInterval(poll);
    watcher.close();
  };
}
