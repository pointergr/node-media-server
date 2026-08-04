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

globalThis.fetch = async (req) => {
  // Το playlist δεν πρέπει να υπάρχει όσο ανεβαίνει το πρώτο segment
  if (!puts.length && fs.existsSync(dst)) publishedTooEarly = true;
  puts.push(new URL(req.url).pathname.split("/").pop());
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

stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log("r2.js OK");
