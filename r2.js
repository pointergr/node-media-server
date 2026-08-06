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

export function startR2Sync(dir, streamPath, r2) {
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
  const src = `${dir}/ff.m3u8`;
  const dst = `${dir}/index.m3u8`;
  let stopped = false;

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
  };

  // Το playlist γράφεται *μετά* τα uploads: αλλιώς ο player διαβάζει ένα segment
  // που δεν έχει ανέβει ακόμα στο R2 και τρώει 404.
  const sync = async () => {
    const started = Date.now();
    const playlist = fs.readFileSync(src, "utf8");
    // Διαβάζουμε όλα τα segments πριν από το πρώτο upload: ο ffmpeg σβήνει το
    // παλιότερο του παραθύρου δύο segments αργότερα (4s με hls_time 2), οπότε
    // ένας αργός γύρος θα έβρισκε ENOENT και θα χανόταν ολόκληρος — ακριβώς τη
    // στιγμή που είμαστε ήδη πίσω. Έτσι το «πίσω» κοστίζει latency, όχι playlist.
    const pending = playlistSegments(playlist)
      .filter((name) => !uploaded.has(name))
      .map((name) => [name, fs.readFileSync(`${dir}/${name}`)]);
    // Παράλληλα: ο γύρος που προλαβαίνει στοιχίζει ένα RTT, όχι τρία.
    await Promise.all(pending.map(([name, body]) => put(name, body)));
    // Ο φάκελος μπορεί να ανήκει ήδη στην επόμενη εκπομπή: ίδιο path, άλλα
    // segments. Χωρίς αυτό ο καθυστερημένος γύρος δημοσιεύει το playlist της
    // προηγούμενης, που υπάρχει ακόμα στο R2 και παίζει κανονικά.
    if (stopped) return;
    fs.writeFileSync(dst, playlist);
    // Αν ένας γύρος αργεί περισσότερο από το hls_time, τα uploads δεν προλαβαίνουν
    // τον ffmpeg και το latency μεγαλώνει μόνιμα. Είναι το μόνο σημείο που σπάει
    // σιωπηλά, γι' αυτό ουρλιάζει.
    const took = Date.now() - started;
    if (took > 2000) console.warn(`R2 sync ${streamPath}: ${took}ms, πιο αργό από το segment`);
  };

  // Watch στο directory, όχι στο αρχείο: με το temp_file flag ο ffmpeg γράφει
  // .tmp και κάνει rename, οπότε ένα watch πάνω στο αρχείο θα χανόταν στο πρώτο
  // κιόλας update. Οι φορτώσεις μπαίνουν σε σειρά — το sync δεν είναι reentrant.
  let chain = Promise.resolve();
  const watcher = fs.watch(dir, (_, file) => {
    if (file !== "ff.m3u8") return;
    chain = chain.then(sync).catch((err) => console.error(`R2 sync ${streamPath}: ${err.message}`));
  });

  return () => {
    stopped = true;
    watcher.close();
  };
}
