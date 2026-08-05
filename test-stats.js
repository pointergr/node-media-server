// Έλεγχος του collector: node test-stats.js
import assert from "node:assert";
import { startStats } from "./stats.js";

const nms = {
  h: {},
  on(event, fn) { (this.h[event] ??= []).push(fn); },
  emit(event, session) { (this.h[event] ?? []).forEach((fn) => fn(session)); },
  httpServer: { httpServer: { prependListener(event, fn) { nms.onRequest = fn; } } },
};

// Ένα HTTP request στο HLS, όπως έρχεται από τον Caddy. Γυρνάει το cookie που
// έστειλε ο server, ώστε το επόμενο request να μπορεί να το ξαναδώσει.
const hlsHit = (url, ip, { cookie, bytes = 0, ua = "Chrome" } = {}) => {
  const out = {};
  const res = {
    h: [],
    on(e, fn) { this.h.push(fn); },
    setHeader(k, v) { out[k] = v; },
    getHeader: () => bytes,
  };
  nms.onRequest({ url, headers: { "x-forwarded-for": ip, cookie, "user-agent": ua }, socket: {} }, res);
  res.h.forEach((fn) => fn());
  return out["Set-Cookie"]?.split(";")[0];
};

const session = (over) => ({
  id: Math.random().toString(36).slice(2),
  ip: "8.8.8.8:5000",
  protocol: "rtmp",
  streamPath: "/live/stream",
  isPublisher: false,
  createTime: Date.now(),
  endTime: 0,
  inBytes: 0,
  outBytes: 0,
  videoCodec: 7,
  videoWidth: 1920,
  videoHeight: 1080,
  audioCodec: 10,
  close() {},
  ...over,
});

const { sample, snapshot, db, server } = startStats(nms, {
  admin: { port: 0, db: ":memory:" },
  auth: { jwt: { users: [{ username: "admin", password: "μυστικό" }] } },
});

const publisher = session({ isPublisher: true });
const viewer = session({ ip: "1.2.3.4:6000" });
const ffmpeg = session({ ip: "127.0.0.1:7000" }); // ο HLS puller μας

nms.emit("postPublish", publisher);
nms.emit("postPlay", viewer);
nms.emit("postPlay", ffmpeg);

assert.equal(snapshot().streams.length, 1, "ένα ενεργό stream");
assert.equal(snapshot().streams[0].viewers, 1, "το local ffmpeg δεν μετράει ως θεατής");
assert.equal(snapshot().sessions.length, 2, "το local session δεν μπαίνει καθόλου στη λίστα");

const tick = () => new Promise((r) => setTimeout(r, 20));

// Δύο δείγματα με αυξημένα bytes -> θετικό bitrate
sample();
publisher.inBytes = 500_000;
viewer.outBytes = 500_000;
await tick();
sample();
const rows = db.prepare("SELECT * FROM samples ORDER BY ts").all();
assert.ok(rows.at(-1).in_bps > 0, "το bitrate εισόδου υπολογίζεται από τη διαφορά");
assert.ok(rows.at(-1).out_bps > 0, "το bitrate εξόδου υπολογίζεται από τη διαφορά");

// Ο θεατής φεύγει: τα bytes του πρέπει να συσσωρευτούν, αλλιώς βγαίνει αρνητικό bitrate
viewer.endTime = Date.now();
nms.emit("donePlay", viewer);
await tick();
sample();
for (const row of db.prepare("SELECT * FROM samples").all()) {
  assert.ok(row.in_bps >= 0 && row.out_bps >= 0, "ποτέ αρνητικό bitrate");
}
assert.equal(snapshot().streams[0].viewers, 0, "ο θεατής έφυγε");

// Client χωρίς cookies (wrk, curl): όσα requests κι αν κάνει, μετράει ως ένας
const cookie = hlsHit("/live/stream/index.m3u8", "5.5.5.5");
hlsHit("/live/stream/index.m3u8", "5.5.5.5");
hlsHit("/live/stream/index.m3u8", "5.5.5.5");
assert.ok(cookie?.startsWith("nmsv="), "το πρώτο request παίρνει cookie");
assert.equal(snapshot().streams[0].viewers, 1, "ένας client χωρίς cookie = ένας θεατής");

// Ο ίδιος player ξαναέρχεται με το cookie του: δεν διπλομετριέται
hlsHit("/live/stream/index.m3u8", "5.5.5.5", { cookie });
assert.equal(snapshot().streams[0].viewers, 1, "το cookie αντικαθιστά τη μέτρηση με IP");

// Δύο συσκευές πίσω από το ίδιο NAT: ίδια IP, διαφορετικά cookies
hlsHit("/live/stream/index.m3u8", "5.5.5.5", { cookie: "nmsv=aaa" });
hlsHit("/live/stream/index.m3u8", "5.5.5.5", { cookie: "nmsv=bbb" });
assert.equal(snapshot().streams[0].viewers, 3, "τρεις players πίσω από μία IP");

// Δύο browsers στον ίδιο υπολογιστή, σε ξένο origin (δεν κρατούν το cookie):
// ίδια IP, διαφορετικό User-Agent
hlsHit("/live/stream/index.m3u8", "6.6.6.6", { ua: "Firefox" });
hlsHit("/live/stream/index.m3u8", "6.6.6.6", { ua: "Safari" });
assert.equal(snapshot().streams[0].viewers, 5, "δύο browsers, ίδια IP, δύο θεατές");

hlsHit("/live/stream/1-0.ts", "5.5.5.5", { bytes: 400_000 });
await tick();
sample();
assert.ok(db.prepare("SELECT * FROM samples ORDER BY ts").all().at(-1).out_bps > 0, "τα bytes του HLS μπαίνουν στο out_bps");

const logged = db.prepare("SELECT * FROM sessions").all();
assert.equal(logged.length, 1, "μία γραμμή στο session log");
assert.equal(logged[0].out_bytes, 500_000);
assert.equal(logged[0].publisher, 0);

// Ο ffmpeg δεν πρέπει να γράφεται ούτε στο log
nms.emit("donePlay", ffmpeg);
assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions").get().c, 1, "το local session δεν λογάρεται");

// Το admin UI δεν έχει τίποτα άλλο μπροστά του — αν πέσει αυτό, είναι ορθάνοιχτο
const url = `http://127.0.0.1:${server.address().port}/admin/api/live`;
const creds = (u, p) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });

assert.equal((await fetch(url)).status, 401, "χωρίς credentials δεν περνάει");
assert.equal((await fetch(url, { headers: creds("admin", "λάθος") })).status, 401, "λάθος κωδικός");
assert.equal((await fetch(url, { headers: creds("λάθος", "μυστικό") })).status, 401, "λάθος χρήστης");
assert.equal((await fetch(url, { headers: creds("admin", "μυστικό") })).status, 200, "σωστά credentials");

console.log("stats.js OK");
process.exit(0);
