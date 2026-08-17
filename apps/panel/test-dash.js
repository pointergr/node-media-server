// Μόνο τα καθαρά κομμάτια του dash.ts — αυτά που μεταφέρθηκαν αυτούσια από το
// παλιό dashboard και είναι εύκολο να σπάσουν σιωπηλά σε ένα refactor. Το
// lineChart θέλει DOM και δεν δοκιμάζεται εδώ. Node 24: import .ts κατευθείαν.
import assert from "node:assert";
import { bps, bytes, dur, curve, niceMax, RANGES } from "./app/utils/dash.ts";

assert.equal(bps(2_500_000), "2.5 Mbps");
assert.equal(bps(999), "999 bps");
assert.equal(bps(150_000_000), "150 Mbps");
assert.equal(bytes(1_500_000), "1.5 MB");
assert.equal(dur(90061), "1μ 1ω");
assert.equal(dur(3661), "1ω 1λ");
assert.equal(dur(61), "1λ 1δ");

// Η καμπύλη δεν βγαίνει ποτέ έξω από το εύρος των σημείων (γι' αυτό δεν είναι
// Catmull-Rom): κάθε control point είναι δείγμα και κάθε άκρο μέσο δύο δειγμάτων.
const d = curve([[0, 10], [10, 0], [20, 10]]);
assert.match(d, /^M0\.0,10\.0 Q10\.0,0\.0 15\.0,5\.0 L20\.0,10\.0$/);
assert.equal(curve([[0, 1], [2, 3]]), "M0.0,1.0 L2.0,3.0");

// Τα κλειδιά είναι το συμβόλαιο με το apps/stream/stats.js#RANGES — ό,τι δεν
// αναγνωρίζει ο stream server πέφτει σιωπηλά πίσω στο 24ωρο.
assert.deepEqual(Object.keys(RANGES), ["1h", "24h", "7d", "30d"]);
assert.equal(RANGES["7d"], "7 ημέρες");

assert.equal(niceMax(2_400_000), 2_500_000);
assert.equal(niceMax(7.3), 7.5); // στρογγυλοποιεί στο μισό της δύναμης του 10, όχι στην επόμενη

console.log("ok");
