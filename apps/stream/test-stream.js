// Δοκιμαστική εκπομπή χωρίς OBS: npm run test-stream [-- <rtmp host>]
//
// Χωρίς όρισμα χτυπάει το 127.0.0.1, δηλαδή ελέγχει μόνο RTMP -> HLS. Με το
// δημόσιο hostname (rtmp.stream.example.com) περνάει από έξω, οπότε μετράει και
// ως κανονικός publisher στα στατιστικά — το local ffmpeg το εξαιρεί το stats.js.
import { spawn } from "child_process";
import crypto from "crypto";
import { loadConfig } from "./config.js";

const host = process.argv[2] ?? "127.0.0.1";
const streamPath = "/live/stream";
const config = await loadConfig();

// Ίδιος υπολογισμός με το passwords.js, αλλά πάντα από το config.auth.secret:
// αυτό ελέγχει ο server, όχι ό,τι έτυχε να μείνει στο passwords.json.
const expire = Math.floor(Date.now() / 1000) + 3600;
const hash = crypto
  .createHash("md5")
  .update(`${streamPath}-${expire}-${config.auth.secret}`)
  .digest("hex");

const sign = config.auth.publish ? `?sign=${expire}-${hash}` : "";
const url = `rtmp://${host}:${config.rtmp.port}${streamPath}${sign}`;

console.log(`publish  -> rtmp://${host}:${config.rtmp.port}${streamPath}`);
console.log(`playlist -> ${streamPath}/index.m3u8   (Ctrl-C για τερματισμό)`);

spawn(
  config.hls.ffmpeg,
  [
    // -re: σε πραγματικό χρόνο. Χωρίς αυτό το ffmpeg στέλνει όσο γρήγορα μπορεί
    // και ο server βλέπει ριπή αντί για live.
    "-re",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine",
    // -g 60: keyframe κάθε 2s στα 30fps, δηλαδή το Keyframe Interval = 2 του OBS.
    // Αλλιώς τα segments βγαίνουν μεγαλύτερα από το hls_time.
    "-c:v", "libx264", "-preset", "veryfast", "-g", "60",
    "-c:a", "aac",
    "-f", "flv", url,
  ],
  { stdio: "inherit" }
).on("error", (err) => console.error(`ffmpeg: ${err.message}`));
