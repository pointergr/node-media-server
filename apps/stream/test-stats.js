// Έλεγχος του collector: node test-stats.js
import assert from "node:assert";
import fs from "fs";
import os from "os";

// Προσωρινό clients.json (το config.js διαβάζει το env στο import, γι' αυτό
// δυναμικό import). Όσο δεν υπάρχει, δεν υπάρχουν πελάτες και δεν επιβάλλεται
// τίποτα — δηλαδή όλα τα παρακάτω τρέχουν στη σημερινή συμπεριφορά.
const clientsFile = `${fs.mkdtempSync(`${os.tmpdir()}/stats-test-`)}/clients.json`;
process.env.CLIENTS_FILE = clientsFile;
// Το ADMIN_DB του container υπερισχύει του config (stats.js:42), οπότε χωρίς αυτό
// το `docker compose exec stream npm test` γράφει στην ΠΡΑΓΜΑΤΙΚΗ stats.db:
// ψεύτικοι θεατές και bitrate στα γραφήματα του πελάτη, και το test σκάει επειδή
// ο πίνακας δεν είναι άδειος.
process.env.ADMIN_DB = ":memory:";
const { startStats } = await import("./stats.js");
const { clearClientsCache } = await import("./config.js");

const nms = {
  h: {},
  on(event, fn) { (this.h[event] ??= []).push(fn); },
  emit(event, session) { (this.h[event] ?? []).forEach((fn) => fn(session)); },
  httpServer: { httpServer: { prependListener(event, fn) { nms.onRequest = fn; } } },
};

// Ένα HTTP request στο HLS, όπως έρχεται από τον Caddy. Γυρνάει το cookie που
// έστειλε ο server, ώστε το επόμενο request να μπορεί να το ξαναδώσει.
// Γυρνάει και το τελικό req.url: το όριο θεατών κόβει αλλάζοντάς το.
const hlsHit = (srv, url, ip, { cookie, bytes = 0, ua = "Chrome" } = {}) => {
  const out = {};
  const res = {
    h: [],
    on(e, fn) { this.h.push(fn); },
    setHeader(k, v) { out[k] = v; },
    getHeader: () => bytes,
  };
  const req = { url, headers: { "x-forwarded-for": ip, cookie, "user-agent": ua }, socket: {} };
  srv.onRequest(req, res);
  res.h.forEach((fn) => fn());
  return { cookie: out["Set-Cookie"]?.split(";")[0], url: req.url };
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
const { cookie } = hlsHit(nms, "/live/stream/index.m3u8", "5.5.5.5");
hlsHit(nms, "/live/stream/index.m3u8", "5.5.5.5");
hlsHit(nms, "/live/stream/index.m3u8", "5.5.5.5");
assert.ok(cookie?.startsWith("nmsv="), "το πρώτο request παίρνει cookie");
assert.equal(snapshot().streams[0].viewers, 1, "ένας client χωρίς cookie = ένας θεατής");

// Ο ίδιος player ξαναέρχεται με το cookie του: δεν διπλομετριέται
hlsHit(nms, "/live/stream/index.m3u8", "5.5.5.5", { cookie });
assert.equal(snapshot().streams[0].viewers, 1, "το cookie αντικαθιστά τη μέτρηση με IP");

// Δύο συσκευές πίσω από το ίδιο NAT: ίδια IP, διαφορετικά cookies
hlsHit(nms, "/live/stream/index.m3u8", "5.5.5.5", { cookie: "nmsv=aaa" });
hlsHit(nms, "/live/stream/index.m3u8", "5.5.5.5", { cookie: "nmsv=bbb" });
assert.equal(snapshot().streams[0].viewers, 3, "τρεις players πίσω από μία IP");

// Δύο browsers στον ίδιο υπολογιστή, σε ξένο origin (δεν κρατούν το cookie):
// ίδια IP, διαφορετικό User-Agent
hlsHit(nms, "/live/stream/index.m3u8", "6.6.6.6", { ua: "Firefox" });
hlsHit(nms, "/live/stream/index.m3u8", "6.6.6.6", { ua: "Safari" });
assert.equal(snapshot().streams[0].viewers, 5, "δύο browsers, ίδια IP, δύο θεατές");

hlsHit(nms, "/live/stream/1-0.ts", "5.5.5.5", { bytes: 400_000 });
await tick();
sample();
assert.ok(db.prepare("SELECT * FROM samples ORDER BY ts").all().at(-1).out_bps > 0, "τα bytes του HLS μπαίνουν στο out_bps");

// Με το R2 σε αναδίπλωση το segment το σερβίρει ο δικός μας server από το ff/ του
// stream: ίδιο stream, ένα επίπεδο πιο κάτω. Χωρίς αυτό τα bytes χρεώνονταν στο
// «/live/stream/ff» — path χωρίς publisher, δηλαδή πουθενά — και το out_bps του
// πραγματικού stream έδειχνε μηδέν ακριβώς την ώρα που ο server πλήρωνε τη ζημιά.
await tick();
sample();
hlsHit(nms, "/live/stream/ff/1-9.ts", "5.5.5.5", { bytes: 300_000 });
await tick();
sample();
assert.ok(
  db.prepare("SELECT * FROM samples WHERE stream = '/live/stream' ORDER BY ts").all().at(-1).out_bps > 0,
  "τα bytes του origin fallback χρεώνονται στο stream, όχι στο ff/"
);

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
assert.equal(
  (await (await fetch(url, { headers: creds("admin", "μυστικό") })).json()).r2Estimate, false,
  "χωρίς config.hls.r2 ο εκτιμητής δεν είναι ενεργός"
);

// --- εκτιμητής εξόδου R2 (addR2Out) -----------------------------------------
// Όταν το R2 είναι ενεργό τα .ts δεν αγγίζουν ποτέ αυτόν τον server (τα σερβίρει
// το CDN) — ο εκτιμητής παίρνει bitrate εξόδου από bytes segment × ενεργοί HLS
// θεατές. Δύο ξεχωριστά instances, ένα με R2 off κι ένα με R2 on: το r2Active
// αποφασίζεται μία φορά στο startStats() από το config.
function freshStats(hls, opts, extra) {
  const fakeNms = {
    h: {},
    on(event, fn) { (this.h[event] ??= []).push(fn); },
    emit(event, s) { (this.h[event] ?? []).forEach((fn) => fn(s)); },
    httpServer: { httpServer: { prependListener(event, fn) { fakeNms.onRequest = fn; } } },
  };
  const s = startStats(fakeNms, {
    admin: { port: 0, db: ":memory:" },
    auth: { jwt: { users: [{ username: "admin", password: "x" }] } },
    ...(hls && { hls }),
    ...extra,
  }, opts);
  return { nms: fakeNms, ...s };
}

// Το πρώτο δείγμα ενός νέου stream πρέπει να δίνει ήδη bitrate: το prev μπαίνει
// στο postPublish, όχι στο πρώτο sample(). Αλλιώς το dashboard δείχνει «0 bps»
// μέχρι το δεύτερο δείγμα — δύο ολόκληρα SAMPLE_MS μετά από κάθε restart.
{
  const s = freshStats(null);
  const pub = session({ isPublisher: true });
  s.nms.emit("postPublish", pub);
  pub.inBytes = 500_000;
  await tick();
  s.sample();
  assert.ok(s.snapshot().streams[0].in_bps > 0, "το πρώτο δείγμα μετά το publish έχει ήδη bitrate");
  s.server.close();
}

// R2 off: ο εκτιμητής δεν πρέπει να προσθέσει τίποτα — τα .ts μετρώνται ήδη
// πραγματικά από το trackHls, ένας δεύτερος πολλαπλασιασμός θα διπλομετρούσε.
// Αυτό είναι το πιο σοβαρό σφάλμα που θα μπορούσε να γίνει εδώ.
{
  const s = freshStats(null);
  s.nms.emit("postPublish", session({ isPublisher: true }));
  s.sample();
  s.addR2Out("/live/stream", "seg-0.ts", 1_000_000);
  await tick();
  s.sample();
  assert.equal(
    s.db.prepare("SELECT * FROM samples ORDER BY ts").all().at(-1).out_bps, 0,
    "εκτιμητής off όταν το R2 είναι off — καμία διπλομέτρηση"
  );
  // Χωρίς R2 δεν υπάρχει αναδίπλωση να δείξεις: το πεδίο λείπει εντελώς, όπως
  // κάθε προαιρετικό χαρακτηριστικό του σχήματος.
  assert.equal(s.snapshot().streams[0].r2, undefined, "R2 off: κανένα πεδίο r2 στο snapshot");
  s.server.close();
}

// R2 on
{
  const s = freshStats({ r2: { accessKeyId: "key" } });
  await tick(); // ο http server χρειάζεται έναν γύρο του event loop για να δεσμεύσει port
  const liveUrl = `http://127.0.0.1:${s.server.address().port}/admin/api/live`;
  assert.equal(
    (await (await fetch(liveUrl, { headers: creds("admin", "x") })).json()).r2Estimate, true,
    "με config.hls.r2.accessKeyId ο εκτιμητής είναι ενεργός"
  );

  s.nms.emit("postPublish", session({ isPublisher: true }));

  // Μηδέν θεατές -> μηδέν bytes, καθαρή περίπτωση
  s.sample();
  s.addR2Out("/live/stream", "seg-0.ts", 1_000_000);
  await tick();
  s.sample();
  assert.equal(
    s.db.prepare("SELECT * FROM samples ORDER BY ts").all().at(-1).out_bps, 0,
    "μηδέν HLS θεατές -> μηδέν bytes από τον εκτιμητή"
  );

  // Δύο θεατές μέσω requests στο playlist (ίδιο μηχανισμό με hlsSeen)
  hlsHit(s.nms, "/live/stream/index.m3u8", "9.9.9.9", { cookie: "nmsv=a" });
  hlsHit(s.nms, "/live/stream/index.m3u8", "9.9.9.9", { cookie: "nmsv=b" });

  // Πολλαπλασιασμός bytes × θεατές: ανάγουμε το out_bps πίσω σε bytes μέσω του
  // πραγματικού dt (μετρημένου γύρω από τα δείγματα) για να τον επαληθεύσουμε.
  s.sample();
  let t0 = Date.now();
  s.addR2Out("/live/stream", "seg-1.ts", 300_000);
  await tick();
  let t1 = Date.now();
  s.sample();
  let row = s.db.prepare("SELECT * FROM samples ORDER BY ts").all().at(-1);
  let impliedBytes = (row.out_bps * (t1 - t0) / 1000) / 8;
  assert.ok(
    Math.abs(impliedBytes - 300_000 * 2) < 300_000 * 2 * 0.3,
    `bytes × θεατές: αναμενόταν ~${300_000 * 2}, βγήκε ~${Math.round(impliedBytes)}`
  );

  // Retry του ίδιου segment (π.χ. sync() που ξανατρέχει): μετράει μία φορά, όχι δύο
  s.sample();
  t0 = Date.now();
  s.addR2Out("/live/stream", "seg-2.ts", 200_000);
  s.addR2Out("/live/stream", "seg-2.ts", 200_000); // ίδιο όνομα
  await tick();
  t1 = Date.now();
  s.sample();
  row = s.db.prepare("SELECT * FROM samples ORDER BY ts").all().at(-1);
  impliedBytes = (row.out_bps * (t1 - t0) / 1000) / 8;
  assert.ok(
    Math.abs(impliedBytes - 200_000 * 2) < 200_000 * 2 * 0.3,
    `retry ίδιου segment μετράει μία φορά: αναμενόταν ~${200_000 * 2}, βγήκε ~${Math.round(impliedBytes)}`
  );

  s.server.close();
}

// --- Ορατότητα υποβάθμισης R2 (addR2Fallback) --------------------------------
// Όταν το R2 δεν προλαβαίνει, τα segments σερβίρονται από το origin: η εκπομπή
// παίζει, αλλά το uplink πληρώνει τη διαφορά αθόρυβα — δύο γραμμές σε ένα log
// που δεν κοιτάει κανείς live. Το snapshot πάει στο panel ανά 10s, οπότε το
// σήμα ανήκει εκεί: πόσα segments έφυγαν από εμάς και αν συμβαίνει *τώρα*.
{
  const s = freshStats({ r2: { accessKeyId: "key" } });
  const pub = session({ isPublisher: true });
  s.nms.emit("postPublish", pub);
  assert.deepEqual(
    s.snapshot().streams[0].r2, { fallen: 0, degraded: false },
    "με R2 ενεργό το snapshot έχει το πεδίο r2 από την αρχή"
  );

  s.addR2Fallback("/live/stream");
  s.addR2Fallback("/live/stream");
  assert.deepEqual(
    s.snapshot().streams[0].r2, { fallen: 2, degraded: true },
    "κάθε segment που έφυγε στο origin μετράει, και το degraded ανάβει"
  );

  // Η επαναφορά είναι segment που όντως ανέβηκε — ίδιο κριτήριο με το log του
  // r2.js. Το fallen μένει: είναι το ιστορικό του επεισοδίου, όχι η κατάστασή του.
  s.addR2Out("/live/stream", "seg-up.ts", 1_000);
  assert.deepEqual(
    s.snapshot().streams[0].r2, { fallen: 2, degraded: false },
    "segment που ανέβηκε στο R2 σβήνει το degraded, το fallen μένει"
  );

  // Νέο publish στο ίδιο path = νέα εκπομπή: το επεισόδιο της προηγούμενης δεν
  // την ακολουθεί (ίδιο σκεπτικό με το r2Counted στο finish).
  s.nms.emit("donePublish", pub);
  s.nms.emit("postPublish", session({ isPublisher: true }));
  assert.deepEqual(
    s.snapshot().streams[0].r2, { fallen: 0, degraded: false },
    "το donePublish καθαρίζει το r2 state του stream"
  );
  s.server.close();
}

// --- ABR: θεατές ανά variant ------------------------------------------------
// Με ladder ο ίδιος θεατής ζητάει master και μετά το variant του, και αλλάζει
// σκαλοπάτι όποτε θέλει η γραμμή του. Είναι *ένας* θεατής (ίδιο cookie, ίδιος
// φάκελος) — αλλιώς το όριο του πακέτου θα έκοβε στο ένα τρίτο. Ο εκτιμητής
// εξόδου όμως πρέπει να ξέρει ποιοι παίζουν ποιο σκαλοπάτι: αλλιώς κάθε segment
// μετριέται σαν να το κατέβασαν όλοι, ×N variants.
{
  const s = freshStats({ r2: { accessKeyId: "key" } });
  s.nms.emit("postPublish", session({ isPublisher: true }));

  // Τρεις θεατές στο master...
  for (const c of ["nmsv=a", "nmsv=b", "nmsv=c"]) {
    hlsHit(s.nms, "/live/stream/index.m3u8", "9.9.9.9", { cookie: c });
  }
  // ...δύο στο 720 και ένας στο 480
  hlsHit(s.nms, "/live/stream/v720.m3u8", "9.9.9.9", { cookie: "nmsv=a" });
  hlsHit(s.nms, "/live/stream/v720.m3u8", "9.9.9.9", { cookie: "nmsv=b" });
  hlsHit(s.nms, "/live/stream/v480.m3u8", "9.9.9.9", { cookie: "nmsv=c" });

  assert.equal(s.snapshot().streams[0].viewers, 3, "ABR: τρεις θεατές, όχι εννιά");

  const impliedBytes = async (name, bytes) => {
    s.sample();
    const t0 = Date.now();
    s.addR2Out("/live/stream", name, bytes);
    await tick();
    const t1 = Date.now();
    s.sample();
    const row = s.db.prepare("SELECT * FROM samples ORDER BY ts").all().at(-1);
    return (row.out_bps * (t1 - t0) / 1000) / 8;
  };
  const close = (got, want, what) =>
    assert.ok(Math.abs(got - want) < want * 0.3, `${what}: αναμενόταν ~${want}, βγήκε ~${Math.round(got)}`);

  // Το ίδιο το όνομα του segment λέει σε ποιο σκαλοπάτι ανήκει.
  close(await impliedBytes("1700000000000-720-0.ts", 100_000), 100_000 * 2, "segment του 720 × οι θεατές του 720");
  close(await impliedBytes("1700000000000-480-0.ts", 50_000), 50_000 * 1, "segment του 480 × οι θεατές του 480");
  // Χωρίς ladder το όνομα δεν έχει variant και μετράνε όλοι οι θεατές του stream.
  close(await impliedBytes("1700000000000-7.ts", 40_000), 40_000 * 3, "segment χωρίς variant: όλοι οι θεατές");
  // Σκαλοπάτι που δεν το παίζει κανείς δεν κοστίζει κίνηση.
  close(await impliedBytes("1700000000000-240-0.ts", 90_000) + 1, 1, "variant χωρίς θεατές: μηδέν bytes");

  s.server.close();
}

// --- ABR: το snapshot λέει τι όντως παράγει ο ffmpeg -------------------------
// Όχι το ladder του πακέτου: τα σκαλοπάτια ≥ της πηγής κόβονται και το πλαφόν
// του server κόβει κι άλλα, οπότε ένα «720+480» σε πηγή 480p είναι στην πράξη
// καθόλου ABR. Ο admin πρέπει να βλέπει το δεύτερο — αλλιώς η ένδειξη στο panel
// λέει ψέματα ακριβώς όταν χρειάζεται να πει την αλήθεια.
{
  const s = freshStats(null, { stepsOf: (p) => (p === "/live/stream" ? [720, 480] : []) });
  s.nms.emit("postPublish", session({ isPublisher: true }));
  assert.deepEqual(s.snapshot().streams[0].ladder, [720, 480], "τα ενεργά σκαλοπάτια στο snapshot");
  s.server.close();
}
{
  const s = freshStats(null);
  s.nms.emit("postPublish", session({ isPublisher: true }));
  assert.deepEqual(s.snapshot().streams[0].ladder, [], "χωρίς ABR: άδειος πίνακας, όχι undefined");
  s.server.close();
}

// --- restart button (POST /admin/api/restart) -------------------------------
// Το πραγματικό onRestart (process.exit) θα σκότωνε το test· εδώ το injected
// callback απλά σημειώνει ότι κλήθηκε — το app.js δίνει το δικό του shutdown
// (σκοτώνει τα ffmpeg jobs πρώτα) αντί για το default.
{
  let restarted = false;
  const s = freshStats(null, { onRestart: () => { restarted = true; } });
  await tick(); // ο http server χρειάζεται έναν γύρο του event loop για να δεσμεύσει port
  const restartUrl = `http://127.0.0.1:${s.server.address().port}/admin/api/restart`;

  assert.equal(
    (await fetch(restartUrl, { method: "POST" })).status, 401,
    "χωρίς credentials δεν κάνει restart"
  );
  assert.equal(restarted, false, "401 δεν καλεί το onRestart");

  const res = await fetch(restartUrl, { method: "POST", headers: creds("admin", "x") });
  assert.equal(res.status, 202, "το restart απαντάει 202 πριν το exit");
  assert.equal(restarted, false, "το onRestart καλείται μετά την απάντηση, όχι πριν — αλλιώς ο browser βλέπει network error");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(restarted, true, "το POST καλεί το injected onRestart");

  restarted = false;
  const getRes = await fetch(restartUrl, { headers: creds("admin", "x") }); // GET, όχι POST
  assert.notEqual(getRes.status, 202, "GET στο ίδιο path δεν κάνει restart");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(restarted, false, "GET δεν καλεί το onRestart");

  s.server.close();
}

// --- πολλοί πελάτες: όριο θεατών, απόρριψη, ανάκληση ------------------------
// Από εδώ και κάτω υπάρχει clients.json, οπότε οι έλεγχοι είναι ενεργοί.
fs.writeFileSync(clientsFile, JSON.stringify({
  pelatis: { limit: 3, paths: { "/live/k1": "K1", "/live/k2": "K2" } },
}));
clearClientsCache();

// Το όριο είναι αθροιστικό σε όλα τα paths του πελάτη — το πακέτο πουλιέται ανά
// πελάτη, όχι ανά κάμερα.
{
  const s = freshStats(null);
  const first = hlsHit(s.nms, "/live/k1/index.m3u8", "1.1.1.1", { cookie: "nmsv=a" });
  hlsHit(s.nms, "/live/k1/index.m3u8", "1.1.1.2", { cookie: "nmsv=b" });
  hlsHit(s.nms, "/live/k2/index.m3u8", "1.1.1.3", { cookie: "nmsv=c" });
  assert.equal(first.url, "/live/k1/index.m3u8", "οι πρώτοι τρεις θεατές περνάνε");

  assert.equal(
    hlsHit(s.nms, "/live/k2/index.m3u8", "1.1.1.4", { cookie: "nmsv=d" }).url,
    "/__full.m3u8",
    "ο τέταρτος θεατής του πελάτη κόβεται, σε οποιοδήποτε path του"
  );
  // Κρίσιμο: ο ήδη μετρημένος ζητάει το playlist κάθε 2s — αν κοβόταν κι αυτός,
  // ένα γεμάτο stream θα έριχνε όσους ήδη βλέπουν.
  assert.equal(
    hlsHit(s.nms, "/live/k1/index.m3u8", "1.1.1.1", { cookie: "nmsv=a" }).url,
    "/live/k1/index.m3u8",
    "ο ήδη μετρημένος θεατής περνάει πάντα"
  );
  assert.equal(
    hlsHit(s.nms, "/live/stream/index.m3u8", "1.1.1.5").url,
    "/live/stream/index.m3u8",
    "path χωρίς πελάτη δεν έχει όριο θεατών"
  );

  // RTMP/FLV θεατής πάνω από το όριο κλείνει — αλλά ο ffmpeg του HLS συνδέεται
  // από 127.0.0.1 και δεν πρέπει ΠΟΤΕ να κοπεί: θα σταματούσε όλο το HLS.
  let closed = 0;
  s.nms.emit("postPlay", session({ streamPath: "/live/k1", close() { closed++; } }));
  assert.equal(closed, 1, "ο θεατής πάνω από το όριο κλείνει");
  assert.equal(s.snapshot().sessions.length, 0, "και δεν καταγράφεται");
  s.nms.emit("postPlay", session({ ip: "127.0.0.1:9000", streamPath: "/live/k1", close() { closed++; } }));
  assert.equal(closed, 1, "ο ffmpeg του HLS δεν κόβεται ποτέ από το όριο");
  s.server.close();
}

// Ο publisher που απέρριψε το app.js δεν πρέπει να εμφανιστεί στο dashboard:
// το postPublish βγαίνει μία φορά για όλους τους listeners.
{
  const s = freshStats(null);
  s.nms.emit("postPublish", session({ isPublisher: true, streamPath: "/live/k1", rejected: true }));
  assert.equal(s.snapshot().streams.length, 0, "ο απορριφθείς publisher δεν καταγράφεται");
  assert.equal(s.snapshot().sessions.length, 0, "ούτε στη λίστα sessions");
  s.server.close();
}

// Ανάκληση εν ώρα εκπομπής: αλλαγή κλειδιού ή διαγραφή πελάτη κόβει τον
// publisher στο επόμενο tick, χωρίς να περιμένουμε να σταματήσει μόνος του.
{
  const s = freshStats(null);
  let closed = 0;
  // destroySoon και όχι μόνο close(): το close() του nms είναι socket.end() και ο
  // publisher που αγνοεί το FIN συνεχίζει να εκπέμπει (δες closeSession).
  let destroyed = 0;
  s.nms.emit("postPublish", session({
    isPublisher: true, streamPath: "/live/k1",
    streamQuery: { key: "K1" }, close() { closed++; },
    socket: { destroySoon() { destroyed++; } },
  }));
  await tick();
  s.sample();
  assert.equal(closed, 0, "με σωστό κλειδί δεν κόβεται");

  fs.writeFileSync(clientsFile, JSON.stringify({ pelatis: { paths: { "/live/k1": "ΑΛΛΟ" } } }));
  clearClientsCache();
  await tick();
  s.sample();
  assert.equal(closed, 1, "αλλαγμένο κλειδί κόβει τον publisher μέσα σε ένα tick");
  assert.equal(destroyed, 1, "και το socket πέφτει, αλλιώς ο publisher συνεχίζει να εκπέμπει");
  s.server.close();
}

// ...και ένα stream που απλώς λέγεται «ff» δεν είναι σκαλωσιά. Το streamPath του
// nms είναι πάντα /app/name — δύο κομμάτια — οπότε ένα *τρίτο* κομμάτι «ff» είναι
// ο φάκελος του ffmpeg, ενώ το /live/ff είναι το stream ενός πελάτη. Χωρίς τη
// διάκριση, θεατές και bytes του /live/ff χρεώνονταν στο «/live»: σε κανέναν.
{
  fs.rmSync(clientsFile, { force: true });
  clearClientsCache();
  const s = freshStats(null);
  s.nms.emit("postPublish", session({ isPublisher: true, streamPath: "/live/ff" }));
  await tick();
  s.sample();
  hlsHit(s.nms, "/live/ff/1-0.ts", "5.5.5.5", { bytes: 250_000 });
  await tick();
  s.sample();
  assert.ok(
    s.db.prepare("SELECT * FROM samples WHERE stream = '/live/ff' ORDER BY ts").all().at(-1).out_bps > 0,
    "stream που λέγεται ff μετράει στον εαυτό του, όχι στο /live"
  );
  s.server.close();
}

// --- logs (GET /admin/api/logs) ---------------------------------------------
// Ο διαχειριστής δεν έχει ssh από το panel: ό,τι γράφει ο server στην κονσόλα
// μένει και σε ring buffer, αλλιώς το «γιατί πέθανε ο ffmpeg» ζει μόνο πάνω στο
// μηχάνημα — και το πού ζει έχει άλλη απάντηση σε pm2 και άλλη σε docker.
{
  const s = freshStats(null);
  await tick();
  const logsUrl = `http://127.0.0.1:${s.server.address().port}/admin/api/logs`;
  assert.equal((await fetch(logsUrl)).status, 401, "τα logs θέλουν τα ίδια credentials");

  console.error("δοκιμή: ο ffmpeg πέθανε");
  const lines = await (await fetch(logsUrl, { headers: creds("admin", "x") })).json();
  assert.deepEqual(
    { level: lines.at(-1).level, text: lines.at(-1).text },
    { level: "error", text: "δοκιμή: ο ffmpeg πέθανε" },
    "τελευταία γραμμή = η τελευταία που γράφτηκε, με το επίπεδό της"
  );
  assert.ok(lines.at(-1).ts > 0, "με ώρα — αλλιώς δεν ξέρεις αν είναι σημερινή");

  // Χωρίς πλαφόν μια 24/7 εκπομπή είναι διαρροή μνήμης. Ο σωρός γράφεται
  // σιωπηλά, αλλιώς είναι 400 γραμμές θόρυβος μέσα στο test.
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  for (let i = 0; i < 400; i++) console.log(`γραμμή ${i}`);
  process.stdout.write = out;

  const full = await (await fetch(logsUrl, { headers: creds("admin", "x") })).json();
  assert.equal(full.length, 300, "κρατάει τις τελευταίες 300 γραμμές");
  assert.equal(full.at(-1).text, "γραμμή 399", "η νεότερη μένει, η παλιότερη φεύγει");
  s.server.close();
}

// Το snapshot είναι ο ΜΟΝΟΣ δρόμος του panel προς το μηχάνημα — δεν υπάρχει ssh
// από το /admin, οπότε ό,τι λείπει από εδώ δεν φαίνεται πουθενά. Τα δύο που δεν
// τα ξέρει κανείς αλλού: ο δίσκος (τον γεμίζουν τα segments) και ο encoder που
// όντως τρέχει — το probe του app.js πέφτει σιωπηλά σε x264.
{
  const s = freshStats(null, { encoder: "nvenc" }, { static: { root: os.tmpdir() } });
  const srv = s.snapshot().server;
  assert.equal(srv.encoder, "nvenc", "ο encoder του probe, όχι του config");
  assert.equal(srv.cpus, os.cpus().length, "πυρήνες του μηχανήματος");
  assert.ok(srv.load >= 0, "load average του τελευταίου λεπτού");
  assert.ok(srv.disk.free_gb > 0, "ελεύθερος χώρος στον φάκελο του HLS");
  assert.ok(srv.disk.used_pct >= 0 && srv.disk.used_pct <= 100, "ποσοστό χρήσης δίσκου");
  s.server.close();
}

// Φάκελος που δεν υπάρχει ακόμα (πρώτο boot, πριν το πρώτο segment): το snapshot
// δεν σκάει — αλλιώς ένα statfs ρίχνει όλο το /admin και το sync μαζί.
{
  const s = freshStats(null, {}, { static: { root: "/δεν/υπάρχει" } });
  assert.equal(s.snapshot().server.disk, null, "άγνωστος φάκελος = disk null, όχι εξαίρεση");
  assert.equal(s.snapshot().server.encoder, "x264", "προεπιλογή encoder");
  s.server.close();
}

fs.rmSync(clientsFile.slice(0, clientsFile.lastIndexOf("/")), { recursive: true, force: true });
console.log("stats.js OK");
process.exit(0);
