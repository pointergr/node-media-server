import NodeMediaServer from "node-media-server";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { loadConfig, saveConfig } from "./config.js";
import { startStats } from "./stats.js";
import { startR2Sync } from "./r2.js";

const config = await loadConfig();

// Χωρίς credentials το R2 είναι off και τα segments σερβίρονται από εδώ, όπως πριν.
const r2 = config.hls.r2?.accessKeyId ? config.hls.r2 : null;

// Το v4 παράγει jwt secret μόνο όταν τρέχει με το δικό του bin/app.js
if (!config.auth.jwt.secret) {
  config.auth.jwt.secret = crypto.randomBytes(32).toString("hex");
  await saveConfig(config);
}

const nms = new NodeMediaServer(config);

// Το v4 δεν κάνει HLS, οπότε το βγάζουμε με ffmpeg remux ανά stream.
const hlsJobs = new Map();

nms.on("postPublish", (session) => {
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
      "-c", "copy",
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "3",
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

  hlsJobs.set(session.id, { ff, stop: r2 && startR2Sync(dir, session.streamPath, r2) });
});

nms.on("donePublish", (session) => {
  const job = hlsJobs.get(session.id);
  job?.ff.kill("SIGKILL");
  job?.stop?.();
  hlsJobs.delete(session.id);
});

startStats(nms, config);

nms.run();
