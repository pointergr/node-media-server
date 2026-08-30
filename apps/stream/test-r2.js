// Έλεγχος του R2 sync: node test-r2.js
import assert from "node:assert";
import fs from "fs";
import os from "os";
import { playlistSegments, startR2Sync } from "./r2.js";

assert.deepEqual(
  playlistSegments("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttps://cdn/live/s/1-0.ts\n"),
  ["1-0.ts"],
  "μόνο τα segments, χωρίς τα directives, χωρίς το base url"
);

// Ο ffmpeg γράφει στο ff/ με τα τελικά ονόματα. Το r2.js δημοσιεύει το πρώτο
// αμέσως από το origin και μετά κρατάει το live edge έναν κύκλο πίσω από τα PUT.
const dir = fs.mkdtempSync(`${os.tmpdir()}/r2-test-`);
fs.mkdirSync(`${dir}/ff`);
const dst = `${dir}/index.m3u8`;
const puts = [];

let failing = null; // segment που το R2 απορρίπτει
let attempts = 0;
let hold = null; // κρατάει το PUT ανοιχτό, για να δοκιμαστεί το stop() στη μέση
let activePuts = 0;
let peakPuts = 0;
let abortedPuts = 0;

globalThis.fetch = async (req) => {
  const name = new URL(req.url).pathname.split("/").pop();
  if (Array.isArray(failing) ? failing.includes(name) : name === failing) {
    attempts++;
    return new Response("boom", { status: 500 });
  }
  // Το κρατημένο PUT σέβεται την προθεσμία του r2.js, όπως ο undici: αλλιώς μια
  // κολλημένη σύνδεση δεν θα ξεκολλούσε ποτέ μέσα στο test.
  if (hold) {
    activePuts++;
    peakPuts = Math.max(peakPuts, activePuts);
    try {
      await Promise.race([
        hold,
        new Promise((_, reject) => req.signal?.addEventListener("abort", () => {
          abortedPuts++;
          reject(req.signal.reason);
        })),
      ]);
    } finally {
      activePuts--;
    }
  }
  puts.push(name);
  return new Response("", { status: 200 });
};

// Το URL του segment στο R2 (ό,τι γράφει ο ffmpeg με -hls_base_url) και η
// τοπική του διαδρομή, σχετική ως προς το δημοσιευμένο playlist.
const r2url = (s) => `https://cdn/live/s/${s}`;
const origin = (s) => `ff/${s}`;
const lines = (...urls) => `#EXTM3U\n${urls.map((u) => `#EXTINF:2.0,\n${u}\n`).join("")}`;
const playlist = (...segs) => lines(...segs.map(r2url));

const write = (...segs) => {
  for (const s of segs) fs.writeFileSync(`${dir}/ff/${s}`, "x".repeat(100));
  fs.writeFileSync(`${dir}/ff/index.m3u8`, playlist(...segs));
};

const until = async (fn, tries = 100) => {
  for (let i = 0; i < tries && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  return fn();
};

// Κάθε segment που φεύγει στο origin αναφέρεται μία φορά — έτσι το stats.js (και
// από εκεί το panel) βλέπει την υποβάθμιση όσο συμβαίνει, όχι στον λογαριασμό.
const fallen = [];
const stop = startR2Sync(dir, "/live/s", {
  endpoint: "https://r2.test",
  bucket: "b",
  accessKeyId: "k",
  secretAccessKey: "s",
  publicUrl: "https://cdn",
}, null, (name) => fallen.push(name));

write("1-0.ts");
assert.ok(await until(() => fs.existsSync(dst)), "το playlist δημοσιεύτηκε");
assert.deepEqual(puts, [], "το πρώτο segment δεν περιμένει ούτε ανεβαίνει στο R2");
assert.equal(fs.readFileSync(dst, "utf8"), lines(origin("1-0.ts")));

// Νέο segment στο παράθυρο: ανεβαίνει μόνο αυτό
write("1-0.ts", "1-1.ts");
assert.ok(await until(() => puts.length === 1), "ανέβηκε το νέο segment");
assert.deepEqual(puts, ["1-1.ts"], "το πρώτο segment μένει στο origin και δεν ξανανεβαίνει");

// Αποτυχημένο PUT: το playlist προχωράει ούτως ή άλλως, με το segment να δείχνει
// στο origin. Το R2 είναι βελτιστοποίηση, όχι εξάρτηση της αναπαραγωγής — ένα PUT
// που δεν προλαβαίνει κοστίζει λίγη κίνηση από τον δικό μας server, ποτέ παγωμένο
// playlist: εκεί ακριβώς έσπαγε, γιατί ο επόμενος γύρος έβρισκε ένα segment
// παραπάνω και αργούσε κι άλλο.
failing = "1-2.ts";
write("1-1.ts", "1-2.ts");
assert.ok(await until(() => attempts >= 1), "έγινε μία προσπάθεια PUT");
await new Promise((r) => setTimeout(r, 100));
assert.equal(attempts, 1, "ένα live segment δεν ξαναδοκιμάζεται μετά από αποτυχία");
failing = null;
write("1-2.ts", "1-3.ts");
assert.ok(
  await until(() => fs.readFileSync(dst, "utf8") === lines(r2url("1-1.ts"), origin("1-2.ts"))),
  "στην επόμενη αλλαγή το αποτυχημένο segment δημοσιεύεται από το origin"
);
assert.ok(await until(() => puts.includes("1-3.ts")), "το επόμενο segment ανέβηκε κανονικά");

// Μία προσπάθεια ανά segment και τέλος. Αμετάβλητο source playlist δεν μετακινεί
// το live edge και δεν ξαναβάζει το origin segment στην ουρά.
const tried = puts.length;
fs.writeFileSync(`${dir}/ff/index.m3u8`, playlist("1-2.ts", "1-3.ts"));
await new Promise((r) => setTimeout(r, 100));
assert.equal(puts.length, tried, "το segment που πήγε στο origin δεν ξαναανεβαίνει");
assert.equal(
  fs.readFileSync(dst, "utf8"),
  lines(r2url("1-1.ts"), origin("1-2.ts")),
  "και μένει στο origin όσο δεν αλλάζει το source playlist"
);
assert.deepEqual(fallen, ["1-2.ts"], "το segment που έφυγε στο origin αναφέρεται μία φορά");

// Η αναδίπλωση αφορά μόνο το segment που απέτυχε.
write("1-3.ts", "1-4.ts");
assert.ok(
  await until(() => fs.readFileSync(dst, "utf8") === lines(origin("1-2.ts"), r2url("1-3.ts"))),
  "μετά την αποτυχία, το επόμενο segment ξαναπάει στο R2"
);

// Το ολοκληρωμένο PUT δεν σπρώχνει μόνο του το live edge: το segment είχε έναν
// ολόκληρο κύκλο για να ανέβει και δημοσιεύεται στην *επόμενη* αλλαγή του
// playlist. Έτσι η καθυστέρηση είναι σταθερά ένα segment, όχι όσο έκανε το R2.
{
  const staged = fs.mkdtempSync(`${os.tmpdir()}/r2-staged-`);
  fs.mkdirSync(`${staged}/ff`);
  const body = (...segs) =>
    `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/staged/${s}\n`).join("")}`;
  const writeStaged = (...segs) => {
    for (const s of segs) fs.writeFileSync(`${staged}/ff/${s}`, "x".repeat(100));
    fs.writeFileSync(`${staged}/ff/index.m3u8`, body(...segs));
  };

  const stopStaged = startR2Sync(staged, "/live/staged", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  writeStaged("11-0.ts");
  await until(() => fs.existsSync(`${staged}/index.m3u8`));

  let releaseStaged;
  hold = new Promise((r) => (releaseStaged = r));
  writeStaged("11-0.ts", "11-1.ts");
  await new Promise((r) => setTimeout(r, 50));
  releaseStaged();
  hold = null;
  await new Promise((r) => setTimeout(r, 50));

  const afterUpload = fs.readFileSync(`${staged}/index.m3u8`, "utf8");
  stopStaged();
  fs.rmSync(staged, { recursive: true, force: true });

  assert.equal(
    afterUpload,
    "#EXTM3U\n#EXTINF:2.0,\nff/11-0.ts\n",
    "το uploaded segment περιμένει την επόμενη αλλαγή του source playlist"
  );
}

// Αν το προηγούμενο PUT τρέχει ακόμα όταν γεννηθεί το επόμενο segment, το live
// edge προχωράει αμέσως μέσω origin. Η ουρά upload δεν είναι πια και ουρά
// δημοσίευσης.
{
  const nonblocking = fs.mkdtempSync(`${os.tmpdir()}/r2-nonblocking-`);
  fs.mkdirSync(`${nonblocking}/ff`);
  const body = (...segs) =>
    `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/nonblocking/${s}\n`).join("")}`;
  const writeNonblocking = (...segs) => {
    for (const s of segs) fs.writeFileSync(`${nonblocking}/ff/${s}`, "x".repeat(100));
    fs.writeFileSync(`${nonblocking}/ff/index.m3u8`, body(...segs));
  };

  const stopNonblocking = startR2Sync(nonblocking, "/live/nonblocking", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  writeNonblocking("12-0.ts");
  await until(() => fs.existsSync(`${nonblocking}/index.m3u8`));

  let releaseNonblocking;
  hold = new Promise((r) => (releaseNonblocking = r));
  writeNonblocking("12-0.ts", "12-1.ts");
  await new Promise((r) => setTimeout(r, 50));
  writeNonblocking("12-0.ts", "12-1.ts", "12-2.ts");

  const advanced = await until(
    () => fs.readFileSync(`${nonblocking}/index.m3u8`, "utf8").includes("ff/12-1.ts"),
    25
  );
  const published = fs.readFileSync(`${nonblocking}/index.m3u8`, "utf8");
  releaseNonblocking();
  hold = null;
  stopNonblocking();
  fs.rmSync(nonblocking, { recursive: true, force: true });

  assert.ok(advanced, "το playlist προχωράει πριν ολοκληρωθεί το προηγούμενο PUT");
  assert.equal(
    published,
    "#EXTM3U\n#EXTINF:2.0,\nff/12-0.ts\n#EXTINF:2.0,\nff/12-1.ts\n",
    "το segment που δεν πρόλαβε δημοσιεύεται από το origin"
  );
}
// Το ABR γεννά πολλά αρχεία στο ίδιο tick, αλλά ποτέ δεν επιτρέπεται να ανοίξει
// περισσότερα από τέσσερα PUT ταυτόχρονα.
{
  const bounded = fs.mkdtempSync(`${os.tmpdir()}/r2-bounded-`);
  fs.mkdirSync(`${bounded}/ff`);
  const body = (...segs) =>
    `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/bounded/${s}\n`).join("")}`;
  const writeBounded = (...segs) => {
    for (const s of segs) fs.writeFileSync(`${bounded}/ff/${s}`, "x".repeat(100));
    fs.writeFileSync(`${bounded}/ff/index.m3u8`, body(...segs));
  };

  const stopBounded = startR2Sync(bounded, "/live/bounded", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  writeBounded("13-0.ts");
  await until(() => fs.existsSync(`${bounded}/index.m3u8`));

  let releaseBounded;
  hold = new Promise((r) => (releaseBounded = r));
  peakPuts = 0;
  writeBounded("13-0.ts", "13-1.ts", "13-2.ts", "13-3.ts", "13-4.ts", "13-5.ts", "13-6.ts");
  await new Promise((r) => setTimeout(r, 100));
  const observedPeak = peakPuts;

  releaseBounded();
  hold = null;
  await new Promise((r) => setTimeout(r, 50));
  stopBounded();
  fs.rmSync(bounded, { recursive: true, force: true });

  assert.equal(observedPeak, 4, "το upload queue κρατάει το concurrency ακριβώς στο 4");
}

// Αν το watcher αργήσει και το πρώτο playlist έχει ήδη περισσότερα segments,
// μόνο το πρώτο βγαίνει αμέσως από το origin. Τα νεότερα μπαίνουν κανονικά στο
// upload-ahead αντί να χαθεί ολόκληρο το αρχικό παράθυρο στο origin.
{
  const delayed = fs.mkdtempSync(`${os.tmpdir()}/r2-delayed-start-`);
  fs.mkdirSync(`${delayed}/ff`);
  const stopDelayed = startR2Sync(delayed, "/live/delayed", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  for (const name of ["15-0.ts", "15-1.ts"]) {
    fs.writeFileSync(`${delayed}/ff/${name}`, "x".repeat(100));
  }
  fs.writeFileSync(
    `${delayed}/ff/index.m3u8`,
    "#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/delayed/15-0.ts\n#EXTINF:2.0,\nhttps://cdn/live/delayed/15-1.ts\n"
  );

  await until(() => fs.existsSync(`${delayed}/index.m3u8`));
  await new Promise((r) => setTimeout(r, 100));
  const initial = fs.readFileSync(`${delayed}/index.m3u8`, "utf8");
  const uploadedNewer = puts.includes("15-1.ts");
  stopDelayed();
  fs.rmSync(delayed, { recursive: true, force: true });

  assert.equal(
    initial,
    "#EXTM3U\n#EXTINF:2.0,\nff/15-0.ts\n",
    "η καθυστερημένη πρώτη ανάγνωση δημοσιεύει μόνο το πρώτο segment"
  );
  assert.ok(uploadedNewer, "τα νεότερα segments της πρώτης ανάγνωσης ανεβαίνουν στο R2");
}

// --- Segment που χάθηκε κάτω από τα πόδια του γύρου --------------------------
// Ανάμεσα στο διάβασμα του playlist και στο διάβασμα του segment μεσολαβεί το
// rmSync του respawn: το αρχείο μπορεί να λείπει. Ένας γύρος που σκάει εκεί δεν
// δημοσιεύει *κανένα* playlist — μία χαμένη ανάγνωση σταματούσε και τα variants
// που δεν έφταιγαν σε τίποτα. Αντιμετωπίζεται σαν PUT που δεν πρόλαβε: το
// segment φεύγει στο origin (μία φορά, όπως όλα) και ο γύρος προχωράει.
{
  const gone = fs.mkdtempSync(`${os.tmpdir()}/r2-gone-`);
  fs.mkdirSync(`${gone}/ff`);
  const goneLogs = [];
  const goneWarn = console.warn;
  console.warn = (m) => goneLogs.push(m);
  const stopGone = startR2Sync(gone, "/live/g", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });

  // Το 8-0 υπάρχει στο playlist αλλά όχι στον δίσκο· το 8-1 κανονικά.
  fs.writeFileSync(`${gone}/ff/8-1.ts`, "x".repeat(100));
  fs.writeFileSync(
    `${gone}/ff/index.m3u8`,
    "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:8\n#EXTINF:2.0,\nhttps://cdn/live/g/8-0.ts\n#EXTINF:2.0,\nhttps://cdn/live/g/8-1.ts\n"
  );

  assert.ok(await until(() => fs.existsSync(`${gone}/index.m3u8`)), "το playlist δημοσιεύτηκε παρά το χαμένο αρχείο");
  assert.equal(
    fs.readFileSync(`${gone}/index.m3u8`, "utf8"),
    "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nff/8-1.ts\n",
    "το χαμένο segment αφαιρείται και το επόμενο ξεκινάει με discontinuity"
  );
  assert.ok(!puts.includes("8-1.ts"), "το πρώτο υπαρκτό segment βγαίνει αμέσως από το origin");
  assert.ok(!puts.includes("8-0.ts"), "για το χαμένο δεν έγινε ποτέ PUT");
  assert.ok(
    goneLogs.find((l) => l.includes("λείπει"))?.includes("ENOENT"),
    "η γραμμή της μετάβασης λέει γιατί: το αρχείο έλειπε"
  );

  console.warn = goneWarn;
  stopGone();
  fs.rmSync(gone, { recursive: true, force: true });
}

// Το stop κλείνει και τα PUT που βρίσκονται ήδη στο δίκτυο· δεν αρκεί να
// σταματήσει μόνο το watcher, γιατί το προηγούμενο stream μπορεί να συνεχίσει
// να καταναλώνει uplink μετά το reconnect.
{
  const cancelled = fs.mkdtempSync(`${os.tmpdir()}/r2-cancelled-`);
  fs.mkdirSync(`${cancelled}/ff`);
  const body = (...segs) =>
    `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/cancelled/${s}\n`).join("")}`;
  const writeCancelled = (...segs) => {
    for (const s of segs) fs.writeFileSync(`${cancelled}/ff/${s}`, "x".repeat(100));
    fs.writeFileSync(`${cancelled}/ff/index.m3u8`, body(...segs));
  };

  const stopCancelled = startR2Sync(cancelled, "/live/cancelled", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  writeCancelled("14-0.ts");
  await until(() => fs.existsSync(`${cancelled}/index.m3u8`));

  let releaseCancelled;
  hold = new Promise((r) => (releaseCancelled = r));
  abortedPuts = 0;
  writeCancelled("14-0.ts", "14-1.ts");
  await until(() => activePuts > 0);
  stopCancelled();
  const aborted = await until(() => abortedPuts === 1, 25);

  releaseCancelled();
  hold = null;
  fs.rmSync(cancelled, { recursive: true, force: true });
  assert.ok(aborted, "το stop() ακυρώνει αμέσως το ενεργό PUT");
}
// Ο περιοδικός γύρος, χωρίς κανένα event από το fs.watch: τα αρχεία εδώ υπάρχουν
// ήδη *πριν* στηθεί το watch, οπότε τίποτα δεν πρόκειται να το ξυπνήσει. Χωρίς
// τον γύρο του interval, ένα inotify watch που πεθαίνει σιωπηλά — όριο
// συστήματος, φάκελος που αντικαταστάθηκε — αφήνει το playlist παγωμένο για όλη
// την εκπομπή, με τον ffmpeg να γράφει κανονικά δίπλα.
{
  const quiet = fs.mkdtempSync(`${os.tmpdir()}/r2-poll-`);
  fs.mkdirSync(`${quiet}/ff`);
  fs.writeFileSync(`${quiet}/ff/3-0.ts`, "x".repeat(100));
  fs.writeFileSync(`${quiet}/ff/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/q/3-0.ts\n");
  const stopQuiet = startR2Sync(quiet, "/live/q", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  assert.ok(
    await until(() => fs.existsSync(`${quiet}/index.m3u8`), 250),
    "ο περιοδικός γύρος δημοσίευσε χωρίς κανένα event από το watch"
  );
  stopQuiet();
  fs.rmSync(quiet, { recursive: true, force: true });
}

// Μετά το stop() ο ίδιος φάκελος μπορεί να ανήκει αμέσως στην επόμενη εκπομπή.
// Καμία μεταγενέστερη αλλαγή του source playlist δεν επιτρέπεται να ξαναγράψει
// το δημοσιευμένο αρχείο της προηγούμενης.
const published = fs.readFileSync(dst, "utf8");
stop();
write("1-4.ts", "1-5.ts");
await new Promise((r) => setTimeout(r, 50));
assert.equal(fs.readFileSync(dst, "utf8"), published, "μετά το stop() δεν δημοσιεύεται playlist");

fs.rmSync(dir, { recursive: true, force: true });

// --- ABR: πολλά variants + master ------------------------------------------
// Ένας κανόνας για όλα: ό,τι *.m3u8 βρεθεί στο ff/ δημοσιεύεται με το ίδιο όνομα
// στον φάκελο του stream. Το master ξεχωρίζει από το #EXT-X-STREAM-INF και
// αντιγράφεται αυτούσιο — δείχνει σε σχετικά ονόματα variants, που μένουν στο
// origin γιατί εκεί μετράμε τους θεατές.
{
  const abr = fs.mkdtempSync(`${os.tmpdir()}/r2-abr-`);
  fs.mkdirSync(`${abr}/ff`);
  const before = puts.length;
  const master =
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nvsrc.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2800000\nv720.m3u8\n";
  const variant = (...segs) =>
    `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/abr/${s}\n`).join("")}`;

  // Στην εκκίνηση τα πρώτα variants βγαίνουν αμέσως από το DNS-only origin:
  // κανένα PUT δεν επιτρέπεται να κρατήσει κρυμμένο το master.
  let release2;
  hold = new Promise((r) => (release2 = r));

  const stop2 = startR2Sync(abr, "/live/abr", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });

  for (const s of ["2-src-0.ts", "2-720-0.ts"]) fs.writeFileSync(`${abr}/ff/${s}`, "x".repeat(50));
  fs.writeFileSync(`${abr}/ff/vsrc.m3u8`, variant("2-src-0.ts"));
  fs.writeFileSync(`${abr}/ff/v720.m3u8`, variant("2-720-0.ts"));
  fs.writeFileSync(`${abr}/ff/index.m3u8`, master);

  assert.ok(await until(() => fs.existsSync(`${abr}/index.m3u8`)), "το master δημοσιεύτηκε αμέσως");
  assert.equal(fs.readFileSync(`${abr}/index.m3u8`, "utf8"), master, "το master αντιγράφεται αυτούσιο");
  assert.equal(
    fs.readFileSync(`${abr}/vsrc.m3u8`, "utf8"),
    "#EXTM3U\n#EXTINF:2.0,\nff/2-src-0.ts\n",
    "το πρώτο variant της πηγής βγαίνει από το origin"
  );
  assert.equal(
    fs.readFileSync(`${abr}/v720.m3u8`, "utf8"),
    "#EXTM3U\n#EXTINF:2.0,\nff/2-720-0.ts\n",
    "και το πρώτο σκαλοπάτι βγαίνει από το origin"
  );
  assert.deepEqual(puts.slice(before), [], "κανένα πρώτο segment δεν ανεβαίνει χωρίς λόγο");
  release2();
  hold = null;

  stop2();
  fs.rmSync(abr, { recursive: true, force: true });
}

// --- Προθεσμία: ένα κολλημένο PUT ελευθερώνει τη θέση του -------------------
// Το background upload δεν επηρεάζει το live edge, αλλά ούτε επιτρέπεται να
// κρατάει για πάντα μία από τις τέσσερις θέσεις της ουράς.
{
  const slow = fs.mkdtempSync(`${os.tmpdir()}/r2-slow-`);
  fs.mkdirSync(`${slow}/ff`);
  const body = (...segs) =>
    `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/slow/${s}\n`).join("")}`;
  const writeSlow = (...segs) => {
    for (const s of segs) fs.writeFileSync(`${slow}/ff/${s}`, "x".repeat(100));
    fs.writeFileSync(`${slow}/ff/index.m3u8`, body(...segs));
  };

  const stopSlow = startR2Sync(slow, "/live/slow", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  writeSlow("4-0.ts");
  await until(() => fs.existsSync(`${slow}/index.m3u8`));

  let releaseSlow;
  hold = new Promise((r) => (releaseSlow = r));
  const abortedBefore = abortedPuts;
  writeSlow("4-0.ts", "4-1.ts");
  assert.ok(
    await until(() => abortedPuts === abortedBefore + 1, 150),
    "το κολλημένο PUT ακυρώνεται μέσα σε μία διάρκεια segment"
  );
  assert.equal(
    fs.readFileSync(`${slow}/index.m3u8`, "utf8"),
    "#EXTM3U\n#EXTINF:2.0,\nff/4-0.ts\n",
    "η προθεσμία του PUT δεν μετακινεί μόνη της το playlist"
  );

  releaseSlow();
  hold = null;
  writeSlow("4-0.ts", "4-1.ts", "4-2.ts");
  assert.ok(
    await until(() => fs.readFileSync(`${slow}/index.m3u8`, "utf8").includes("ff/4-1.ts")),
    "στον επόμενο κύκλο το εκπρόθεσμο segment δημοσιεύεται από το origin"
  );

  stopSlow();
  fs.rmSync(slow, { recursive: true, force: true });
}

// --- Συγχώνευση των watch events --------------------------------------------
// Τα rename events που φτάνουν στο ίδιο event-loop tick δίνουν μία ανάγνωση του
// directory. Με ABR ο ffmpeg αλλάζει πολλά variant playlists μαζί· δεν υπάρχει
// λόγος να ξαναδιαβάσουμε ακριβώς την ίδια κατάσταση για καθένα.
{
  const many = fs.mkdtempSync(`${os.tmpdir()}/r2-queue-`);
  fs.mkdirSync(`${many}/ff`);

  // Χωρίς πραγματικό watcher: τα events του λειτουργικού έρχονται όποτε θέλουν
  // και θα μετριόνταν κι αυτά ως γύροι. Εδώ ελέγχεται τι κάνει η ουρά με όσα
  // events της δώσουμε, όχι πόσα δίνει το inotify/FSEvents.
  let fire = null;
  const realWatch = fs.watch;
  fs.watch = (_target, cb) => {
    fire = () => cb("rename", "index.m3u8");
    return { on() {}, close() {} };
  };

  let rounds = 0;
  const realReaddir = fs.readdirSync;
  fs.readdirSync = (...args) => {
    rounds++;
    return realReaddir(...args);
  };

  let releaseMany;
  hold = new Promise((r) => (releaseMany = r));

  const stopMany = startR2Sync(many, "/live/q3", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  fs.writeFileSync(`${many}/ff/5-0.ts`, "x".repeat(100));
  fs.writeFileSync(`${many}/ff/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/q3/5-0.ts\n");
  fire(); // ο πρώτος γύρος δημοσιεύει αμέσως από το origin
  await until(() => fs.existsSync(`${many}/index.m3u8`));
  fs.writeFileSync(`${many}/ff/5-1.ts`, "x".repeat(100));
  fs.writeFileSync(
    `${many}/ff/index.m3u8`,
    "#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/q3/5-0.ts\n#EXTINF:2.0,\nhttps://cdn/live/q3/5-1.ts\n"
  );
  fire(); // ο επόμενος γύρος ξεκινάει background PUT
  await new Promise((r) => setTimeout(r, 30));
  rounds = 0; // ό,τι μετρηθεί από δω και πέρα είναι η ουρά
  for (let i = 0; i < 5; i++) fire();

  releaseMany();
  hold = null;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rounds, 1, "πέντε events όσο τρέχει ένας γύρος δίνουν έναν γύρο, όχι πέντε");

  stopMany();
  fs.watch = realWatch;
  fs.readdirSync = realReaddir;
  fs.rmSync(many, { recursive: true, force: true });
}

// --- Οι μεταβάσεις με κυλιόμενο παράθυρο -------------------------------------
// Το κλάδεμα του παραθύρου δεν επιτρέπεται να μπερδεύει τα logs των μεταβάσεων:
// το «πόσα έπεσαν» πρέπει να μετριέται στα segments του γύρου, όχι στο μέγεθος
// του fromOrigin — αλλιώς όταν στον ίδιο γύρο κλαδεύεται ένα παλιό όνομα και
// πέφτει ένα νέο, η διαφορά βγαίνει μηδέν και ο server γράφει «ξαναπρολαβαίνει»
// εν μέσω επεισοδίου (και «δεν προλαβαίνει» σε γύρο που όλα ανέβηκαν).
{
  const roll = fs.mkdtempSync(`${os.tmpdir()}/r2-roll-`);
  fs.mkdirSync(`${roll}/ff`);
  const only = (seg) => {
    fs.writeFileSync(`${roll}/ff/${seg}`, "x".repeat(100));
    fs.writeFileSync(`${roll}/ff/index.m3u8`, `#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/r/${seg}\n`);
  };
  const shown = () => (fs.existsSync(`${roll}/index.m3u8`) ? fs.readFileSync(`${roll}/index.m3u8`, "utf8") : "");

  const logs = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (m) => logs.push(m);
  console.error = (m) => logs.push(m);

  failing = ["9-0.ts", "9-1.ts", "9-2.ts"];
  const stopRoll = startR2Sync(roll, "/live/r", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });

  // Παράθυρο ενός segment: κάθε πτώση συνοδεύεται από κλάδεμα της προηγούμενης.
  for (const seg of failing) {
    only(seg);
    await until(() => shown().includes(`ff/${seg}`));
  }
  assert.equal(
    logs.filter((l) => l.includes("ξαναπρολαβαίνει")).length, 0,
    "όσο πέφτουν segments δεν γράφεται ποτέ επαναφορά"
  );

  failing = null;
  only("9-3.ts");
  await until(() => shown().includes("https://cdn/live/r/9-3.ts"));
  only("9-4.ts");
  await until(() => shown().includes("https://cdn/live/r/9-4.ts"));
  assert.equal(
    logs.filter((l) => l.includes("origin")).length, 1,
    "η αρχή του επεισοδίου γράφτηκε μία φορά — και καμία ψεύτικη μετά την επαναφορά"
  );
  assert.equal(
    logs.filter((l) => l.includes("ξαναπρολαβαίνει")).length, 1,
    "και η επαναφορά μία φορά"
  );

  console.warn = realWarn;
  console.error = realError;
  stopRoll();
  fs.rmSync(roll, { recursive: true, force: true });
}

// --- Το παράθυρο είναι και η μνήμη ------------------------------------------
// Τα ονόματα των segments είναι μοναδικά (prefix από Date.now()), οπότε όνομα
// που βγήκε από το παράθυρο δεν θα ξαναζητηθεί ποτέ: χωρίς κλάδεμα, τα
// uploaded/fromOrigin μιας 24/7 εκπομπής μεγαλώνουν για πάντα — δεκάδες MB τον
// μήνα για ονόματα που δεν αφορούν πια κανέναν. Η μόνη ορατή συνέπεια του
// κλαδέματος, και άρα το μόνο πράγμα που μπορεί να ελέγξει ένα test: όνομα που
// *ξαναφανεί* αφού ξεχάστηκε αντιμετωπίζεται σαν καινούργιο — ο γύρος διαβάζει
// την κατάσταση από τον δίσκο, και ο δίσκος είναι το playlist.
{
  const win = fs.mkdtempSync(`${os.tmpdir()}/r2-window-`);
  fs.mkdirSync(`${win}/ff`);
  const show = (...segs) => {
    for (const s of segs) fs.writeFileSync(`${win}/ff/${s}`, "x".repeat(100));
    fs.writeFileSync(
      `${win}/ff/index.m3u8`,
      `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/w/${s}\n`).join("")}`
    );
  };

  const stopWin = startR2Sync(win, "/live/w", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });

  show("7-0.ts");
  assert.ok(await until(() => fs.existsSync(`${win}/index.m3u8`)), "το πρώτο segment δημοσιεύτηκε");
  show("7-0.ts", "7-1.ts");
  assert.ok(await until(() => puts.includes("7-1.ts")), "το δεύτερο segment ανέβηκε");
  show("7-1.ts", "7-2.ts");
  assert.ok(await until(() => puts.includes("7-2.ts")), "το τρίτο segment ανέβηκε");

  // Με upload-ahead, το προηγούμενο source playlist είναι επίσης live state.
  // Χρειάζονται δύο διαδοχικά παράθυρα χωρίς το 7-0 για να ξεχαστεί.
  show("7-2.ts", "7-3.ts");
  assert.ok(await until(() => puts.includes("7-3.ts")), "το παράθυρο προχώρησε δύο φορές");
  const seen = puts.filter((n) => n === "7-0.ts").length;
  show("7-3.ts", "7-0.ts");
  assert.ok(
    await until(() => puts.filter((n) => n === "7-0.ts").length === seen + 1),
    "όνομα που βγήκε από source και staged παράθυρο ξανανεβαίνει"
  );

  // Το ίδιο και για κατάσταση origin: δύο παράθυρα την κλαδεύουν και μια
  // μεταγενέστερη επανεμφάνιση ξαναδοκιμάζει το R2.
  failing = "7-4.ts";
  attempts = 0;
  show("7-0.ts", "7-4.ts");
  await until(() => attempts === 1);
  failing = null;
  show("7-4.ts", "7-5.ts");
  assert.ok(
    await until(() => fs.readFileSync(`${win}/index.m3u8`, "utf8").includes("ff/7-4.ts")),
    "το αποτυχημένο segment δημοσιεύτηκε από το origin"
  );
  show("7-5.ts", "7-6.ts");
  await until(() => puts.includes("7-6.ts"));
  show("7-6.ts", "7-7.ts");
  await until(() => puts.includes("7-7.ts"));
  show("7-7.ts", "7-4.ts");
  assert.ok(
    await until(() => puts.includes("7-4.ts")),
    "και το ξεχασμένο origin segment ξαναδοκιμάζεται"
  );

  stopWin();
  fs.rmSync(win, { recursive: true, force: true });
}


// --- Τι γράφεται στα logs ---------------------------------------------------
// Όταν το R2 δεν προλαβαίνει, αποτυγχάνει *κάθε* segment: μια γραμμή ανά segment
// είναι δύο γραμμές το δευτερόλεπτο ανά εκπομπή — logs που δεν διαβάζει κανείς,
// ακριβώς την ώρα που πρέπει να διαβαστούν. Αυτό που χρειάζεται να φαίνεται
// είναι η μετάβαση: από πότε μέχρι πότε η εκπομπή πληρωνόταν από το uplink μας.
{
  const noisy = fs.mkdtempSync(`${os.tmpdir()}/r2-noise-`);
  fs.mkdirSync(`${noisy}/ff`);
  const only = (seg) => {
    fs.writeFileSync(`${noisy}/ff/${seg}`, "x".repeat(100));
    fs.writeFileSync(`${noisy}/ff/index.m3u8`, `#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/n/${seg}\n`);
  };
  const shown = () => (fs.existsSync(`${noisy}/index.m3u8`) ? fs.readFileSync(`${noisy}/index.m3u8`, "utf8") : "");

  const logs = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (m) => logs.push(m);
  console.error = (m) => logs.push(m);

  failing = ["6-0.ts", "6-1.ts", "6-2.ts"];
  const stopNoisy = startR2Sync(noisy, "/live/n", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });

  for (const seg of failing) {
    only(seg);
    await until(() => shown().includes(`ff/${seg}`));
  }
  assert.equal(
    logs.filter((l) => l.includes("origin")).length, 1,
    "τρία segments στο origin, μία γραμμή: το log δείχνει τη μετάβαση, όχι κάθε segment"
  );

  failing = null;
  only("6-3.ts");
  await until(() => shown().includes("https://cdn/live/n/6-3.ts"));
  assert.equal(
    logs.filter((l) => l.includes("ξαναπρολαβαίνει")).length, 1,
    "και μία γραμμή όταν το R2 ξαναπρολαβαίνει — αλλιώς δεν ξέρεις πότε τελείωσε"
  );

  console.warn = realWarn;
  console.error = realError;
  stopNoisy();
  fs.rmSync(noisy, { recursive: true, force: true });
}

// --- Upload-ahead: το playlist δεν περιμένει το PUT -------------------------
// Το πρώτο segment βγαίνει αμέσως από το DNS-only origin. Το PUT μπορεί να
// συνεχίζεται στο παρασκήνιο, αλλά δεν βρίσκεται πια στο κρίσιμο μονοπάτι της
// αναπαραγωγής.
{
  const ahead = fs.mkdtempSync(`${os.tmpdir()}/r2-ahead-`);
  fs.mkdirSync(`${ahead}/ff`);
  let releaseAhead;
  hold = new Promise((r) => (releaseAhead = r));

  const stopAhead = startR2Sync(ahead, "/live/ahead", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });
  fs.writeFileSync(`${ahead}/ff/10-0.ts`, "x".repeat(100));
  fs.writeFileSync(
    `${ahead}/ff/index.m3u8`,
    "#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/ahead/10-0.ts\n"
  );

  const publishedImmediately = await until(() => fs.existsSync(`${ahead}/index.m3u8`), 25);
  const published = publishedImmediately ? fs.readFileSync(`${ahead}/index.m3u8`, "utf8") : "";
  releaseAhead();
  hold = null;
  stopAhead();
  fs.rmSync(ahead, { recursive: true, force: true });

  assert.ok(publishedImmediately, "το πρώτο playlist δημοσιεύεται χωρίς να περιμένει το PUT");
  assert.equal(
    published,
    "#EXTM3U\n#EXTINF:2.0,\nff/10-0.ts\n",
    "το πρώτο segment σερβίρεται αμέσως από το DNS-only origin"
  );
}


console.log("r2.js OK");
