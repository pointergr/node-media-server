import { spawn } from "child_process";

// Αναδιανομή της εκπομπής σε RTMP προορισμούς του πελάτη (YouTube, Facebook,
// Twitch, ό,τι δέχεται RTMP). Ίδιο μοτίβο με το HLS: ένας `ffmpeg -c copy` ανά
// προορισμό, που διαβάζει από το δικό μας RTMP στο loopback και σπρώχνει σε flv.
//
// Ο stream server δεν ξέρει τι είναι «πλατφόρμα» και τι είναι «stream key»:
// παίρνει έτοιμο URL από το clients.json. Έτσι μια νέα πλατφόρμα δεν χρειάζεται
// ούτε μία γραμμή εδώ — η γνώση ζει στο panel, που είναι και το μόνο σημείο που
// βλέπει άνθρωπος.

// Καθόλου bitstream filter, σε αντίθεση με το HLS: το flv θέλει AVCC (το ίδιο
// που δίνει το RTMP), ενώ το `h264_mp4toannexb` του ladder.js γυρίζει σε annex-b
// για το mpegts. Εδώ θα έσπαγε τον muxer. Το SPS/PPS το κουβαλάει το avcC του
// `rtmpVideoHeader` — γι' αυτό ακριβώς υπάρχει το patch του ertmp.js.

// Ο ffmpeg προς τα έξω πεθαίνει πολύ πιο συχνά από τον τοπικό: η πλατφόρμα
// κλείνει το socket όταν δεν έχει ξεκινήσει ακόμα η εκπομπή της, το δίκτυο
// κόβεται, το κλειδί λήγει. Γι' αυτό εδώ **δεν παραιτούμαστε ποτέ**, σε
// αντίθεση με το RESPAWN_MAX του app.js: ο πελάτης μπορεί κάλλιστα να ανοίξει
// το YouTube δέκα λεπτά αφότου άρχισε να εκπέμπει σε εμάς, και ένα relay που
// τα παράτησε δεν θα ξανασηκωνόταν ποτέ χωρίς restart. Αντ' αυτού ανεβαίνει το
// διάστημα, ώστε ένας μόνιμα άκυρος προορισμός να κοστίζει ένα spawn το λεπτό
// και όχι ένα κάθε δύο δευτερόλεπτα.
const BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000];
export const backoffMs = (fails) => BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)];

// Πάνω από αυτό ο προορισμός θεωρείται ότι δούλεψε και ο μετρητής μηδενίζεται.
// Χωρίς αυτό, ένα relay που παίζει επί ώρες και πέφτει μία φορά θα ξεκινούσε
// από το τελευταίο (και μεγαλύτερο) διάστημα του πίνακα.
const OK_AFTER_MS = 30_000;

// Μόνο rtmp/rtmps, και ποτέ πίσω στον ίδιο τον server. Δεν είναι αντίγραφο του
// ελέγχου του API (εκείνος κρίνει μορφή και ιδιωτικά δίκτυα — δες
// apps/api/src/clients/destinations.ts): αυτός εδώ είναι η μόνη εγγύηση που
// μπορεί να δώσει **μόνο** ο stream server, γιατί μόνο αυτός ξέρει τη δική του
// θύρα. Ένα relay προς το loopback τροφοδοτεί τον εαυτό του: κάθε καρέ γυρίζει
// μέσα και ο server ανεβαίνει σε βρόχο μέχρι να λιώσει.
export function usableTarget(url, rtmpPort) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "rtmp:" && u.protocol !== "rtmps:") return false;
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
  // Άλλη θύρα στο ίδιο μηχάνημα είναι θεμιτή (δεύτερη instance, δοκιμές) — ο
  // βρόχος είναι μόνο ο εαυτός μας.
  return !(local && Number(u.port || 1935) === rtmpPort);
}

// Ένα `child.kill()` πάνω σε διεργασία που **δεν ξεκίνησε ποτέ** (λάθος διαδρομή
// στο config.hls.ffmpeg, δηλαδή ENOENT) έχει `pid === undefined`: το Node το
// περνάει ως 0 στο kill(2), και το 0 σημαίνει «όλο το process group». Ο server
// σκοτώνει έτσι τον εαυτό του — και ό,τι άλλο τρέχει στο ίδιο group — με το
// πρώτο donePublish, χωρίς να γράψει τίποτα πουθενά.
// Εξάγεται γιατί το ίδιο ισχύει και για τον ffmpeg του HLS (app.js): μία
// συνάρτηση, ώστε να μη θυμάται κανείς τον έλεγχο τρεις φορές.
export const killFfmpeg = (ff) => {
  if (ff?.pid) ff.kill("SIGKILL");
};

// Ένας προορισμός = ένας ffmpeg που ξανασηκώνεται μόνος του. Ζει όσο ο
// publisher, ακριβώς όπως το HLS job: το `stop` το καλεί το donePublish.
function startRelay(target, { streamPath, ffmpeg, rtmpPort }) {
  // Ό,τι κρατάει το snapshot: ο admin και ο πελάτης πρέπει να βλέπουν ότι το
  // YouTube δεν παίρνει σήμα, γιατί από παντού αλλού η εκπομπή φαίνεται μια
  // χαρά — το RTMP παίζει, το HLS παίζει, και μόνο ο προορισμός λείπει.
  // «live» εδώ σημαίνει «ο ffmpeg τρέχει», όχι «η πλατφόρμα δέχτηκε»: αυτό ο
  // ffmpeg δεν το λέει χωρίς να διαβάσουμε το stderr του. Στην πράξη ένας
  // ffmpeg που δεν συνδέθηκε πεθαίνει μέσα σε δευτερόλεπτα, οπότε η διαφορά
  // φαίνεται αμέσως στο badge — απλώς μία φορά, στην αρχή, το «στέλνει» μπορεί
  // να προηγηθεί της αλήθειας για ένα-δύο δευτερόλεπτα.
  const st = { name: target.name, state: "live", since: null, fails: 0 };
  let ff = null;
  let timer = null;
  let stopped = false;

  const spawnOne = () => {
    if (stopped) return;
    const born = Date.now();
    ff = spawn(
      ffmpeg,
      relayArgs({ streamPath, rtmpPort, url: target.url }),
      { stdio: ["ignore", "ignore", "inherit"] }
    );
    st.state = "live";
    st.since = born;

    // Το ENOENT ενός ffmpeg που δεν υπάρχει φτάνει *μετά* το spawn, οπότε μπορεί
    // να έρθει και αφού έχει φύγει ο publisher: χωρίς τον έλεγχο, κάθε
    // σταματημένο relay αφήνει πίσω του ένα log για εκπομπή που τελείωσε.
    ff.on("error", (err) => {
      if (!stopped) console.error(`relay ${streamPath} → ${target.name}: ${err.message}`);
    });
    ff.on("exit", (code) => {
      if (stopped) return;
      st.fails = Date.now() - born < OK_AFTER_MS ? st.fails + 1 : 0;
      st.state = "retrying";
      st.since = null;
      const wait = backoffMs(st.fails);
      console.error(`relay ${streamPath} → ${target.name}: exit ${code}, retry σε ${wait}ms`);
      timer = setTimeout(spawnOne, wait);
    });
  };

  spawnOne();

  return {
    state: () => ({ ...st }),
    stop() {
      stopped = true;
      clearTimeout(timer);
      // SIGKILL όπως και στο HLS: ο ffmpeg με ανοιχτό RTMP socket αγνοεί το
      // SIGTERM όσο περιμένει το γράψιμο.
      killFfmpeg(ff);
    },
  };
}

// Καθαρή συνάρτηση σε δικό της export, για τον ίδιο λόγο με το ladder.js: τα
// args είναι το μόνο πράγμα εδώ που αξίζει να κλειδωθεί σε test χωρίς να
// σηκωθεί ffmpeg.
export const relayArgs = ({ streamPath, rtmpPort, url }) => [
  // Τα σφάλματα σύνδεσης της πλατφόρμας τα θέλουμε στο log, τα στατιστικά του
  // κάθε καρέ όχι: ένας προορισμός που ξανασυνδέεται κάθε δύο δευτερόλεπτα
  // πνίγει τα logs όλου του server.
  "-loglevel", "error",
  "-i", `rtmp://127.0.0.1:${rtmpPort}${streamPath}`,
  // Ό,τι στέλνει ο πελάτης, αυτούσιο: μηδέν CPU. Το τίμημα είναι ότι τα όρια
  // της πλατφόρμας (bitrate, keyframe interval, AAC) τα πληρώνει ο ίδιος —
  // δες apps/api/README.md.
  "-c", "copy",
  "-f", "flv",
  url,
];

// Όλοι οι προορισμοί ενός stream. Επιστρέφει null όταν δεν υπάρχει κανένας,
// ώστε το app.js να το χειρίζεται με `?.` όπως το stop του r2.js.
export function startRelays(targets, { streamPath, ffmpeg, rtmpPort }) {
  const usable = (targets ?? []).filter((t) => {
    if (usableTarget(t.url, rtmpPort)) return true;
    console.error(`relay ${streamPath} → ${t.name}: άκυρος προορισμός, αγνοείται`);
    return false;
  });
  if (!usable.length) return null;

  const relays = usable.map((t) => startRelay(t, { streamPath, ffmpeg, rtmpPort }));
  return {
    state: () => relays.map((r) => r.state()),
    stop: () => relays.forEach((r) => r.stop()),
  };
}
