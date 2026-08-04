// Έλεγχος του collector: node test-stats.js
import assert from "node:assert";
import { startStats } from "./stats.js";

const nms = {
  h: {},
  on(event, fn) { (this.h[event] ??= []).push(fn); },
  emit(event, session) { (this.h[event] ?? []).forEach((fn) => fn(session)); },
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

const { sample, snapshot, db } = startStats(nms, { admin: { port: 0, db: ":memory:" } });

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

const logged = db.prepare("SELECT * FROM sessions").all();
assert.equal(logged.length, 1, "μία γραμμή στο session log");
assert.equal(logged[0].out_bytes, 500_000);
assert.equal(logged[0].publisher, 0);

// Ο ffmpeg δεν πρέπει να γράφεται ούτε στο log
nms.emit("donePlay", ffmpeg);
assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions").get().c, 1, "το local session δεν λογάρεται");

console.log("stats.js OK");
process.exit(0);
