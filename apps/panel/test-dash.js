// Μόνο τα καθαρά κομμάτια του dash.ts — αυτά που μεταφέρθηκαν αυτούσια από το
// παλιό dashboard και είναι εύκολο να σπάσουν σιωπηλά σε ένα refactor. Το
// lineChart θέλει DOM και δεν δοκιμάζεται εδώ. Node 24: import .ts κατευθείαν.
import assert from "node:assert";
import { bps, bytes, dur, curve, niceMax, qualityLevels, RANGES, xWindow } from "./app/utils/dash.ts";

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

// Ο άξονας δείχνει το επιλεγμένο διάστημα, όχι το εύρος των δειγμάτων: μία ώρα
// εκπομπής μέσα σε παράθυρο 30 ημερών πρέπει να φαίνεται σαν μία ώρα.
assert.deepEqual(xWindow(100, 200), { min: 100, max: 200 });
// Χωρίς from (server κάτω, ή πριν την πρώτη απάντηση) κανένα όριο — αλλιώς ο
// άξονας ξεκινάει από το 1970 και το γράφημα βγαίνει άδειο.
assert.deepEqual(xWindow(0, 200), {});

assert.equal(niceMax(2_400_000), 2_500_000);
assert.equal(niceMax(7.3), 7.5); // στρογγυλοποιεί στο μισό της δύναμης του 10, όχι στην επόμενη

console.log("ok");

// --- επιλογές ποιότητας του player -----------------------------------------
// Τα levels έρχονται από το hls.js με τη σειρά που τα βρήκε στο master (ή
// ταξινομημένα κατά bitrate — δεν είναι συμβόλαιο), ενώ ο επιλογέας πρέπει πάντα
// να τα δείχνει από την υψηλότερη προς τη χαμηλότερη. Το i είναι ο δείκτης του
// hls.js και ταξιδεύει αυτούσιος στο currentLevel — αν χαθεί στην ταξινόμηση, ο
// χρήστης διαλέγει 1080 και παίρνει 480.
assert.deepEqual(
  qualityLevels([{ height: 480 }, { height: 720 }, { height: 1080 }]),
  [{ i: 2, label: "1080p" }, { i: 1, label: "720p" }, { i: 0, label: "480p" }]
);
// Ένα μόνο level = stream χωρίς ladder: επιλογέας με μία γραμμή είναι σκουπίδι.
assert.deepEqual(qualityLevels([{ height: 1080 }]), []);
assert.deepEqual(qualityLevels([]), []);
// Η αρχική ποιότητα ξεχωρίζει: είναι η ίδια η εκπομπή σε copy, όχι rendition
// που φτιάξαμε εμείς. Χωρίς την ένδειξη ο admin βλέπει «720p» δίπλα σε «480p»
// και νομίζει ότι το πακέτο παράγει και τα δύο. Το vsrc.m3u8 είναι δικό μας
// συμβόλαιο (ladder.js: name:src στο var_stream_map).
assert.deepEqual(
  qualityLevels([{ height: 480, url: ["https://h/live/x/v480.m3u8"] }, { height: 720, url: ["https://h/live/x/vsrc.m3u8"] }]),
  [{ i: 1, label: "720p (αρχική)" }, { i: 0, label: "480p" }]
);
// Playlist που δεν βγήκε από εμάς (άλλος encoder, δοκιμή): καμία ένδειξη, καμία υπόθεση.
assert.deepEqual(
  qualityLevels([{ height: 480, url: ["/a/480.m3u8"] }, { height: 720, url: ["/a/720.m3u8"] }]),
  [{ i: 1, label: "720p" }, { i: 0, label: "480p" }]
);

// Master χωρίς RESOLUTION στο EXT-X-STREAM-INF: πέφτουμε στο bitrate.
assert.deepEqual(
  qualityLevels([{ bitrate: 800_000 }, { bitrate: 2_500_000 }]),
  [{ i: 1, label: "2500k" }, { i: 0, label: "800k" }]
);
