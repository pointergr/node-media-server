// Το χτίσιμο των args του ffmpeg, καθαρή συνάρτηση και σε δικό της αρχείο: το
// app.js έχει top-level side effects (διαβάζει config, σηκώνει server), οπότε
// ένα test δεν μπορεί να το κάνει import χωρίς να ανοίξει θύρες.

// Σταθερός πίνακας ανά ύψος, όχι ρυθμιζόμενος ανά πλάνο: το πλάνο πουλάει
// «σκαλοπάτια», όχι kbps. Custom bitrates μπαίνουν όταν τα ζητήσει κάποιος
// ονομαστικά — μέχρι τότε είναι πέντε γραμμές που δεν διαβάζει κανείς.
export const BITRATES = {
  1080: { v: "5000k", max: "5500k", buf: "10000k" },
  720: { v: "2800k", max: "3000k", buf: "6000k" },
  480: { v: "1200k", max: "1400k", buf: "2800k" },
  360: { v: "700k", max: "800k", buf: "1600k" },
  240: { v: "400k", max: "450k", buf: "900k" },
};

// Ο encoder είναι ρύθμιση του **server**, το ladder του πλάνου: το πλάνο λέει τι
// πούλησες, ο server με τι το βγάζει. Απούσα ή άγνωστη τιμή πέφτει στον x264 —
// ένας server χωρίς GPU δεν έχει καν το πεδίο στο config.json, και ένα
// τυπογραφικό δεν επιτρέπεται να ρίξει εκπομπές (τον έλεγχο ότι ο codec όντως
// δουλεύει σε αυτό το μηχάνημα τον κάνει ο probe του app.js, στο boot).
// Το scale μένει στη CPU και για τους δύο: ο h264_nvenc και ο h264_qsv δέχονται
// software frames και ανεβάζουν μόνοι τους στην GPU. Το scale_cuda/hwupload θα
// ήθελε διαφορετικό filter graph ανά encoder για να γλιτώσει το φθηνό κομμάτι —
// ακριβό είναι το encode. Ο VA-API λείπει σκόπιμα: *απαιτεί* hwupload, δηλαδή
// ειδική περίπτωση στο graph· μπαίνει όταν υπάρξει μηχάνημα χωρίς QSV δρόμο.
export const ENCODERS = {
  x264: { codec: "libx264", args: ["-preset", "veryfast"] },
  nvenc: { codec: "h264_nvenc", args: ["-preset", "p4", "-rc", "cbr"] },
  qsv: { codec: "h264_qsv", args: ["-preset", "veryfast"] },
};

// Το πλαφόν είναι ρύθμιση του server, όχι του πλάνου: το πλάνο είναι εμπορική
// υπόσχεση, αυτό εδώ είναι το τι σηκώνει το μηχάνημα πριν λιώσει. Μετράει μόνο
// τα encoded σκαλοπάτια — η κορυφή είναι copy και δεν κοστίζει CPU.
const MAX_RENDITIONS = 3;

// Η διάρκεια του segment. Είναι και ο ρυθμός της εκπομπής και η προθεσμία του
// R2 sync: ό,τι δεν ανέβηκε μέσα σε ένα segment είναι ήδη αργά και φεύγει από το
// origin (δες r2.js). Γι' αυτό εξάγεται αντί να είναι κυριολεκτικό στα args.
export const SEGMENT_SEC = 2;

// Τα segments του HLS: 2s παράθυρο, 6 στη λίστα. Κοινά σε όλες τις περιπτώσεις,
// γι' αυτό γράφονται μία φορά.
const HLS = [
  "-f", "hls",
  "-hls_time", String(SEGMENT_SEC),
  // 6 segments = 12s παράθυρο. Δεν αλλάζει το latency (ο player μπαίνει τρία
  // segments πριν το live edge ούτως ή άλλως) — αλλάζει το περιθώριο: το .ts
  // μένει στον δίσκο 12s αντί για 6s, οπότε ένα PUT που απέτυχε προλαβαίνει
  // να ξαναδοκιμαστεί, κι ένας θεατής που έχασε ένα αίτημα προλαβαίνει να
  // ξαναζητήσει αντί να πέσει έξω από το παράθυρο.
  "-hls_list_size", "6",
  // temp_file: ο ffmpeg γράφει .tmp και κάνει rename, οπότε ποτέ κανείς —
  // ούτε ο player, ούτε το R2 sync — δεν διαβάζει μισογραμμένο αρχείο
  "-hls_flags", "delete_segments+temp_file",
];

// Το OBS βάζει SPS/PPS in-band μόνο στο *πρώτο* keyframe — στα υπόλοιπα τα έχει
// μόνο το avcC. Το h264_mp4toannexb, που βάζει το ίδιο το mpegts muxer, τα βλέπει
// εκεί, σηκώνει τα idr_sps_seen/idr_pps_seen και δεν τα ξαναβάζει ποτέ: μόνο το
// segment 0 βγαίνει με παραμέτρους. Όποιος μπαίνει στο live edge δεν παίρνει ούτε
// ανάλυση ούτε profile και βλέπει μαύρο — ενώ όποιος ήταν συνδεδεμένος από την
// αρχή παίζει κανονικά και δεν το καταλαβαίνει. Το ρητό mp4toannexb γυρίζει το
// extradata σε annex-b, και το dump_extra (freq=keyframe by default) το ξαναγράφει
// πριν από κάθε keyframe. Σκέτο dump_extra δεν κάνει: χώνει AVCC bytes σε annex-b
// stream και σκάει.
const BSF = "h264_mp4toannexb,dump_extra";

// Τα σκαλοπάτια που θα κωδικοποιηθούν στ' αλήθεια, δηλαδή το ladder του πακέτου
// αφού κοπούν όσα δεν έχουν νόημα. Ξεχωριστά εξαγόμενο γιατί το ίδιο νούμερο το
// θέλει και το snapshot του stats.js: ένα «720+480» σε πηγή 480p είναι στην
// πράξη καθόλου ABR, και ο admin πρέπει να βλέπει αυτό που τρέχει.
// Ποτέ upscale: σκαλοπάτι ≥ της πηγής είναι διπλάσιο κόστος για χειρότερη
// εικόνα. Άγνωστο ύψος (το videoHeight μπορεί να μην έχει φτάσει ακόμα στο
// postPublish) δεν φιλτράρει τίποτα — την εγγύηση την κρατάει τότε το min(h,ih)
// του scale.
export const renditions = ({ ladder, srcHeight, maxRenditions = MAX_RENDITIONS }) =>
  (Array.isArray(ladder) ? ladder : [])
    .filter((h) => BITRATES[h] && (!srcHeight || h < srcHeight))
    .slice(0, maxRenditions);

export function ffmpegArgs({ dir, streamPath, prefix, rtmpPort, ladder, srcHeight, r2, encoder, maxRenditions = MAX_RENDITIONS }) {
  // Με R2 ο ffmpeg γράφει σε υποφάκελο με τα *τελικά* ονόματα και το r2.js
  // δημοσιεύει τα ίδια ονόματα ένα επίπεδο πάνω, αφού ανέβουν τα segments.
  // Χωρίς R2 τα σερβίρει ο static server κατευθείαν από τον φάκελο του stream.
  const out = r2 ? `${dir}/ff` : dir;
  const steps = renditions({ ladder, srcHeight, maxRenditions });
  const enc = ENCODERS[encoder] ?? ENCODERS.x264;

  const src = ["-i", `rtmp://127.0.0.1:${rtmpPort}${streamPath}`];
  const baseUrl = r2 ? ["-hls_base_url", `${r2.publicUrl}${streamPath}/`] : [];

  // Ο δρόμος αναδίπλωσης, και η συντριπτική πλειοψηφία των εκπομπών: σκέτο
  // remux, ένα playlist, κανένα master.
  if (!steps.length) {
    return [
      ...src,
      "-bsf:v", BSF,
      "-c", "copy",
      ...HLS,
      "-hls_segment_filename", `${out}/${prefix}-%d.ts`,
      ...baseUrl,
      `${out}/index.m3u8`,
    ];
  }

  // Ένα split ανά σκαλοπάτι· η πηγή δεν περνάει από φίλτρο, πάει copy.
  const filter = [
    `[0:v]split=${steps.length}${steps.map((_, i) => `[s${i}]`).join("")}`,
    ...steps.map((h, i) => `[s${i}]scale=-2:'min(${h},ih)'[v${h}]`),
  ].join(";");

  return [
    ...src,
    "-filter_complex", filter,
    // Το bsf ανήκει μόνο στο copy stream: στα encoded ο encoder βγάζει ήδη annex-b
    // με δικό του extradata και το φίλτρο εκεί είναι στην καλύτερη περίπτωση περιττό.
    "-map", "0:v", "-c:v:0", "copy", "-bsf:v:0", BSF,
    ...steps.flatMap((h, i) => {
      const b = BITRATES[h];
      const n = i + 1;
      return [
        "-map", `[v${h}]`, `-c:v:${n}`, enc.codec, ...enc.args,
        `-b:v:${n}`, b.v, `-maxrate:v:${n}`, b.max, `-bufsize:v:${n}`, b.buf,
      ];
    }),
    // Το AAC της πηγής περνάει αυτούσιο σε κάθε σκαλοπάτι: μηδενικό κόστος,
    // καμία απώλεια. Ένα -map 0:a ανά variant, γιατί το var_stream_map ζητάει
    // ξεχωριστό audio stream για καθένα.
    ...Array(steps.length + 1).fill(["-map", "0:a"]).flat(),
    "-c:a", "copy",
    // Κλειδωμένα keyframes ανά 2s, ώστε τα segments των encoded variants να
    // κόβονται στα ίδια σημεία. Η κορυφή (copy) ακολουθεί τα keyframes του OBS
    // — γι' αυτό ο πελάτης πρέπει να έχει keyframe interval 2s.
    // Σε χρόνο και όχι σε καρέ (`-g`): το fps της πηγής το ορίζει ο πελάτης και
    // δεν το ξέρουμε εδώ. Ένα `-g 50` δίπλα σε αυτό θα έβαζε δεύτερο IDR στο
    // 1,67s κάθε πηγής των 30fps — διπλά keyframes για το τίποτα.
    "-sc_threshold", "0",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    ...HLS,
    // Το %v γίνεται το name του var_stream_map, όχι ο αριθμός: έτσι τα ονόματα
    // (v720.m3u8, <prefix>-720-3.ts) λένε από μόνα τους σε ποιο σκαλοπάτι
    // ανήκουν — πάνω σε αυτό στηρίζεται το addR2Out του stats.js.
    "-var_stream_map",
    ["v:0,a:0,name:src", ...steps.map((h, i) => `v:${i + 1},a:${i + 1},name:${h}`)].join(" "),
    // Επίπεδα αρχεία, όχι υποφάκελοι ανά variant: το stats.js βγάζει το stream
    // από το dirname του request, οπότε ένα v0/ θα έδινε stream «/live/x/v0» και
    // θα έσπαγε μονομιάς clientOf, overLimit, samples και panel.
    "-master_pl_name", "index.m3u8",
    "-hls_segment_filename", `${out}/${prefix}-%v-%d.ts`,
    ...baseUrl,
    `${out}/v%v.m3u8`,
  ];
}

// Πόσο περιμένουμε τα metadata της πηγής πριν σηκώσουμε ffmpeg με ladder. Το
// πρώτο segment θέλει ούτως ή άλλως 2s, οπότε η καθυστέρηση δεν φαίνεται.
const HEIGHT_WAIT_MS = 2000;

// Το `videoHeight` της συνεδρίας γεμίζει όταν φτάσει το `@setDataFrame`
// (broadcast_server.js:200), ενώ το `postPublish` εκπέμπεται με την εντολή
// publish (:159) — δηλαδή *πριν*. Χωρίς αναμονή το φίλτρο «ποτέ upscale» δεν
// κόβει ποτέ τίποτα (srcHeight πάντα 0) και μια πηγή 480p με ladder [480]
// πλήρωνε κωδικοποίηση για ένα δεύτερο, ταυτόσημο rendition.
// Περιμένουμε **μόνο** όταν υπάρχει ladder: η συντριπτική πλειοψηφία των
// εκπομπών δεν έχει κανέναν λόγο να ξεκινήσει έστω και ένα tick αργότερα. Και
// περιμένουμε με λήξη: publisher που δεν στέλνει ποτέ metadata δεν κρατάει
// όμηρο το HLS — μετά τη λήξη ξεκινάμε με ό,τι ξέρουμε, και την εγγύηση την
// κρατάει το min(h,ih) του scale.
export const waitForHeight = ({ ladder, srcHeight, waited, maxWaitMs = HEIGHT_WAIT_MS }) =>
  Boolean(ladder?.length) && !srcHeight && waited < maxWaitMs;
