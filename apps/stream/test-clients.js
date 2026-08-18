// Έλεγχος του loader των πελατών: node test-clients.js
import assert from "node:assert";
import fs from "fs";
import os from "os";

// Το CLIENTS διαβάζεται στο import του config.js, οπότε το env πρέπει να μπει
// πριν — γι' αυτό δυναμικό import.
const file = `${fs.mkdtempSync(`${os.tmpdir()}/clients-test-`)}/clients.json`;
process.env.CLIENTS_FILE = file;
const { loadClients, clientOf, ladderOf, publishAllowed, clearClientsCache, CLIENTS } =
  await import("./config.js");

assert.equal(CLIENTS, file, "το path είναι override-able για τα tests");

// Χωρίς αρχείο: κανένας πελάτης, καμία εξαίρεση — και τίποτα δεν επιβάλλεται.
assert.deepEqual(loadClients(), {}, "αρχείο που λείπει = χωρίς πελάτες");
assert.equal(publishAllowed("/live/stream", undefined), true, "χωρίς πελάτες όλα περνάνε");

const write = (obj) => fs.writeFileSync(file, JSON.stringify(obj));

write({ a: { limit: 3, paths: { "/live/k1": "K1", "/live/k2": "K2" } } });
clearClientsCache();
assert.equal(clientOf("/live/k2").limit, 3, "το path βρίσκει τον πελάτη του");
assert.equal(clientOf("/live/άγνωστο"), undefined, "path εκτός clients.json");

// 5s cache: δεύτερη ανάγνωση μέσα στο παράθυρο δεν αγγίζει τον δίσκο. Το
// playlist ζητιέται κάθε 2s ανά θεατή — χωρίς cache, 200 θεατές = 100 reads/s.
write({ b: { paths: { "/live/νέο": "X" } } });
assert.equal(clientOf("/live/νέο"), undefined, "μέσα στα 5s το νέο περιεχόμενο δεν φαίνεται");
assert.ok(clientOf("/live/k1"), "μέσα στα 5s ισχύει το παλιό περιεχόμενο");
clearClientsCache();
assert.ok(clientOf("/live/νέο"), "μετά το clearClientsCache φαίνεται το νέο περιεχόμενο");

// Χαλασμένο JSON δεν ρίχνει τον server: μισογραμμένο αρχείο μετράει σαν «χωρίς
// πελάτες» και το επόμενο sync το ξαναγράφει σωστά.
fs.writeFileSync(file, "{ αυτό δεν είναι json");
clearClientsCache();
assert.deepEqual(loadClients(), {}, "χαλασμένο JSON = χωρίς πελάτες, χωρίς exception");

// publishAllowed: ο ένας και μοναδικός έλεγχος, όπως τον βλέπουν app.js και stats.js
write({ a: { paths: { "/live/k1": "K1" } } });
clearClientsCache();
assert.equal(publishAllowed("/live/k1", "K1"), true, "σωστό κλειδί");
assert.equal(publishAllowed("/live/k1", "λάθος"), false, "λάθος κλειδί");
assert.equal(publishAllowed("/live/k1", undefined), false, "χωρίς κλειδί δεν εκπέμπει");
assert.equal(publishAllowed("/live/άγνωστο", "K1"), false, "άγνωστο path = μπλόκο");
assert.equal(publishAllowed("/live/άγνωστο", undefined), false, "άγνωστο path χωρίς κλειδί = μπλόκο");

// Το ladder είναι προαιρετικό πεδίο της εγγραφής, το γράφει το sync του panel.
// Ο stream server το διαβάζει ανεκτικά: ό,τι δεν είναι λίστα αριθμών σημαίνει
// «σημερινή συμπεριφορά», γιατί ένα τυπογραφικό στον κατάλογο των πλάνων δεν
// επιτρέπεται να ρίξει εκπομπή.
write({
  a: { paths: { "/live/abr": "K", "/live/plain": "K" }, ladder: [720, 480] },
  b: { paths: { "/live/palio": "K" } },
  c: { paths: { "/live/skoupidia": "K" }, ladder: "720,480" },
  d: { paths: { "/live/keno": "K" }, ladder: [] },
});
clearClientsCache();
assert.deepEqual(ladderOf("/live/abr"), [720, 480], "το ladder της εγγραφής");
assert.deepEqual(ladderOf("/live/palio"), [], "παλιό σχήμα χωρίς πεδίο = κενό ladder");
assert.deepEqual(ladderOf("/live/skoupidia"), [], "ό,τι δεν είναι λίστα = κενό ladder");
assert.deepEqual(ladderOf("/live/keno"), [], "κενή λίστα = κενό ladder");
assert.deepEqual(ladderOf("/live/άγνωστο"), [], "path χωρίς πελάτη = κενό ladder");
assert.deepEqual(ladderOf("/live/abr"), ladderOf("/live/plain"), "το ladder είναι της εγγραφής, ίδιο σε όλα της τα paths");

// Ο διακόπτης είναι η ύπαρξη του αρχείου, όχι το πόσοι πελάτες υπάρχουν μέσα:
// έγκυρο `{}` (server χωρίς πελάτες, ή με όλους απενεργοποιημένους) κλείνει —
// αλλιώς το πρώτο κιόλας sync θα τον άφηνε ορθάνοιχτο.
write({});
clearClientsCache();
assert.equal(publishAllowed("/live/stream", "οτιδήποτε"), false, "άδειο clients.json = κανείς δεν εκπέμπει");

// Ενώ το αρχείο που λείπει ξαναγυρίζει στη σημερινή συμπεριφορά.
fs.rmSync(file);
clearClientsCache();
assert.equal(publishAllowed("/live/stream", undefined), true, "αρχείο που λείπει = καμία επιβολή");

fs.rmSync(file.slice(0, file.lastIndexOf("/")), { recursive: true, force: true });
console.log("clients loader OK");
