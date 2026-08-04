import NodeMediaServer from "node-media-server";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { loadConfig, saveConfig } from "./config.js";
import { startStats } from "./stats.js";

const config = await loadConfig();

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
  fs.mkdirSync(dir, { recursive: true });

  const ff = spawn(
    config.hls.ffmpeg,
    [
      "-i", `rtmp://127.0.0.1:${config.rtmp.port}${session.streamPath}`,
      "-c", "copy",
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "3",
      "-hls_flags", "delete_segments",
      `${dir}/index.m3u8`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  ff.on("error", (err) => console.error(`HLS ffmpeg failed: ${err.message}`));

  hlsJobs.set(session.id, ff);
});

nms.on("donePublish", (session) => {
  hlsJobs.get(session.id)?.kill("SIGKILL");
  hlsJobs.delete(session.id);
});

startStats(nms, config);

nms.run();
