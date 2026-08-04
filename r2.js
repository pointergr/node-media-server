// Ανεβάζει τα HLS segments στο R2 και δημοσιεύει το playlist μόνο αφού ανέβουν.
// Το playlist μένει στο origin (εκεί μετράμε τους θεατές), τα segments φεύγουν
// από το R2 — έτσι δεν περνάει βίντεο από το CDN του domain.
import fs from "fs";
import { AwsClient } from "aws4fetch";

// Τα segments ενός playlist: κάθε γραμμή που δεν είναι directive. Με -hls_base_url
// είναι απόλυτα URLs, οπότε κρατάμε μόνο το όνομα του αρχείου.
export const playlistSegments = (playlist) =>
  playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("/").pop());

export function startR2Sync(dir, streamPath, r2) {
  const aws = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const uploaded = new Set();
  const src = `${dir}/ff.m3u8`;
  const dst = `${dir}/index.m3u8`;

  const put = async (name) => {
    const res = await aws.fetch(`${r2.endpoint}/${r2.bucket}${streamPath}/${name}`, {
      method: "PUT",
      body: fs.readFileSync(`${dir}/${name}`),
      headers: {
        "Content-Type": "video/mp2t",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
    if (!res.ok) throw new Error(`PUT ${name} -> ${res.status} ${await res.text()}`);
    uploaded.add(name);
  };

  // Το playlist γράφεται *μετά* τα uploads: αλλιώς ο player διαβάζει ένα segment
  // που δεν έχει ανέβει ακόμα στο R2 και τρώει 404.
  const sync = async () => {
    const started = Date.now();
    const playlist = fs.readFileSync(src, "utf8");
    for (const name of playlistSegments(playlist)) {
      if (!uploaded.has(name)) await put(name);
    }
    fs.writeFileSync(dst, playlist);
    // Αν ένας γύρος αργεί περισσότερο από το hls_time, τα uploads δεν προλαβαίνουν
    // τον ffmpeg και το latency μεγαλώνει μόνιμα. Είναι το μόνο σημείο που σπάει
    // σιωπηλά, γι' αυτό ουρλιάζει.
    const took = Date.now() - started;
    if (took > 2000) console.warn(`R2 sync ${streamPath}: ${took}ms, πιο αργό από το segment`);
  };

  // Watch στο directory, όχι στο αρχείο: με το temp_file flag ο ffmpeg γράφει
  // .tmp και κάνει rename, οπότε ένα watch πάνω στο αρχείο θα χανόταν στο πρώτο
  // κιόλας update. Οι φορτώσεις μπαίνουν σε σειρά — το sync δεν είναι reentrant.
  let chain = Promise.resolve();
  const watcher = fs.watch(dir, (_, file) => {
    if (file !== "ff.m3u8") return;
    chain = chain.then(sync).catch((err) => console.error(`R2 sync ${streamPath}: ${err.message}`));
  });

  return () => watcher.close();
}
