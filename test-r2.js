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

const dir = fs.mkdtempSync(`${os.tmpdir()}/r2-test-`);
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
  for (const s of segs) fs.writeFileSync(`${dir}/${s}`, "x".repeat(100));
  fs.writeFileSync(`${dir}/ff.m3u8`, playlist(...segs));
};

const until = async (fn) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
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

failing = null;
write("1-2.ts", "1-3.ts");
assert.ok(
  await until(() => fs.readFileSync(dst, "utf8") === playlist("1-2.ts", "1-3.ts")),
  "ο επόμενος γύρος ανεβάζει το segment που είχε αποτύχει"
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
console.log("r2.js OK");
