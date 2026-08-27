// Έλεγχος του χτισίματος των args του ffmpeg: node test-ladder.js
import assert from "node:assert";
import { BITRATES, ENCODERS, ffmpegArgs, waitForHeight } from "./ladder.js";

const base = { dir: "/m/live/x", streamPath: "/live/x", prefix: 1700000000000, rtmpPort: 1935 };
const r2 = { publicUrl: "https://cdn" };

// --- δρόμος αναδίπλωσης: χωρίς ladder τίποτα δεν αλλάζει ---------------------
// Ολόκληρος ο πίνακας, όχι δείγματα: αυτά είναι τα args που τρέχουν σήμερα σε
// κάθε παραγωγικό server και ένα stream χωρίς ladder δεν επιτρέπεται να δει
// ούτε μία διαφορετική σημαία.
const plain = [
  "-i", "rtmp://127.0.0.1:1935/live/x",
  "-bsf:v", "h264_mp4toannexb,dump_extra",
  "-c", "copy",
  "-f", "hls",
  "-hls_time", "2",
  "-hls_list_size", "10",
  "-hls_flags", "delete_segments+temp_file",
  "-hls_segment_filename", "/m/live/x/1700000000000-%d.ts",
  "/m/live/x/index.m3u8",
];
assert.deepEqual(ffmpegArgs({ ...base }), plain, "χωρίς ladder: τα σημερινά args");
assert.deepEqual(ffmpegArgs({ ...base, ladder: [] }), plain, "κενό ladder = χωρίς ladder");
assert.deepEqual(ffmpegArgs({ ...base, ladder: "" }), plain, "χαλασμένο ladder = χωρίς ladder");

// --- ladder -----------------------------------------------------------------
assert.deepEqual(
  ffmpegArgs({ ...base, ladder: [720, 480], srcHeight: 1080 }),
  [
    "-i", "rtmp://127.0.0.1:1935/live/x",
    "-filter_complex",
    "[0:v]split=2[s0][s1];[s0]scale=-2:'min(720,ih)'[v720];[s1]scale=-2:'min(480,ih)'[v480]",
    "-map", "0:v", "-c:v:0", "copy", "-bsf:v:0", "h264_mp4toannexb,dump_extra",
    "-map", "[v720]", "-c:v:1", "libx264", "-preset", "veryfast",
    "-b:v:1", "2800k", "-maxrate:v:1", "3000k", "-bufsize:v:1", "6000k",
    "-map", "[v480]", "-c:v:2", "libx264", "-preset", "veryfast",
    "-b:v:2", "1200k", "-maxrate:v:2", "1400k", "-bufsize:v:2", "2800k",
    "-map", "0:a", "-map", "0:a", "-map", "0:a", "-c:a", "copy",
    "-sc_threshold", "0",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "10",
    "-hls_flags", "delete_segments+temp_file",
    "-var_stream_map", "v:0,a:0,name:src v:1,a:1,name:720 v:2,a:2,name:480",
    "-master_pl_name", "index.m3u8",
    "-hls_segment_filename", "/m/live/x/1700000000000-%v-%d.ts",
    "/m/live/x/v%v.m3u8",
  ],
  "ladder 720+480 από πηγή 1080p"
);

const args = (over) => ffmpegArgs({ ...base, ...over });
const val = (a, flag) => a[a.indexOf(flag) + 1];

// Η κορυφή είναι πάντα η πηγή σε copy, και το bitstream filter ανήκει μόνο σε
// αυτήν: στα encoded ο x264 βγάζει δικό του annex-b extradata.
{
  const a = args({ ladder: [480], srcHeight: 1080 });
  assert.equal(val(a, "-c:v:0"), "copy", "η κορυφή είναι copy");
  assert.ok(a.includes("-bsf:v:0"), "το bsf μπαίνει στο copy stream");
  assert.ok(!a.includes("-bsf:v"), "και ποτέ καθολικά");
  assert.ok(!a.includes("-bsf:v:1"), "ούτε στα encoded");
  assert.equal(a.filter((x) => x === "-c:a").length, 1, "ένα -c:a copy για όλα τα variants");
  assert.equal(val(a, "-c:a"), "copy");
  assert.equal(a.filter((x) => x === "0:a").length, 2, "ένα -map 0:a ανά variant");
}

// Ποτέ upscale: σκαλοπάτι ≥ πηγής δεν έχει νόημα να κωδικοποιηθεί.
assert.deepEqual(
  args({ ladder: [1080, 720], srcHeight: 720 }),
  plain,
  "πηγή 720p με ladder 1080+720: κανένα σκαλοπάτι, πίσω στα σημερινά args"
);
assert.equal(
  val(args({ ladder: [720, 480], srcHeight: 720 }), "-var_stream_map"),
  "v:0,a:0,name:src v:1,a:1,name:480",
  "από πηγή 720p μένει μόνο το 480"
);

// Άγνωστο ύψος πηγής (το videoHeight δεν έχει φτάσει ακόμα στο postPublish):
// δεν φιλτράρουμε, αλλά το min(h,ih) του scale κρατάει την εγγύηση.
assert.ok(
  val(args({ ladder: [1080] }), "-filter_complex").includes("scale=-2:'min(1080,ih)'"),
  "χωρίς srcHeight το scale δεν ανεβάζει ποτέ ανάλυση"
);

// Πλαφόν του μηχανήματος, ανεξάρτητο από το τι πουλήθηκε.
assert.equal(
  val(args({ ladder: [720, 480, 360, 240], srcHeight: 1080 }), "-var_stream_map"),
  "v:0,a:0,name:src v:1,a:1,name:720 v:2,a:2,name:480 v:3,a:3,name:360",
  "default πλαφόν 3 encoded renditions"
);
assert.equal(
  val(args({ ladder: [720, 480, 360], srcHeight: 1080, maxRenditions: 1 }), "-var_stream_map"),
  "v:0,a:0,name:src v:1,a:1,name:720",
  "το πλαφόν κόβει μετά το φιλτράρισμα"
);

// --- encoder: ρύθμιση του server, όχι του πλάνου -----------------------------
// Ο server χωρίς GPU δεν έχει καν το πεδίο στο config.json, και δεν επιτρέπεται
// να δει ούτε μία διαφορετική σημαία από ό,τι σήμερα.
const abr = args({ ladder: [720, 480], srcHeight: 1080 });
assert.deepEqual(args({ ladder: [720, 480], srcHeight: 1080, encoder: "x264" }), abr, "ρητό x264 = default");
assert.deepEqual(args({ ladder: [720, 480], srcHeight: 1080, encoder: "" }), abr, "κενό = x264");
assert.deepEqual(
  args({ ladder: [720, 480], srcHeight: 1080, encoder: "gpu9000" }),
  abr,
  "άγνωστος encoder = x264· τυπογραφικό στο config δεν ρίχνει εκπομπές"
);

// Με GPU αλλάζουν *μόνο* τα codec args κάθε σκαλοπατιού. Ολόκληρος ο πίνακας,
// γιατί εδώ ακριβώς είναι ο κίνδυνος: μια σημαία που ξεφεύγει στο υπόλοιπο
// pipeline (bsf, var_stream_map, ονόματα αρχείων) σπάει R2 και στατιστικά.
assert.deepEqual(
  args({ ladder: [720], srcHeight: 1080, encoder: "nvenc" }),
  [
    "-i", "rtmp://127.0.0.1:1935/live/x",
    "-filter_complex", "[0:v]split=1[s0];[s0]scale=-2:'min(720,ih)'[v720]",
    "-map", "0:v", "-c:v:0", "copy", "-bsf:v:0", "h264_mp4toannexb,dump_extra",
    "-map", "[v720]", "-c:v:1", "h264_nvenc", "-preset", "p4", "-rc", "cbr",
    "-b:v:1", "2800k", "-maxrate:v:1", "3000k", "-bufsize:v:1", "6000k",
    "-map", "0:a", "-map", "0:a", "-c:a", "copy",
    "-sc_threshold", "0",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "10",
    "-hls_flags", "delete_segments+temp_file",
    "-var_stream_map", "v:0,a:0,name:src v:1,a:1,name:720",
    "-master_pl_name", "index.m3u8",
    "-hls_segment_filename", "/m/live/x/1700000000000-%v-%d.ts",
    "/m/live/x/v%v.m3u8",
  ],
  "nvenc: μόνο το codec block αλλάζει"
);

{
  const a = args({ ladder: [720, 480], srcHeight: 1080, encoder: "qsv" });
  assert.equal(val(a, "-c:v:1"), "h264_qsv");
  assert.equal(val(a, "-c:v:2"), "h264_qsv", "ο encoder ισχύει σε όλα τα σκαλοπάτια");
  assert.equal(val(a, "-c:v:0"), "copy", "η κορυφή μένει copy ακόμα και με GPU");
  // Το scale μένει στη CPU: και ο nvenc και ο qsv δέχονται software frames και
  // ανεβάζουν μόνοι τους. Το scale_cuda/hwupload θα ήθελε άλλο filter graph ανά
  // encoder για να γλιτώσει το φθηνό κομμάτι — ακριβό είναι το encode.
  assert.ok(!a.some((x) => String(x).includes("hwupload")), "κανένα hwupload στο filter graph");
  assert.ok(val(a, "-filter_complex").includes("scale=-2:'min(720,ih)'"), "ίδιο scale με τον x264");
}

// Ο πίνακας εξάγεται για τον probe του app.js: εκεί χρειάζεται το όνομα του
// codec ώστε να δοκιμαστεί ένα καρέ πριν σηκωθεί οποιαδήποτε εκπομπή.
assert.equal(ENCODERS.nvenc.codec, "h264_nvenc");
assert.equal(ENCODERS.x264.codec, "libx264");

// --- R2: ο ffmpeg γράφει στο ff/ με τα τελικά ονόματα -----------------------
{
  const a = args({ r2 });
  assert.equal(val(a, "-hls_segment_filename"), "/m/live/x/ff/1700000000000-%d.ts");
  assert.equal(val(a, "-hls_base_url"), "https://cdn/live/x/");
  assert.equal(a.at(-1), "/m/live/x/ff/index.m3u8", "χωρίς ladder, τελικό όνομα μέσα στο ff/");
}
{
  const a = args({ ladder: [720], srcHeight: 1080, r2 });
  assert.equal(val(a, "-hls_segment_filename"), "/m/live/x/ff/1700000000000-%v-%d.ts");
  assert.equal(val(a, "-master_pl_name"), "index.m3u8", "το master είναι σχετικό, δίπλα στα variants");
  assert.equal(a.at(-1), "/m/live/x/ff/v%v.m3u8");
  assert.equal(val(a, "-hls_base_url"), "https://cdn/live/x/");
}
assert.ok(!args({ ladder: [720], srcHeight: 1080 }).some((x) => String(x).includes("/ff/")),
  "χωρίς R2 κανένα ff/: όλα επίπεδα στον φάκελο του stream");

// --- αναμονή για το ύψος της πηγής ------------------------------------------
// Το videoHeight γεμίζει όταν φτάσει το @setDataFrame (broadcast_server.js:200),
// ενώ το postPublish εκπέμπεται με την εντολή publish (:159) — δηλαδή *πριν*.
// Χωρίς αναμονή το φίλτρο «ποτέ upscale» δεν κόβει ποτέ τίποτα, γιατί το ύψος
// είναι πάντα 0: πηγή 480p με ladder [480] έβγαζε δεύτερο, ταυτόσημο rendition.
assert.equal(waitForHeight({ ladder: [480], srcHeight: 0, waited: 0 }), true);
assert.equal(waitForHeight({ ladder: [480], srcHeight: 1080, waited: 0 }), false, "ήρθε το ύψος, φύγαμε");

// Χωρίς ladder δεν περιμένουμε ούτε ένα tick: η συντριπτική πλειοψηφία των
// εκπομπών δεν έχει κανέναν λόγο να ξεκινήσει αργότερα.
assert.equal(waitForHeight({ ladder: [], srcHeight: 0, waited: 0 }), false);
assert.equal(waitForHeight({ srcHeight: 0, waited: 0 }), false);

// Publisher που δεν στέλνει ποτέ metadata δεν κρατάει όμηρο το HLS — μετά τη
// λήξη ξεκινάμε με ό,τι ξέρουμε (και το min(h,ih) του scale κρατάει την εγγύηση).
assert.equal(waitForHeight({ ladder: [480], srcHeight: 0, waited: 2000 }), false, "λήξη αναμονής");
assert.equal(waitForHeight({ ladder: [480], srcHeight: 0, waited: 1900 }), true, "λίγο πριν τη λήξη");

assert.equal(BITRATES[240].v, "400k", "ο πίνακας των bitrates εξάγεται");
console.log("ladder.js OK");

