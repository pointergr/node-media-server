import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SAMPLE_MS = 60_000;
const RETENTION_DAYS = 30;
// Ο player ξαναζητά το playlist κάθε ~2s (hls_time). 30s αντέχει και ένα stall.
const HLS_TTL_MS = 30_000;
const CLEANUP_MS = 24 * 60 * 60 * 1000;
const ADMIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "admin");
const PAGES = { "/admin": "index.html", "/admin/": "index.html", "/admin/player": "player.html" };

// range -> [πόσο πίσω σε δευτερόλεπτα, μέγεθος bucket σε δευτερόλεπτα]
const RANGES = {
  "1h": [3600, 60],
  "24h": [86400, 300],
  "7d": [604800, 1800],
  "30d": [2592000, 7200],
};

const VIDEO_CODECS = { 7: "H.264", 12: "H.265", 13: "AV1" };
const AUDIO_CODECS = { 2: "MP3", 7: "G711a", 8: "G711u", 10: "AAC" };

// Το session.ip είναι "host:port" (rtmp_session.js:30), οπότε κόβουμε το port.
function isLocal(session) {
  const host = session.ip.slice(0, session.ip.lastIndexOf(":"));
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
}

export function startStats(nms, config) {
  // Το SQLite δεν φτιάχνει τον φάκελο μόνο του, και σε Docker το db ζει σε
  // volume (./data/stats.db) που στο πρώτο boot είναι άδειο.
  if (config.admin.db !== ":memory:") {
    fs.mkdirSync(path.dirname(config.admin.db), { recursive: true });
  }
  const db = new DatabaseSync(config.admin.db);
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
  const prevBytes = new Map(); //    streamPath -> {in, out} στο προηγούμενο δείγμα
  const lastBps = new Map(); //      streamPath -> {in_bps, out_bps}
  const hlsSeen = new Map(); //      streamPath -> Map(ip -> τελευταίο request σε ms)
  let prevCpu = process.cpuUsage();
  let prevTs = Date.now();

  const closed = (stream) => accBytes.get(stream) ?? { in: 0, out: 0 };
  const addOut = (stream, bytes) => {
    const acc = closed(stream);
    accBytes.set(stream, { in: acc.in, out: acc.out + bytes });
  };

  // Ο express.static του nms σερβίρει το HLS χωρίς session, οπότε οι θεατές του
  // μετριούνται από τα requests στο playlist, με ένα cookie ανά player.
  function hlsViewersOf(stream) {
    const seen = hlsSeen.get(stream);
    if (!seen) return 0;
    const cutoff = Date.now() - HLS_TTL_MS;
    for (const [key, ts] of seen) if (ts < cutoff) seen.delete(key);
    return seen.size;
  }

  const viewersOf = (stream) =>
    [...liveSessions.values()].filter((s) => !s.isPublisher && s.streamPath === stream).length +
    hlsViewersOf(stream);

  function trackHls(req, res) {
    const p = req.url.split("?")[0];
    if (!p.endsWith(".m3u8") && !p.endsWith(".ts")) return;
    const stream = p.slice(0, p.lastIndexOf("/"));
    res.on("finish", () => addOut(stream, Number(res.getHeader("content-length")) || 0));
    if (!p.endsWith(".m3u8")) return;

    // Πίσω από τον Caddy το remoteAddress είναι πάντα loopback.
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
    const token = req.headers.cookie?.match(/(?:^|;\s*)nmsv=([^;]+)/)?.[1];
    const seen = hlsSeen.get(stream) ?? new Map();
    hlsSeen.set(stream, seen);

    if (token) {
      seen.delete(ip); // το πρώτο request αυτού του player είχε μετρηθεί με την IP
      seen.set(token, Date.now());
      return;
    }
    // Χωρίς cookie: είτε πρώτο request, είτε client που δεν κρατάει cookies (wrk,
    // curl, cross-origin player χωρίς credentials). Κλειδί η IP, ώστε να μην
    // μετράει καινούριος θεατής σε κάθε request — υποβαθμίζεται σε μέτρηση ανά IP.
    seen.set(ip, Date.now());
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
    if (publishers.get(session.streamPath) === session) publishers.delete(session.streamPath);

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
    if (isLocal(session)) return;
    publishers.set(session.streamPath, session);
    liveSessions.set(session.id, session);
  });
  nms.on("postPlay", (session) => {
    if (isLocal(session)) return;
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

    const totals = new Map();
    for (const session of liveSessions.values()) {
      const t = totals.get(session.streamPath) ?? { in: 0, out: 0 };
      t.in += session.inBytes;
      t.out += session.outBytes;
      totals.set(session.streamPath, t);
    }

    for (const stream of publishers.keys()) {
      const t = totals.get(stream) ?? { in: 0, out: 0 };
      const acc = closed(stream);
      const cur = { in: t.in + acc.in, out: t.out + acc.out };
      const prev = prevBytes.get(stream) ?? cur;
      const in_bps = Math.max(0, Math.round(((cur.in - prev.in) * 8) / dt));
      const out_bps = Math.max(0, Math.round(((cur.out - prev.out) * 8) / dt));
      prevBytes.set(stream, cur);
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
      },
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
    if (p === "/admin/api/live") return json(res, 200, snapshot());
    if (p === "/admin/api/series") return json(res, 200, series(url.searchParams.get("range")));
    if (p === "/admin/api/sessions") {
      return json(res, 200, db.prepare("SELECT * FROM sessions ORDER BY end_ts DESC LIMIT 100").all());
    }
    if (PAGES[p]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(ADMIN_DIR, PAGES[p])));
    }
    json(res, 404, { error: "not found" });
  }

  cleanup();
  setInterval(sample, SAMPLE_MS);
  setInterval(cleanup, CLEANUP_MS);

  // Μόνο στο loopback — το auth το κάνει ο Caddy με basic_auth στο /admin*.
  // Σε container το loopback είναι του container: εκεί θέλει 0.0.0.0 και το
  // publish να δένεται στο loopback του host (-p 127.0.0.1:8001:8001).
  const host = config.admin.host ?? "127.0.0.1";
  http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  }).listen(config.admin.port, host, () => {
    console.log(`Admin listening on ${host}:${config.admin.port}`);
  });

  return { sample, snapshot, series, db };
}
