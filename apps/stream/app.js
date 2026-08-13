import NodeMediaServer from "node-media-server";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { loadConfig, saveConfig, publishAllowed } from "./config.js";
import { startPanelSync } from "./panel.js";
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

// Το nms 4.2.8 δεν έχει κανένα socket timeout, keepalive ή ping — grep για
// timeout|setKeepAlive|Ping|destroy σε όλο το src του βγάζει μηδέν. Ένα OBS που
// χάνεται χωρίς FIN (blip, NAT timeout, 4G) κρατάει έτσι το streamPath
// κατειλημμένο για πάντα: το broadcast.publisher δεν μηδενίζεται ποτέ, κάθε
// reconnect απορρίπτεται με "already has a publisher" και μόνο restart το
// ξεκολλάει. 15s χωρίς ούτε ένα byte από publisher σημαίνει νεκρή σύνδεση.
const PUBLISH_IDLE_MS = 15_000;

// Ο ffmpeg μπορεί να πεθάνει μόνος του (σφάλμα στο RTMP, OOM) ενώ ο publisher
// είναι μια χαρά. Το RTMP συνεχίζει να παίζει, οπότε τίποτα δεν φαίνεται
// σπασμένο — απλώς το playlist παγώνει και μένει έτσι μέχρι να ξανασυνδεθεί το
// OBS ή να γίνει restart ο server. Γι' αυτό ξανασηκώνεται μόνος του.
const RESPAWN_MS = 2000;
// Αν δεν αντέχει ούτε τόσο, το πρόβλημα δεν είναι παροδικό (λάθος codec, δίσκος
// γεμάτος) και ο ατέρμονος βρόχος spawn απλώς καίει τη μηχανή.
const RESPAWN_MIN_LIFE_MS = 5000;
const RESPAWN_MAX = 5;

// Ο φάκελος έχει ήδη ετοιμαστεί από το postPublish — εδώ μόνο ο ffmpeg, ώστε το
// respawn να μη σβήνει τα segments που παίζουν αυτή τη στιγμή οι θεατές.
function startFfmpeg(streamPath, job) {
  const dir = `${config.static.root}${streamPath}`;
  // Ο μετρητής των segments ξεκινάει από το 0 σε κάθε spawn. Χωρίς μοναδικό
  // prefix, το CDN σερβίρει τα segments της προηγούμενης σειράς κάτω από τα ίδια
  // ονόματα. Τα παλιά αρχεία φεύγουν, δεν τα πιάνει το delete_segments.
  // Είναι και η ώρα γέννησης αυτού του ffmpeg — δες το exit παρακάτω.
  const prefix = Date.now();

  const ff = spawn(
    config.hls.ffmpeg,
    [
      "-i", `rtmp://127.0.0.1:${config.rtmp.port}${streamPath}`,
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
      ...(r2 ? ["-hls_base_url", `${r2.publicUrl}${streamPath}/`] : []),
      `${dir}/${r2 ? "ff" : "index"}.m3u8`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  ff.on("error", (err) => console.error(`HLS ffmpeg failed: ${err.message}`));
  job.ff = ff;

  ff.on("exit", (code) => {
    // Ο ffmpeg που σκοτώσαμε εμείς (donePublish, shutdown, προηγούμενο respawn)
    // δεν πρέπει να ξανασηκώνεται.
    if (hlsJobs.get(streamPath) !== job || job.ff !== ff) return;
    job.fails = Date.now() - prefix < RESPAWN_MIN_LIFE_MS ? job.fails + 1 : 0;
    if (job.fails > RESPAWN_MAX) {
      console.error(`HLS ffmpeg ${streamPath}: exit ${code}, ${job.fails} αποτυχίες στη σειρά — τα παρατάω`);
      job.stop?.();
      hlsJobs.delete(streamPath);
      return;
    }
    console.error(`HLS ffmpeg ${streamPath}: exit ${code}, respawn σε ${RESPAWN_MS}ms`);
    job.timer = setTimeout(() => startFfmpeg(streamPath, job), RESPAWN_MS);
  });
}

nms.on("postPublish", (session) => {
  // Ο έλεγχος εκπομπής είναι δικός μας (auth.publish: false στο nms): κάθε path
  // ανήκει σε πελάτη του clients.json και θέλει το δικό του κλειδί. Στο OBS
  // μπαίνει στο Stream Key ως `stream?key=KEY` — το nms κόβει το query πριν
  // φτιάξει το streamPath, οπότε φάκελος HLS, στατιστικά και hlsJobs μένουν ίδια.
  // Πρώτος έλεγχος απ' όλους: ο απορριφθείς publisher δεν πρέπει να αφήσει πίσω
  // του ούτε timeout ούτε φάκελο ούτε ffmpeg.
  if (!publishAllowed(session.streamPath, session.streamQuery?.key)) {
    console.error(`publish ${session.streamPath} ${session.ip}: άκυρο κλειδί`);
    // Το ίδιο event το ακούει και το stats.js — χωρίς αυτό, ο απορριφθείς
    // publisher θα εμφανιζόταν στο dashboard σαν κανονική εκπομπή.
    session.rejected = true;
    session.close();
    return;
  }

  // δες PUBLISH_IDLE_MS. Το v4 βγάζει postPublish και για τον publisher που θα
  // απορρίψει· εκείνου το socket το κλείνει έτσι κι αλλιώς μόνο του.
  if (session.protocol === "rtmp") {
    session.socket.setTimeout(PUBLISH_IDLE_MS, () => {
      console.error(`RTMP publisher ${session.streamPath} ${session.ip}: ${PUBLISH_IDLE_MS}ms χωρίς δεδομένα, κλείσιμο`);
      session.socket.destroy();
    });
  }

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
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    ff: null,
    timer: null,
    fails: 0,
    // Το bytes×θεατές τρέχει μέσα στο stats.js (αυτό ξέρει τους HLS θεατές) — το
    // r2.js μόνο αναφέρει τι ανέβηκε, δεν κάνει require το stats.js. Ζει όσο ο
    // publisher, όχι όσο ένας ffmpeg: το respawn γράφει στον ίδιο φάκελο.
    stop: r2 && startR2Sync(dir, session.streamPath, r2, (name, bytes) =>
      stats.addR2Out(session.streamPath, name, bytes)),
  };
  hlsJobs.set(session.streamPath, job);
  startFfmpeg(session.streamPath, job);
});

nms.on("donePublish", (session) => {
  const job = hlsJobs.get(session.streamPath);
  if (!job) return;
  clearTimeout(job.timer);
  job.ff?.kill("SIGKILL");
  job.stop?.();
  hlsJobs.delete(session.streamPath);
  // Χωρίς publisher το playlist λέει ψέματα: δείχνει ακόμα έξι segments χωρίς
  // ENDLIST, οπότε ο player ξαναπαίζει την ουρά σε βρόχο νομίζοντας ότι είναι
  // live. Το 404 είναι το ίδιο σήμα με το «δεν εκπέμπει ακόμα» — ο player μπαίνει
  // στον υπάρχοντα δρόμο επανασύνδεσης και πιάνει την επόμενη εκπομπή μόλις
  // εμφανιστεί. Τα .ts μένουν, τα καθαρίζει το rmSync του επόμενου postPublish.
  fs.rmSync(`${config.static.root}${session.streamPath}/index.m3u8`, { force: true });
});

// Ο server δεν ξαναξεκινάει τον εαυτό του — τερματίζει καθαρά και τον ξανασηκώνει
// ο supervisor (pm2 σε bare metal, restart: unless-stopped σε Docker). Πριν το
// exit πρέπει να σκοτωθούν τα ffmpeg jobs: ένα ορφανό ffmpeg κρατάει κλειδωμένο
// το streamPath (δες σχόλιο στο hlsJobs παραπάνω) και το HLS του νέου process
// μένει νεκρό μέχρι να αποσυνδεθεί ο publisher. Ίδια συνάρτηση για Ctrl+C /
// docker stop και για το κουμπί «Restart» του admin UI, ώστε να μην υπάρχουν
// δύο διαφορετικοί δρόμοι προς το ίδιο cleanup.
function shutdown() {
  for (const job of hlsJobs.values()) {
    clearTimeout(job.timer);
    job.ff?.kill("SIGKILL");
    job.stop?.();
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const stats = startStats(nms, config, { onRestart: shutdown });
startPanelSync(config, stats.snapshot);

nms.run();
