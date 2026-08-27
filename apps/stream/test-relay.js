// Έλεγχος της αναδιανομής σε εξωτερικούς προορισμούς: node test-relay.js
import assert from "node:assert";
import { relayArgs, backoffMs, usableTarget, startRelays } from "./relay.js";

// Ο πίνακας ολόκληρος, όχι δειγματοληπτικά: τα args είναι το συμβόλαιο με τον
// ffmpeg και μια σιωπηλή αλλαγή τους φαίνεται μόνο ως «το YouTube δεν παίρνει
// σήμα», ώρες αργότερα.
assert.deepEqual(
  relayArgs({ streamPath: "/live/k1", rtmpPort: 1935, url: "rtmp://a.rtmp.youtube.com/live2/KEY" }),
  [
    "-loglevel", "error",
    "-i", "rtmp://127.0.0.1:1935/live/k1",
    "-c", "copy",
    "-f", "flv",
    "rtmp://a.rtmp.youtube.com/live2/KEY",
  ],
  "σκέτο remux προς flv, χωρίς bitstream filter"
);

// Το bsf του HLS (annex-b για το mpegts) θα έσπαγε τον flv muxer, που θέλει AVCC.
assert.ok(
  !relayArgs({ streamPath: "/live/k1", rtmpPort: 1935, url: "rtmp://x/y" }).includes("-bsf:v"),
  "κανένα bitstream filter στο flv"
);

// Η θύρα του input ακολουθεί το config, όχι σταθερά το 1935.
assert.ok(
  relayArgs({ streamPath: "/live/k1", rtmpPort: 1936, url: "rtmp://x/y" }).includes("rtmp://127.0.0.1:1936/live/k1"),
  "το input διαβάζει από τη ρυθμισμένη θύρα"
);

// Κλιμακούμενη αναμονή, χωρίς οριστική παραίτηση: ο πελάτης μπορεί να ανοίξει το
// YouTube πολλή ώρα αφότου άρχισε να εκπέμπει σε εμάς, και ένα relay που τα
// παράτησε δεν ξανασηκώνεται ποτέ χωρίς restart του server.
assert.equal(backoffMs(0), 2000, "πρώτη αποτυχία: γρήγορη επανασύνδεση");
assert.ok(backoffMs(1) > backoffMs(0), "η αναμονή ανεβαίνει");
assert.equal(backoffMs(4), 60_000, "πλατό στο λεπτό");
assert.equal(backoffMs(999), 60_000, "και δεν ανεβαίνει άλλο — ποτέ παραίτηση");

// Ο μόνος έλεγχος που μπορεί να κάνει μόνο ο stream server: ο εαυτός του. Ένα
// relay πίσω στη δική μας θύρα τροφοδοτεί τον εαυτό του σε βρόχο.
assert.equal(usableTarget("rtmp://a.rtmp.youtube.com/live2/K", 1935), true, "κανονικός προορισμός");
assert.equal(usableTarget("rtmps://live-api-s.facebook.com:443/rtmp/K", 1935), true, "rtmps");
assert.equal(usableTarget("http://example.com/x", 1935), false, "μόνο rtmp/rtmps");
assert.equal(usableTarget("srt://example.com:9000", 1935), false, "το srt δεν το μιλάει το relay");
assert.equal(usableTarget("δεν είναι url", 1935), false, "σκουπίδια");
assert.equal(usableTarget("rtmp://127.0.0.1:1935/live/x", 1935), false, "βρόχος στον εαυτό μας");
assert.equal(usableTarget("rtmp://localhost/live/x", 1935), false, "ο ίδιος βρόχος με όνομα");
assert.equal(usableTarget("rtmp://127.0.0.1/live/x", 1935), false, "χωρίς θύρα εννοείται η 1935");
assert.equal(usableTarget("rtmp://127.0.0.1:1936/live/x", 1935), true, "άλλη θύρα στο ίδιο μηχάνημα επιτρέπεται");

// Χωρίς προορισμούς δεν υπάρχει τίποτα να σταματήσει — το app.js το χειρίζεται
// με `?.`, όπως το stop του r2.js.
const opts = { streamPath: "/live/k1", ffmpeg: "/nonexistent/ffmpeg", rtmpPort: 1935 };
assert.equal(startRelays([], opts), null, "κενή λίστα = κανένα relay");
assert.equal(startRelays(undefined, opts), null, "απούσα λίστα = κανένα relay");

// Άκυρος προορισμός δεν ρίχνει την εκπομπή: πέφτει έξω με ένα log και οι
// υπόλοιποι συνεχίζουν.
const quiet = console.error;
console.error = () => {};
try {
  assert.equal(
    startRelays([{ name: "βρόχος", url: "rtmp://127.0.0.1:1935/live/k1" }], opts),
    null,
    "μόνο άκυροι προορισμοί = κανένα relay"
  );

  const mixed = startRelays(
    [
      { name: "βρόχος", url: "rtmp://127.0.0.1:1935/live/k1" },
      { name: "YouTube", url: "rtmp://a.rtmp.youtube.com/live2/K" },
    ],
    opts
  );
  const state = mixed.state();
  assert.equal(state.length, 1, "ο άκυρος προορισμός δεν μπαίνει καν στη λίστα");
  assert.equal(state[0].name, "YouTube", "και ο έγκυρος ξεκινάει κανονικά");
  // Το ότι φτάνουμε ζωντανοί στο τέλος ΕΙΝΑΙ το assertion: ένα kill() πάνω σε
  // ffmpeg που δεν ξεκίνησε ποτέ (λάθος config.hls.ffmpeg) έχει pid undefined,
  // που το kill(2) διαβάζει ως 0 — δηλαδή «όλο το process group». Χωρίς τον
  // έλεγχο του killFfmpeg, αυτή η γραμμή σκοτώνει τον ίδιο τον server στο πρώτο
  // donePublish, σιωπηλά και χωρίς ούτε μία γραμμή στο log.
  mixed.stop();
} finally {
  console.error = quiet;
}

console.log("relay OK");
