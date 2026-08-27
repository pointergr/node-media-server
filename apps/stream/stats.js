import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { clientOf, publishAllowed, closeSession } from "./config.js";

// Το dashboard κάνει poll ανά 5s: με δείγμα ανά 60s το bitrate έδειχνε «0 bps»
// για ένα ολόκληρο λεπτό μετά από κάθε restart ή νέο publish. Τα buckets των
// γραφημάτων είναι ≥60s, οπότε εκεί δεν αλλάζει τίποτα — απλώς μέσος όρος
// περισσότερων δειγμάτων.
const SAMPLE_MS = 10_000;
const RETENTION_DAYS = 30;
// Ο player ξαναζητά το playlist κάθε ~2s (hls_time). 30s αντέχει και ένα stall.
const HLS_TTL_MS = 30_000;
const CLEANUP_MS = 24 * 60 * 60 * 1000;

// range -> [πόσο πίσω σε δευτερόλεπτα, μέγεθος bucket σε δευτερόλεπτα]
const RANGES = {
  "1h": [3600, 60],
  "24h": [86400, 300],
  "7d": [604800, 1800],
  "30d": [2592000, 7200],
};

// Με enhanced RTMP το videocodecid του onMetaData είναι ο fourCC ως αριθμός
const VIDEO_CODECS = { 7: "H.264", 12: "H.265", 13: "AV1", 0x61766331: "H.264", 0x68766331: "H.265", 0x61763031: "AV1" };
const AUDIO_CODECS = { 2: "MP3", 7: "G711a", 8: "G711u", 10: "AAC" };

// Το session.ip είναι "host:port" (rtmp_session.js:30), οπότε κόβουμε το port.
function isLocal(session) {
  const host = session.ip.slice(0, session.ip.lastIndexOf(":"));
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
}

// onRestart: injectable ώστε το test να μην τερματίζει τον εαυτό του — σε
// production είναι το graceful shutdown του app.js (σκοτώνει τα ffmpeg jobs
// πριν το exit), εδώ απλά process.exit(0) γιατί δεν υπάρχουν jobs να ξέρει.
// stepsOf: τα σκαλοπάτια που όντως κωδικοποιεί ο ffmpeg αυτού του stream. Το
// ξέρει μόνο το app.js (εκεί ζουν τα jobs), και το snapshot πρέπει να δείχνει
// αυτό — όχι το ladder του πακέτου, που μπορεί να έχει κοπεί ολόκληρο από την
// ανάλυση της πηγής ή από το πλαφόν του server.
// relayStateOf: η κατάσταση των προορισμών αναδιανομής, από την ίδια πηγή και για
// τον ίδιο λόγο με το stepsOf — ένα relay που δεν συνδέεται είναι αόρατο από
// παντού αλλού, γιατί η εκπομπή συνεχίζει κανονικά σε RTMP και HLS.
// encoder: αυτός που πέρασε το probe του boot και όχι το config.hls.encoder — η
// αναδίπλωση σε x264 γράφεται μία φορά στο log και μετά δεν φαίνεται από πουθενά.
export function startStats(
  nms,
  config,
  { onRestart = () => process.exit(0), stepsOf = () => [], relayStateOf = () => [], encoder = "x264" } = {},
) {
  // Τα env overrides υπάρχουν για το docker-compose: αλλιώς κάθε deployment θα
  // έπρεπε να πειράξει με το χέρι το mounted config.json.
  const dbPath = process.env.ADMIN_DB ?? config.admin.db;

  // Το SQLite δεν φτιάχνει τον φάκελο μόνο του, και σε Docker το db ζει σε
  // volume (./data/stats.db) που στο πρώτο boot είναι άδειο.
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS samples (
      ts INTEGER NOT NULL, stream TEXT NOT NULL,
      viewers INTEGER NOT NULL, in_bps INTEGER NOT NULL, out_bps INTEGER NOT NULL,
      PRIMARY KEY (ts, stream)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS server_samples (
      ts INTEGER PRIMARY KEY, cpu_pct REAL, mem_mb REAL, streams INTEGER, sessions INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, stream TEXT, ip TEXT, protocol TEXT, publisher INTEGER,
      start_ts INTEGER, end_ts INTEGER, in_bytes INTEGER, out_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_end ON sessions (end_ts);
  `);

  const insertSample = db.prepare("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?)");
  const insertServer = db.prepare("INSERT OR REPLACE INTO server_samples VALUES (?,?,?,?,?)");
  const insertSession = db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?,?)");

  const liveSessions = new Map(); // session.id -> session
  const publishers = new Map(); //   streamPath -> session
  const accBytes = new Map(); //     streamPath -> {in, out} από κλειστά sessions + HLS
  const prevBytes = new Map(); //    streamPath -> {in, out, ts} στο προηγούμενο δείγμα
  const lastBps = new Map(); //      streamPath -> {in_bps, out_bps}
  const hlsSeen = new Map(); //      streamPath -> Map(ip -> τελευταίο request σε ms)
  // streamPath -> Map(variant -> Map(θεατής -> ms)). Δεύτερος χάρτης δίπλα στον
  // hlsSeen και όχι αντ' αυτού: ο θεατής που αλλάζει σκαλοπάτι είναι ένας θεατής
  // (ίδιο cookie, ίδιος φάκελος) για το όριο του πακέτου και για τα στατιστικά,
  // αλλά ο εκτιμητής εξόδου του R2 πρέπει να ξέρει ποιοι παίζουν τι — αλλιώς
  // κάθε segment μετριέται σαν να το κατέβασαν όλοι, ×N variants.
  const variantSeen = new Map();
  let prevCpu = process.cpuUsage();
  let prevTs = Date.now();

  const closed = (stream) => accBytes.get(stream) ?? { in: 0, out: 0 };

  // Τρέχον σωρευτικό σύνολο του stream: ανοιχτά sessions + ό,τι έχει κλείσει.
  // Ίδιος υπολογισμός στο sample() και στο seed του postPublish — αν αποκλίνουν,
  // το πρώτο δείγμα ενός stream βγάζει σκουπίδια.
  function curBytes(stream) {
    const acc = closed(stream);
    let inB = acc.in;
    let outB = acc.out;
    for (const s of liveSessions.values()) {
      if (s.streamPath !== stream) continue;
      inB += s.inBytes;
      outB += s.outBytes;
    }
    return { in: inB, out: outB };
  }

  const addOut = (stream, bytes) => {
    const acc = closed(stream);
    accBytes.set(stream, { in: acc.in, out: acc.out + bytes });
  };

  // Ο express.static του nms σερβίρει το HLS χωρίς session, οπότε οι θεατές του
  // μετριούνται από τα requests στο playlist, με ένα cookie ανά player. Η
  // εκκαθάριση γίνεται στο διάβασμα: δεν υπάρχει timer να ξεχάσει κανείς.
  function alive(seen) {
    if (!seen) return 0;
    const cutoff = Date.now() - HLS_TTL_MS;
    for (const [key, ts] of seen) if (ts < cutoff) seen.delete(key);
    return seen.size;
  }
  const hlsViewersOf = (stream) => alive(hlsSeen.get(stream));

  const viewersOf = (stream) =>
    [...liveSessions.values()].filter((s) => !s.isPublisher && s.streamPath === stream).length +
    hlsViewersOf(stream);

  // Το όριο είναι αθροιστικό σε όλα τα paths του πελάτη: το πακέτο πουλιέται ανά
  // πελάτη, όχι ανά κάμερα. Χωρίς πελάτη ή με limit 0/απόν, κανένα όριο.
  function overLimit(stream) {
    const c = clientOf(stream);
    if (!c?.limit) return false;
    return Object.keys(c.paths).reduce((n, p) => n + viewersOf(p), 0) >= c.limit;
  }

  // Ίδια συνθήκη ενεργοποίησης με το app.js/r2.js: χωρίς accessKeyId τα .ts
  // σερβίρονται ήδη από το origin, οπότε τα μετράει κανονικά το trackHls — ένας
  // δεύτερος πολλαπλασιασμός εδώ θα διπλομετρούσε.
  const r2Active = Boolean(config.hls?.r2?.accessKeyId);

  // streamPath -> Set(όνομα segment) ήδη προσμετρημένο. Το r2.js δεν ξαναπροσπαθεί
  // ένα όνομα που έχει ήδη ανέβει (uploaded Set στο r2.js), αλλά το κρατάμε και εδώ
  // σαν δεύτερη γραμμή άμυνας — αν αλλάξει ποτέ η λογική retry εκεί, δεν θέλουμε
  // ένα segment να μετρηθεί δύο φορές στο out_bps.
  const r2Counted = new Map();

  // streamPath -> { fallen, degraded }: πόσα segments σέρβιρε το origin επειδή
  // το R2 δεν πρόλαβε, και αν αυτό συμβαίνει *τώρα*. Η εκπομπή παίζει και τότε
  // (δες r2.js), αλλά το uplink πληρώνει τη διαφορά — και το μόνο ίχνος είναι
  // δύο γραμμές log. Το snapshot πάει στο panel ανά 10s: εκεί θα το δει κάποιος
  // όσο ακόμα συμβαίνει, όχι στον λογαριασμό κίνησης.
  const r2State = new Map();
  const r2StateOf = (stream) => {
    let st = r2State.get(stream);
    if (!st) r2State.set(stream, (st = { fallen: 0, degraded: false }));
    return st;
  };

  // Ένα segment δεν πρόλαβε το R2 και δημοσιεύτηκε με τοπική διαδρομή (το
  // r2.js το φωνάζει μία φορά ανά segment — δεν ξαναδοκιμάζει ποτέ όνομα).
  function addR2Fallback(stream) {
    if (!r2Active) return;
    const st = r2StateOf(stream);
    st.fallen += 1;
    st.degraded = true;
  }

  // Με R2 ενεργό το ffmpeg κάνει PUT τα segments κατευθείαν στο CDN — δεν
  // περνάνε ποτέ από τον δικό μας HTTP server, οπότε το trackHls() δεν τα βλέπει
  // ποτέ. Εκτίμηση αντί για μέτρηση: bytes του segment × ενεργοί HLS θεατές του
  // stream (όχι RTMP/FLV θεατές — αυτοί δεν περνάνε από CDN ούτως ή άλλως).
  // Υποεκτιμά όταν ένας θεατής μπει και τραβήξει μονομιάς όλο το παράθυρο των
  // 20s (δεν έχει προλάβει ακόμα να «φανεί» σε τόσα segments όσα κατέβασε), και
  // υπερεκτιμά όταν κάποιος κλείσει τον player μέσα στο παράθυρο HLS_TTL_MS των
  // 30s (μετράει ακόμα σαν θεατής παρόλο που έφυγε).
  function addR2Out(stream, name, bytes) {
    if (!r2Active) return;
    // Απόδειξη ότι το R2 ξαναπρολαβαίνει — πριν από το dedupe: και το retry
    // ενός ήδη μετρημένου ονόματος είναι PUT που πέτυχε.
    r2StateOf(stream).degraded = false;
    const counted = r2Counted.get(stream) ?? new Set();
    r2Counted.set(stream, counted);
    if (counted.has(name)) return; // retry/επαναϋποβολή του ίδιου segment
    counted.add(name);
    // <prefix>-720-3.ts: το ίδιο το όνομα λέει σε ποιο σκαλοπάτι ανήκει (το %v
    // του ffmpeg γίνεται το name του var_stream_map). Χωρίς ladder το όνομα
    // είναι <prefix>-3.ts και μετράνε όλοι οι θεατές του stream, όπως πάντα.
    const variant = name.match(/^\d+-(.+)-\d+\.ts$/)?.[1];
    addOut(stream, bytes * (variant === undefined
      ? hlsViewersOf(stream)
      : alive(variantSeen.get(stream)?.get(variant))));
  }

  function trackHls(req, res) {
    const p = req.url.split("?")[0];
    if (!p.endsWith(".m3u8") && !p.endsWith(".ts")) return;
    // Με R2 σε αναδίπλωση το segment έρχεται από το ff/ του stream — ίδιο stream,
    // ένα επίπεδο πιο κάτω. Το streamPath του nms είναι πάντα /app/name, δύο
    // κομμάτια: ένα *τρίτο* κομμάτι «ff» είναι ο φάκελος του ffmpeg, ενώ το
    // /live/ff είναι stream πελάτη που τυχαίνει να λέγεται έτσι.
    const folder = p.slice(0, p.lastIndexOf("/"));
    const stream = folder.endsWith("/ff") && folder.split("/").length > 3
      ? folder.slice(0, -3)
      : folder;
    res.on("finish", () => addOut(stream, Number(res.getHeader("content-length")) || 0));
    if (!p.endsWith(".m3u8")) return;

    // Πίσω από τον Caddy το remoteAddress είναι πάντα loopback.
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
    const token = req.headers.cookie?.match(/(?:^|;\s*)nmsv=([^;]+)/)?.[1];
    const seen = hlsSeen.get(stream) ?? new Map();
    hlsSeen.set(stream, seen);

    // v720.m3u8 -> "720". Το master (index.m3u8) δεν είναι σκαλοπάτι: ο θεατής
    // μετριέται κανονικά στο stream, αλλά δεν παίζει ακόμα κανένα variant — γι'
    // αυτό χάρτης μιας χρήσης που τον πετάει ο GC, αντί για δεύτερο κλάδο σε
    // κάθε set παρακάτω.
    const variant = p.slice(p.lastIndexOf("/") + 1).match(/^v(.+)\.m3u8$/)?.[1];
    let vSeen = new Map();
    if (variant !== undefined) {
      const byVariant = variantSeen.get(stream) ?? new Map();
      variantSeen.set(stream, byVariant);
      vSeen = byVariant.get(variant) ?? new Map();
      byVariant.set(variant, vSeen);
    }

    // Χωρίς cookie: είτε πρώτο request, είτε client που δεν κρατάει cookies (wrk,
    // curl, cross-origin player χωρίς credentials — το hls.js σε ξένο origin δεν
    // αποθηκεύει καν το Set-Cookie). Κλειδί IP+User-Agent, ώστε να μην μετράει
    // καινούριος θεατής σε κάθε request.
    // ponytail: δύο tabs του ίδιου browser μετρούν ως ένας θεατής· για ακριβή
    // μέτρηση χρειάζεται token στο URL του playlist από τον player.
    const key = `${ip}|${req.headers["user-agent"] ?? ""}`;

    // Πριν από κάθε seen.set, αλλιώς ο 201ος μπαίνει πρώτα στο σύνολο και μετά
    // κόβεται κάποιος άλλος. Θεατής που μετριέται ήδη περνάει πάντα — και με το
    // token του και με το IP+UA κλειδί του, γιατί ακριβώς σε αυτό το request
    // μετακομίζει από το δεύτερο στο πρώτο. Ο καινούριος παίρνει 404: ίδιο σήμα
    // με το «δεν εκπέμπει», οπότε ο player μπαίνει στον υπάρχοντα δρόμο
    // επανασύνδεσης. Rewrite του url και όχι δική μας απάντηση: το express
    // ακούει το ίδιο event και θα έγραφε δεύτερη απόκριση από πάνω.
    if (!seen.has(token ?? key) && !seen.has(key) && overLimit(stream)) {
      req.url = "/__full.m3u8";
      return;
    }

    if (token) {
      seen.delete(key); // το πρώτο request αυτού του player είχε μετρηθεί με IP+UA
      seen.set(token, Date.now());
      vSeen.delete(key);
      vSeen.set(token, Date.now());
      return;
    }
    seen.set(key, Date.now());
    vSeen.set(key, Date.now());
    res.setHeader(
      "Set-Cookie",
      `nmsv=${crypto.randomUUID()}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`
    );
  }
  // prepend: το express απαντάει στο ίδιο event και πρέπει να προλάβουμε το Set-Cookie
  nms.httpServer?.httpServer?.prependListener("request", trackHls);

  function finish(session) {
    if (isLocal(session)) return;
    liveSessions.delete(session.id);
    if (publishers.get(session.streamPath) === session) {
      publishers.delete(session.streamPath);
      variantSeen.delete(session.streamPath);
      // Νέο publish σε αυτό το streamPath θα ξεκινήσει με νέο prefix (Date.now()
      // στο app.js), άρα νέα ονόματα segments — τίποτα να ξαναχρησιμοποιηθεί εδώ.
      r2Counted.delete(session.streamPath);
      r2State.delete(session.streamPath);
    }

    // Τα bytes των κλειστών sessions συσσωρεύονται, αλλιώς το άθροισμα των live
    // πέφτει όταν αποχωρεί θεατής και βγαίνει αρνητικό bitrate.
    const acc = closed(session.streamPath);
    accBytes.set(session.streamPath, {
      in: acc.in + session.inBytes,
      out: acc.out + session.outBytes,
    });

    insertSession.run(
      session.id, session.streamPath, session.ip, session.protocol, session.isPublisher ? 1 : 0,
      Math.floor(session.createTime / 1000),
      Math.floor((session.endTime || Date.now()) / 1000),
      session.inBytes, session.outBytes
    );
  }

  // Το ffmpeg του HLS συνδέεται ως θεατής στο 127.0.0.1 — δεν είναι πραγματικός θεατής.
  nms.on("postPublish", (session) => {
    // rejected: το app.js απέρριψε το κλειδί. Το event βγαίνει μία φορά για
    // όλους τους listeners, οπότε χωρίς αυτό ο απορριφθείς θα καταγραφόταν.
    if (isLocal(session) || session.rejected) return;
    publishers.set(session.streamPath, session);
    liveSessions.set(session.id, session);
    // Χωρίς αρχικό δείγμα εδώ, το πρώτο sample() αυτού του stream έβγαζε πάντα 0
    // (prev = cur) και το bitrate εμφανιζόταν μόνο στο δεύτερο. Σε re-publish
    // υπάρχει ήδη prev — τα bytes είναι σωρευτικά, η συνέχεια δεν σπάει.
    if (!prevBytes.has(session.streamPath)) {
      prevBytes.set(session.streamPath, { ...curBytes(session.streamPath), ts: Date.now() });
    }
  });
  nms.on("postPlay", (session) => {
    // Η σειρά είναι κρίσιμη: ο ffmpeg του HLS συνδέεται ως θεατής από το
    // 127.0.0.1 και δεν πρέπει ΠΟΤΕ να κοπεί από όριο — ένα γεμάτο stream θα
    // σταματούσε να παράγει HLS συνολικά.
    if (isLocal(session)) return;
    if (overLimit(session.streamPath)) return closeSession(session);
    liveSessions.set(session.id, session);
  });
  nms.on("donePublish", finish);
  nms.on("donePlay", finish);

  function sample() {
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const dt = (now - prevTs) / 1000;
    prevTs = now;
    if (dt <= 0) return;

    // Ο έλεγχος στο postPublish πιάνει μόνο τη στιγμή της σύνδεσης. Πελάτης που
    // διαγράφηκε ή του άλλαξε το κλειδί ενώ εκπέμπει πρέπει να κοπεί χωρίς να
    // περιμένουμε να σταματήσει μόνος του — και ο έλεγχος στο publish φροντίζει
    // ώστε το reconnect του OBS να μην ξαναπεράσει.
    for (const [stream, pub] of publishers) {
      if (!publishAllowed(stream, pub.streamQuery?.key)) {
        console.error(`publish ${stream} ${pub.ip}: ανακλήθηκε, κλείσιμο`);
        closeSession(pub);
      }
    }

    for (const stream of publishers.keys()) {
      const cur = curBytes(stream);
      const prev = prevBytes.get(stream) ?? { ...cur, ts: now };
      // Το παράθυρο μετριέται ανά stream, όχι από το προηγούμενο tick: ένα stream
      // που ξεκίνησε στη μέση του διαστήματος αλλιώς βγάζει bitrate διαιρεμένο με
      // ολόκληρο το SAMPLE_MS αντί για τον χρόνο που όντως εκπέμπει.
      const sdt = (now - prev.ts) / 1000;
      const bps = (delta) => (sdt > 0 ? Math.max(0, Math.round((delta * 8) / sdt)) : 0);
      const in_bps = bps(cur.in - prev.in);
      const out_bps = bps(cur.out - prev.out);
      prevBytes.set(stream, { ...cur, ts: now });
      lastBps.set(stream, { in_bps, out_bps });
      insertSample.run(ts, stream, viewersOf(stream), in_bps, out_bps);
    }

    // process.cpuUsage() είναι σωρευτικό, το ποσοστό βγαίνει μόνο από διαφορά.
    const cpu = process.cpuUsage(prevCpu);
    prevCpu = process.cpuUsage();
    const cpuPct = (cpu.user + cpu.system) / 1000 / (dt * 1000) * 100;
    insertServer.run(
      ts, Number(cpuPct.toFixed(2)),
      Number((process.memoryUsage().rss / 1048576).toFixed(1)),
      publishers.size, liveSessions.size
    );
  }

  function cleanup() {
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
    db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM server_samples WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM sessions WHERE end_ts < ?").run(cutoff);
  }

  // Ο δίσκος του φακέλου που γράφει το HLS — το μόνο πράγμα που γεμίζει μόνο του
  // εδώ πάνω. null όταν ο φάκελος δεν υπάρχει ακόμα (πρώτο boot, πριν από το
  // πρώτο segment): ένα statfs που σκάει θα έριχνε ολόκληρο το snapshot, δηλαδή
  // και το /admin και το sync.
  function diskOf(root) {
    if (!root) return null;
    try {
      const { bsize, blocks, bavail } = fs.statfsSync(root);
      return {
        free_gb: Number((bavail * bsize / 1073741824).toFixed(1)),
        used_pct: Math.round((1 - bavail / blocks) * 100),
      };
    } catch {
      return null;
    }
  }

  function snapshot() {
    return {
      streams: [...publishers.entries()].map(([stream, pub]) => ({
        stream,
        ip: pub.ip,
        protocol: pub.protocol,
        since: pub.createTime,
        video: VIDEO_CODECS[pub.videoCodec] ?? String(pub.videoCodec || "-"),
        resolution: pub.videoWidth ? `${pub.videoWidth}x${pub.videoHeight}` : "-",
        audio: AUDIO_CODECS[pub.audioCodec] ?? String(pub.audioCodec || "-"),
        ladder: stepsOf(stream),
        relays: relayStateOf(stream),
        ...(r2Active && { r2: { ...r2StateOf(stream) } }),
        viewers: viewersOf(stream),
        ...(lastBps.get(stream) ?? { in_bps: 0, out_bps: 0 }),
      })),
      sessions: [...liveSessions.values()].map((s) => ({
        id: s.id, stream: s.streamPath, ip: s.ip, protocol: s.protocol,
        publisher: s.isPublisher, since: s.createTime,
        inBytes: s.inBytes, outBytes: s.outBytes,
      })),
      server: {
        uptime: process.uptime(),
        rss_mb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
        node: process.version,
        // Ο μέσος όρος του ενός λεπτού μόνο του δεν λέει τίποτα — «3» είναι
        // άνεση σε 8 πυρήνες και πνιγμός σε 2, γι' αυτό φεύγουν μαζί.
        load: Number(os.loadavg()[0].toFixed(2)),
        cpus: os.cpus().length,
        disk: diskOf(config.static?.root),
        encoder,
      },
      // Το dashboard το χρειάζεται για να μην παρουσιάσει το out_bps σαν μέτρηση
      // ενώ είναι εκτίμηση (δες addR2Out παραπάνω).
      r2Estimate: r2Active,
    };
  }

  function series(range) {
    const [back, bucket] = RANGES[range] ?? RANGES["24h"];
    const from = Math.floor(Date.now() / 1000) - back;
    return {
      bucket,
      from,
      streams: db.prepare(`
        SELECT (ts / ?) * ? AS t, stream,
               CAST(AVG(in_bps) AS INTEGER) AS in_bps,
               CAST(AVG(out_bps) AS INTEGER) AS out_bps,
               MAX(viewers) AS viewers
        FROM samples WHERE ts >= ? GROUP BY t, stream ORDER BY t
      `).all(bucket, bucket, from),
      server: db.prepare(`
        SELECT (ts / ?) * ? AS t, AVG(cpu_pct) AS cpu_pct, AVG(mem_mb) AS mem_mb
        FROM server_samples WHERE ts >= ? GROUP BY t ORDER BY t
      `).all(bucket, bucket, from),
    };
  }

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (req.method === "DELETE" && p.startsWith("/admin/api/sessions/")) {
      const session = liveSessions.get(p.slice("/admin/api/sessions/".length));
      if (!session) return json(res, 404, { error: "session not found" });
      session.close();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/admin/api/restart") {
      // 202 πρώτα, exit μετά: αν τερματίσουμε πριν απαντήσουμε, ο browser βλέπει
      // network error (connection reset) αντί για επιτυχία — το UI δεν μπορεί να
      // ξεχωρίσει αυτό από πραγματική αποτυχία του restart.
      json(res, 202, { ok: true });
      setTimeout(onRestart, 50);
      return;
    }
    if (p === "/admin/api/live") return json(res, 200, snapshot());
    if (p === "/admin/api/series") return json(res, 200, series(url.searchParams.get("range")));
    if (p === "/admin/api/sessions") {
      return json(res, 200, db.prepare("SELECT * FROM sessions ORDER BY end_ts DESC LIMIT 100").all());
    }
    json(res, 404, { error: "not found" });
  }

  cleanup();
  setInterval(sample, SAMPLE_MS);
  setInterval(cleanup, CLEANUP_MS);

  // Το auth γίνεται εδώ, όχι στον Caddy: έτσι ο κωδικός ζει μόνο στο config.json
  // και δεν χρειάζεται να κρατιέται συγχρονισμένος με ένα bcrypt hash σε άλλο
  // αρχείο, που κανείς δεν θυμάται να ενημερώσει όταν αλλάζουν οι κωδικοί.
  const user = config.auth.jwt.users[0];
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${user.username}:${user.password}`).toString("base64")}`
  );
  const authorized = (req) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  // Χωρίς Docker μένει στο loopback και το TLS το κάνει ο Caddy από μπροστά. Σε
  // container το loopback είναι του container, οπότε το compose δίνει 0.0.0.0 —
  // η θύρα δεν δημοσιεύεται στο host, φτάνει μόνο ο Caddy από το compose network.
  const host = process.env.ADMIN_HOST ?? config.admin.host ?? "127.0.0.1";
  const server = http.createServer((req, res) => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="admin"' });
        return res.end();
      }
      route(req, res);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  }).listen(config.admin.port, host, () => {
    console.log(`Admin listening on ${host}:${config.admin.port}`);
  });

  return { sample, snapshot, series, db, server, addR2Out, addR2Fallback };
}
