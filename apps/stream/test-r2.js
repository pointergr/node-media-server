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
  if (name === failing) {
    attempts++;
    return new Response("boom", { status: 500 });
  }
  if (hold) await hold;
  puts.push(name);
  return new Response("", { status: 200 });
};

const playlist = (...segs) =>
  `#EXTM3U\n${segs.map((s) => `#EXTINF:2.0,\nhttps://cdn/live/s/${s}\n`).join("")}`;

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
assert.deepEqual(puts, ["1-0.ts", "1-1.ts"], "ανέβηκαν και τα δύο segments");
assert.ok(!publishedTooEarly, "το playlist γράφεται μόνο αφού ανέβουν τα segments");
assert.equal(fs.readFileSync(dst, "utf8"), playlist("1-0.ts", "1-1.ts"));

// Νέο segment στο παράθυρο: ξαναανεβαίνει μόνο αυτό
write("1-1.ts", "1-2.ts");
assert.ok(await until(() => puts.length === 3), "ανέβηκε το νέο segment");
assert.deepEqual(puts, ["1-0.ts", "1-1.ts", "1-2.ts"], "κανένα segment δεν ξαναανεβαίνει");

// Αποτυχημένο PUT: το playlist μένει εκεί που ήταν, ποτέ δεν δείχνει segment που
// δεν ανέβηκε — αλλιώς ο player τρώει 404 από το R2.
failing = "1-3.ts";
write("1-2.ts", "1-3.ts");
assert.ok(await until(() => attempts >= 3), "το aws4fetch ξαναπροσπάθησε (retries: 2)");
assert.equal(
  fs.readFileSync(dst, "utf8"),
  playlist("1-1.ts", "1-2.ts"),
  "με segment που απέτυχε, το playlist δεν δημοσιεύεται"
);

// ...και ο ffmpeg το έχει ήδη σβήσει από τον δίσκο: τα bytes τα κρατάμε από τον
// προηγούμενο γύρο, αλλιώς κάθε επόμενος γύρος έσκαγε σε ENOENT και το playlist
// έμενε παγωμένο μέχρι να βγει το όνομα από το παράθυρο.
failing = null;
fs.rmSync(`${dir}/ff/1-3.ts`);
fs.writeFileSync(`${dir}/ff/index.m3u8`, playlist("1-2.ts", "1-3.ts"));
assert.ok(
  await until(() => fs.readFileSync(dst, "utf8") === playlist("1-2.ts", "1-3.ts")),
  "ο επόμενος γύρος ανεβάζει το segment που είχε αποτύχει, χωρίς το αρχείο"
);

// Ο περιοδικός γύρος, χωρίς κανένα νέο event από το fs.watch: το playlist δεν το
// αγγίζει κανείς μετά την αποτυχία, οπότε μόνο το interval μπορεί να ξεπαγώσει
// το index.m3u8. Χωρίς αυτό, ένα inotify watch που πεθαίνει σιωπηλά αφήνει το
// playlist στην τελευταία επιτυχημένη έκδοση για όλη την εκπομπή.
failing = "1-6.ts";
write("1-5.ts", "1-6.ts");
assert.ok(await until(() => attempts >= 6), "το PUT του 1-6.ts απέτυχε");
assert.equal(
  fs.readFileSync(dst, "utf8"),
  playlist("1-2.ts", "1-3.ts"),
  "όσο αποτυγχάνει, το playlist δεν προχωράει"
);
failing = null;
assert.ok(
  await until(() => fs.readFileSync(dst, "utf8") === playlist("1-5.ts", "1-6.ts"), 250),
  "ο περιοδικός γύρος δημοσίευσε χωρίς event από το watch"
);

// stop() στη μέση ενός γύρου: μέχρι να τελειώσει το PUT, ο φάκελος μπορεί να
// ανήκει ήδη στην επόμενη εκπομπή (ίδιο path, νέα segments) — το καθυστερημένο
// playlist θα δημοσίευε τα segments της προηγούμενης, που υπάρχουν ακόμα στο R2.
// Χωρίς αναμονή σε συνθήκη εδώ: το ζητούμενο είναι ακριβώς ότι δεν γράφεται τίποτα.
const published = fs.readFileSync(dst, "utf8");
let release;
hold = new Promise((r) => (release = r));
write("1-3.ts", "1-4.ts");
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

console.log("r2.js OK");
