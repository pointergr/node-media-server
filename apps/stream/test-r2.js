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

// Ο ffmpeg γράφει στο ff/ με τα τελικά ονόματα, το r2.js δημοσιεύει τα ίδια
// ονόματα ένα επίπεδο πάνω, αφού ανέβουν τα segments που δείχνουν.
const dir = fs.mkdtempSync(`${os.tmpdir()}/r2-test-`);
fs.mkdirSync(`${dir}/ff`);
const dst = `${dir}/index.m3u8`;
const puts = [];
let publishedTooEarly = false;

let failing = null; // segment που το R2 απορρίπτει
let attempts = 0;
let hold = null; // κρατάει το PUT ανοιχτό, για να δοκιμαστεί το stop() στη μέση

globalThis.fetch = async (req) => {
  // Το playlist δεν πρέπει να υπάρχει όσο ανεβαίνει το πρώτο segment
  if (!puts.length && fs.existsSync(dst)) publishedTooEarly = true;
  const name = new URL(req.url).pathname.split("/").pop();
  if (Array.isArray(failing) ? failing.includes(name) : name === failing) {
    attempts++;
    return new Response("boom", { status: 500 });
  }
  // Το κρατημένο PUT σέβεται την προθεσμία του r2.js, όπως ο undici: αλλιώς μια
  // κολλημένη σύνδεση δεν θα ξεκολλούσε ποτέ μέσα στο test.
  if (hold) {
    await Promise.race([
      hold,
      new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(req.signal.reason))),
    ]);
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

const stop = startR2Sync(dir, "/live/s", {
  endpoint: "https://r2.test",
  bucket: "b",
  accessKeyId: "k",
  secretAccessKey: "s",
  publicUrl: "https://cdn",
});

write("1-0.ts", "1-1.ts");
assert.ok(await until(() => fs.existsSync(dst)), "το playlist δημοσιεύτηκε");
assert.deepEqual([...puts].sort(), ["1-0.ts", "1-1.ts"], "ανέβηκαν και τα δύο segments");
assert.ok(!publishedTooEarly, "το playlist γράφεται μόνο αφού ανέβουν τα segments");
assert.equal(fs.readFileSync(dst, "utf8"), playlist("1-0.ts", "1-1.ts"));

// Νέο segment στο παράθυρο: ξαναανεβαίνει μόνο αυτό
write("1-1.ts", "1-2.ts");
assert.ok(await until(() => puts.length === 3), "ανέβηκε το νέο segment");
assert.deepEqual([...puts].sort(), ["1-0.ts", "1-1.ts", "1-2.ts"], "κανένα segment δεν ξαναανεβαίνει");

// Αποτυχημένο PUT: το playlist προχωράει ούτως ή άλλως, με το segment να δείχνει
// στο origin. Το R2 είναι βελτιστοποίηση, όχι εξάρτηση της αναπαραγωγής — ένα PUT
// που δεν προλαβαίνει κοστίζει λίγη κίνηση από τον δικό μας server, ποτέ παγωμένο
// playlist: εκεί ακριβώς έσπαγε, γιατί ο επόμενος γύρος έβρισκε ένα segment
// παραπάνω και αργούσε κι άλλο.
failing = "1-3.ts";
write("1-2.ts", "1-3.ts");
assert.ok(await until(() => attempts >= 3), "το aws4fetch ξαναπροσπάθησε (retries: 2)");
assert.ok(
  await until(() => fs.readFileSync(dst, "utf8") === lines(r2url("1-2.ts"), origin("1-3.ts"))),
  "το segment που απέτυχε δημοσιεύεται από το origin, το playlist δεν παγώνει"
);

// ...και μία προσπάθεια ανά segment, τέλος. Το segment που έφυγε στο origin δεν
// ξαναδοκιμάζεται στον επόμενο γύρο: ακριβώς όταν το R2 δεν προλαβαίνει, ο κάθε
// γύρος θα ξανάστελνε bytes που πια κανείς δεν πρόκειται να ζητήσει από εκεί —
// τρώγοντας το uplink που χρειάζεται τώρα το origin για να τα σερβίρει. Έτσι το
// backlog δεν πολλαπλασιάζεται: ο γύρος βλέπει μόνο ό,τι γέννησε ο ffmpeg από
// τον προηγούμενο και μετά.
failing = null;
const tried = puts.length;
fs.writeFileSync(`${dir}/ff/index.m3u8`, playlist("1-2.ts", "1-3.ts"));
await new Promise((r) => setTimeout(r, 100));
assert.equal(puts.length, tried, "το segment που πήγε στο origin δεν ξαναανεβαίνει");
assert.equal(
  fs.readFileSync(dst, "utf8"),
  lines(r2url("1-2.ts"), origin("1-3.ts")),
  "και μένει στο origin όσο είναι στο παράθυρο"
);

// Το επόμενο segment συνεχίζει κανονικά στο R2: η αναδίπλωση είναι του segment
// που δεν πρόλαβε, όχι της εκπομπής. Αλλιώς μια στιγμιαία αναλαμπή του R2 θα
// γύριζε όλη την υπόλοιπη εκπομπή στο origin.
failing = null;
write("1-3.ts", "1-4.ts");
assert.ok(
  await until(() => fs.readFileSync(dst, "utf8") === lines(origin("1-3.ts"), r2url("1-4.ts"))),
  "μετά την αποτυχία, το επόμενο segment ξαναπάει στο R2"
);

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

// stop() στη μέση ενός γύρου: μέχρι να τελειώσει το PUT, ο φάκελος μπορεί να
// ανήκει ήδη στην επόμενη εκπομπή (ίδιο path, νέα segments) — το καθυστερημένο
// playlist θα δημοσίευε τα segments της προηγούμενης, που υπάρχουν ακόμα στο R2.
// Χωρίς αναμονή σε συνθήκη εδώ: το ζητούμενο είναι ακριβώς ότι δεν γράφεται τίποτα.
const published = fs.readFileSync(dst, "utf8");
let release;
hold = new Promise((r) => (release = r));
write("1-4.ts", "1-5.ts");
await new Promise((r) => setTimeout(r, 50));
stop();
release();
hold = null;
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

  // Τα PUT μένουν ανοιχτά: όσο δεν έχει δημοσιευτεί variant, το master υπόσχεται
  // αρχεία που δεν υπάρχουν και οι πρώτοι 2-4s της εκπομπής βγάζουν 404.
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

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(`${abr}/index.m3u8`), "το master δεν δημοσιεύεται πριν από το πρώτο variant");
  release2();
  hold = null;

  assert.ok(await until(() => fs.existsSync(`${abr}/index.m3u8`)), "το master δημοσιεύτηκε");
  assert.equal(fs.readFileSync(`${abr}/index.m3u8`, "utf8"), master, "το master αντιγράφεται αυτούσιο");
  assert.equal(fs.readFileSync(`${abr}/vsrc.m3u8`, "utf8"), variant("2-src-0.ts"), "το variant της πηγής");
  assert.equal(fs.readFileSync(`${abr}/v720.m3u8`, "utf8"), variant("2-720-0.ts"), "και του σκαλοπατιού");
  assert.deepEqual(
    puts.slice(before).sort(),
    ["2-720-0.ts", "2-src-0.ts"],
    "ανέβηκαν τα segments και των δύο variants — και μόνο αυτά, ποτέ playlist"
  );

  stop2();
  fs.rmSync(abr, { recursive: true, force: true });
}

// --- Προθεσμία: ένα PUT που κρέμεται δεν παγώνει το playlist -----------------
// Η προθεσμία είναι όσο ένα segment: ό,τι δεν πρόλαβε φεύγει από το origin και ο
// γύρος κλείνει στην ώρα του. Με τα 5s του παλιού timeout, μία κολλημένη σύνδεση
// κρατούσε το index.m3u8 δυόμισι segments πίσω — σε κάθε γύρο, σωρευτικά.
{
  const slow = fs.mkdtempSync(`${os.tmpdir()}/r2-slow-`);
  fs.mkdirSync(`${slow}/ff`);
  let releaseSlow;
  hold = new Promise((r) => (releaseSlow = r));

  const stopSlow = startR2Sync(slow, "/live/slow", {
    endpoint: "https://r2.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    publicUrl: "https://cdn",
  });

  fs.writeFileSync(`${slow}/ff/4-0.ts`, "x".repeat(100));
  fs.writeFileSync(`${slow}/ff/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nhttps://cdn/live/slow/4-0.ts\n");

  assert.ok(
    await until(() => fs.existsSync(`${slow}/index.m3u8`), 150),
    "το playlist δημοσιεύτηκε μέσα σε μία προθεσμία segment, με το PUT ακόμα κρεμασμένο"
  );
  assert.equal(
    fs.readFileSync(`${slow}/index.m3u8`, "utf8"),
    "#EXTM3U\n#EXTINF:2.0,\nff/4-0.ts\n",
    "και το segment δείχνει στο origin"
  );

  releaseSlow();
  hold = null;
  stopSlow();
  fs.rmSync(slow, { recursive: true, force: true });
}

// --- Συγχώνευση της ουράς ---------------------------------------------------
// Όσα events κι αν έρθουν όσο τρέχει ένας γύρος, ακολουθεί *ένας* γύρος — όχι
// ένας ανά event. Με ABR ο ffmpeg γράφει ένα playlist ανά variant σε κάθε
// segment, οπότε η ουρά γέμιζε πιο γρήγορα απ' όσο άδειαζε και κάθε
// καθυστερημένος, άχρηστος γύρος έσπρωχνε πιο πίσω τον επόμενο πραγματικό.
// Το watch listener καλείται εδώ κατευθείαν: πόσα events δίνει το λειτουργικό
// για ένα γράψιμο είναι δική του υπόθεση, το ζητούμενο είναι τι κάνουμε εμείς
// με αυτά.
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

  fire(); // ο γύρος ξεκινάει και κρέμεται στο PUT
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

console.log("r2.js OK");
