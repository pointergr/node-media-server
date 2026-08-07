import NodeMediaServer from "node-media-server";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { loadConfig, saveConfig } from "./config.js";
import { startStats } from "./stats.js";
import { startR2Sync } from "./r2.js";
import { patchAvc1 } from "./ertmp.js";

patchAvc1();

const config = await loadConfig();

// Χωρίς credentials το R2 είναι off και τα segments σερβίρονται από εδώ, όπως πριν.
// Trailing slash στο endpoint ή στο publicUrl δίνει "//" στο key και 404 σε κάθε
// segment, χωρίς κανένα ίχνος στα logs του server.
// Και τα δύο είναι placeholders στο config.example.json. Αν μείνουν ασυμπλήρωτα
// ενώ το accessKeyId είναι γεμάτο, ο server σηκώνεται κανονικά και το μόνο ίχνος
// είναι ένα "Invalid URL" ανά segment από το aws4fetch — ενώ το index.m3u8 δεν
// γράφεται ποτέ και δεν παίζει τίποτα. Καλύτερα να μη σηκωθεί καθόλου.
const noSlash = (o) => {
  const clean = {
    ...o,
    endpoint: (o.endpoint ?? "").replace(/\/+$/, ""),
    publicUrl: (o.publicUrl ?? "").replace(/\/+$/, ""),
  };
  for (const key of ["endpoint", "publicUrl"]) {
    if (!URL.canParse(clean[key])) throw new Error(`config.hls.r2.${key}: "${o[key]}" δεν είναι έγκυρο URL`);
  }
  return clean;
};
const r2 = config.hls.r2?.accessKeyId ? noSlash(config.hls.r2) : null;

// Το v4 παράγει jwt secret μόνο όταν τρέχει με το δικό του bin/app.js
if (!config.auth.jwt.secret) {
  config.auth.jwt.secret = crypto.randomBytes(32).toString("hex");
  await saveConfig(config);
}

const nms = new NodeMediaServer(config);

// Το v4 δεν κάνει HLS, οπότε το βγάζουμε με ffmpeg remux ανά stream.
// Κλειδί το streamPath, όχι το session.id: το job ανήκει στον φάκελο του stream,
// και δύο jobs στον ίδιο φάκελο γράφουν πάνω στο ίδιο ff.m3u8.
const hlsJobs = new Map();

nms.on("postPublish", (session) => {
  // Το nms βγάζει postPublish *πριν* ελέγξει αν το path έχει ήδη publisher
  // (broadcast_server.js:159 πριν το :160), και ο δεύτερος απορρίπτεται: το
  // isPublisher του δεν γίνεται ποτέ true, οπότε στο close καλείται donePlay και
  // donePublish δεν βγαίνει ποτέ γι' αυτόν. Χωρίς αυτόν τον έλεγχο, κάθε
  // reconnect του OBS πάνω σε session που δεν έχει κλείσει ακόμα αφήνει ένα
  // ζόμπι ffmpeg να γράφει για πάντα στο ίδιο ff.m3u8 — το index.m3u8 παίζει
  // πινγκ-πονγκ ανάμεσα σε δύο άσχετες σειρές segments και κανένας player δεν
  // προλαβαίνει να χτίσει buffer.
  if (hlsJobs.has(session.streamPath)) return;

  const dir = `${config.static.root}${session.streamPath}`;
  // Ο μετρητής των segments ξεκινάει από το 0 σε κάθε publish. Χωρίς μοναδικό
  // prefix ανά συνεδρία, το CDN σερβίρει τα segments της προηγούμενης κάτω από
  // τα ίδια ονόματα. Τα παλιά αρχεία φεύγουν, δεν τα πιάνει το delete_segments.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const prefix = Date.now();

  const ff = spawn(
    config.hls.ffmpeg,
    [
      "-i", `rtmp://127.0.0.1:${config.rtmp.port}${session.streamPath}`,
      // Το OBS βάζει SPS/PPS in-band μόνο στο *πρώτο* keyframe — στα υπόλοιπα τα
      // έχει μόνο το avcC. Το h264_mp4toannexb, που βάζει το ίδιο το mpegts muxer,
      // τα βλέπει εκεί, σηκώνει τα idr_sps_seen/idr_pps_seen και δεν τα ξαναβάζει
      // ποτέ: μόνο το segment 0 βγαίνει με παραμέτρους. Όποιος μπαίνει στο live
      // edge δεν παίρνει ούτε ανάλυση ούτε profile και βλέπει μαύρο — ενώ όποιος
      // ήταν συνδεδεμένος από την αρχή παίζει κανονικά και δεν το καταλαβαίνει.
      // Το ρητό mp4toannexb γυρίζει το extradata σε annex-b, και το dump_extra
      // (freq=keyframe by default) το ξαναγράφει πριν από κάθε keyframe. Σκέτο
      // dump_extra δεν κάνει: χώνει AVCC bytes σε annex-b stream και σκάει.
      "-bsf:v", "h264_mp4toannexb,dump_extra",
      "-c", "copy",
      "-f", "hls",
      "-hls_time", "2",
      // 6 segments = 12s παράθυρο. Δεν αλλάζει το latency (ο player μπαίνει τρία
      // segments πριν το live edge ούτως ή άλλως) — αλλάζει το περιθώριο: το .ts
      // μένει στον δίσκο 12s αντί για 6s, οπότε ένα PUT που απέτυχε προλαβαίνει
      // να ξαναδοκιμαστεί, κι ένας θεατής που έχασε ένα αίτημα προλαβαίνει να
      // ξαναζητήσει αντί να πέσει έξω από το παράθυρο.
      "-hls_list_size", "6",
      // temp_file: ο ffmpeg γράφει .tmp και κάνει rename, οπότε ποτέ κανείς —
      // ούτε ο player, ούτε το R2 sync — δεν διαβάζει μισογραμμένο αρχείο
      "-hls_flags", "delete_segments+temp_file",
      "-hls_segment_filename", `${dir}/${prefix}-%d.ts`,
      // Με R2 το playlist το γράφει το r2.js: ο ffmpeg βγάζει το δικό του σε
      // ff.m3u8 με απόλυτα URLs, και δημοσιεύεται ως index.m3u8 μόλις ανέβουν
      // τα segments που δείχνει.
      ...(r2 ? ["-hls_base_url", `${r2.publicUrl}${session.streamPath}/`] : []),
      `${dir}/${r2 ? "ff" : "index"}.m3u8`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  ff.on("error", (err) => console.error(`HLS ffmpeg failed: ${err.message}`));

  const job = { ff, stop: r2 && startR2Sync(dir, session.streamPath, r2) };
  hlsJobs.set(session.streamPath, job);

  // Αν ο ffmpeg πεθάνει μόνος του (σφάλμα στο RTMP, OOM), το job πρέπει να φύγει
  // από τον χάρτη: αλλιώς ο έλεγχος παραπάνω μπλοκάρει κάθε νέο job και το HLS
  // μένει νεκρό μέχρι να αποσυνδεθεί ο publisher — σιωπηλά, με τον watcher του R2
  // ανοιχτό. Στο κανονικό κλείσιμο το donePublish έχει ήδη σβήσει το entry.
  ff.on("exit", (code) => {
    if (hlsJobs.get(session.streamPath) !== job) return;
    console.error(`HLS ffmpeg ${session.streamPath}: exit ${code}`);
    job.stop?.();
    hlsJobs.delete(session.streamPath);
  });
});

nms.on("donePublish", (session) => {
  const job = hlsJobs.get(session.streamPath);
  job?.ff.kill("SIGKILL");
  job?.stop?.();
  hlsJobs.delete(session.streamPath);
});

startStats(nms, config);

nms.run();
