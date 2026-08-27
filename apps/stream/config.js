import fs from "fs";

export function loadConfig() {
  return new Promise((resolve, reject) => {
    fs.readFile("./config.json", "utf8", (err, data) => {
      if (err) {
        console.error("Error reading config.json file:", err);
        reject(err);
        return;
      }

      try {
        // Convert the file content to an object
        const config = JSON.parse(data);

        resolve(config);
      } catch (parseErr) {
        console.error("Error parsing JSON string:", parseErr);
        reject(parseErr);
      }
    });
  });
}

export async function saveConfig(config) {
  return new Promise((resolve, reject) => {
    fs.writeFile(
      "./config.json",
      JSON.stringify(config, null, 2),
      "utf8",
      (err) => {
        if (err) {
          console.error(err);
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
}

// Δίπλα στο stats.db, ώστε σε Docker να ζει στο data volume και να επιβιώνει
// το recreate του container.
const PASSWORDS = "./data/passwords.json";

// Μεταφορά από την παλιά θέση. Χωρίς αυτό, ένα generate-passwords σε υπάρχοντα
// server δεν θα έβρισκε τίποτα και θα έφτιαχνε καινούργιους κωδικούς —
// αλλάζοντας σιωπηλά το stream key του OBS.
function migratePasswords() {
  if (fs.existsSync("./passwords.json") && !fs.existsSync(PASSWORDS)) {
    fs.mkdirSync("./data", { recursive: true });
    fs.renameSync("./passwords.json", PASSWORDS);
  }
}

// Η μόνη τοπική πηγή αλήθειας για τους πελάτες: το γράφει το sync με το panel
// (panel.js), το διαβάζουν όλοι. Στο data volume, δίπλα στο passwords.json, ώστε
// να επιβιώνει το recreate του container. Το env override υπάρχει για τον ίδιο
// λόγο με το ADMIN_DB: να μη γράφουν τα tests στο πραγματικό data volume.
export const CLIENTS = process.env.CLIENTS_FILE ?? "./data/clients.json";

// Το playlist ζητιέται κάθε 2s ανά θεατή· 200 θεατές = 100 reads/s στον δίσκο.
// 5s cache: ο admin βλέπει την αλλαγή του πρακτικά αμέσως, ο δίσκος δεν το καταλαβαίνει.
let cache = { ts: 0, data: {}, ok: false };

// Σύγχρονο διάβασμα επίτηδες: καλείται μέσα στο trackHls και σε event handlers
// που δεν είναι async.
export function loadClients() {
  if (Date.now() - cache.ts < 5000) return cache.data;
  try {
    cache = { ts: Date.now(), data: JSON.parse(fs.readFileSync(CLIENTS, "utf8")), ok: true };
  } catch {
    cache = { ts: Date.now(), data: {}, ok: false }; // λείπει/χαλασμένο = χωρίς πελάτες
  }
  return cache.data;
}

// Μόνο για τα tests: αλλιώς θα έπρεπε να περιμένουν 5s σε κάθε αλλαγή αρχείου.
export const clearClientsCache = () => (cache = { ts: 0, data: {}, ok: false });

export const clientOf = (path) =>
  Object.values(loadClients()).find((c) => c.paths?.[path] !== undefined);

// Το ladder (ύψη προς κωδικοποίηση) είναι ιδιότητα της εγγραφής — δηλαδή της
// συνδρομής, όπως και το limit — και το γράφει το sync του panel. Το διαβάζουμε
// ανεκτικά: απόν, κενό ή χαλασμένο σημαίνει «σημερινή συμπεριφορά» (σκέτο copy),
// γιατί ένα τυπογραφικό στον κατάλογο των πλάνων δεν επιτρέπεται να ρίξει
// εκπομπή. Ό,τι δεν είναι έγκυρο ύψος το πετάει έτσι κι αλλιώς το ffmpegArgs.
export const ladderOf = (path) => {
  const l = clientOf(path)?.ladder;
  return Array.isArray(l) ? l.map(Number).filter(Number.isFinite) : [];
};

// Οι προορισμοί αναδιανομής (YouTube κ.λπ.) του κάθε path. Ζουν σε δικό τους
// πεδίο της εγγραφής και **όχι** μέσα στο `paths`: εκείνο είναι path→κλειδί και
// το διαβάζει η publishAllowed χαρακτήρα-χαρακτήρα — δεν αλλάζει σχήμα ο έλεγχος
// εκπομπής για ένα προαιρετικό χαρακτηριστικό. Ίδιο μοτίβο με το `ladder`, με
// μία διαφορά: το ladder είναι της εγγραφής (το πουλάει το πλάνο), οι προορισμοί
// είναι του κάθε stream ξεχωριστά — άλλο κανάλι YouTube ανά κάμερα.
// Ίδια ανοχή με το ladderOf: ό,τι δεν είναι {name,url} πέφτει έξω σιωπηλά, γιατί
// ένα τυπογραφικό στο panel δεν επιτρέπεται να ρίξει εκπομπή.
export const relaysOf = (path) => {
  const r = clientOf(path)?.relays?.[path];
  return Array.isArray(r)
    ? r.filter((t) => t && typeof t.name === "string" && typeof t.url === "string")
    : [];
};

// Ο έλεγχος ζει εδώ και μόνο εδώ: τον καλεί το app.js στο postPublish (τη στιγμή
// της σύνδεσης) και το stats.js στο sample() (ανάκληση εν ώρα εκπομπής). Δύο
// αντίγραφα θα απέκλιναν και το ένα από τα δύο σημεία θα άφηνε τρύπα.
// Ο διακόπτης είναι η **ύπαρξη** του αρχείου, όχι το περιεχόμενό του: αρχείο
// που λείπει ή χάλασε δεν ρίχνει τις εκπομπές (δρόμος αναδίπλωσης), αλλά ένα
// έγκυρο `{}` σημαίνει «αυτός ο server δεν έχει κανέναν πελάτη» και κλείνει —
// αλλιώς ένας server που μόλις μπήκε στο panel, ή του οποίου απενεργοποιήθηκαν
// όλοι οι πελάτες, θα γινόταν ορθάνοιχτος με το πρώτο sync.
export function publishAllowed(streamPath, key) {
  loadClients();
  if (!cache.ok) return true;
  const expected = clientOf(streamPath)?.paths[streamPath];
  // Ρητός έλεγχος για undefined: άγνωστο path με κλειδί undefined θα περνούσε
  // από σκέτη σύγκριση (undefined === undefined).
  return expected !== undefined && expected === key;
}

// Το close() του nms v4 είναι σκέτο socket.end(): μισό κλείσιμο. Στέλνει FIN αλλά
// συνεχίζει να διαβάζει, και ο publisher που δεν διαβάζει το δικό του άκρο
// (librtmp/OBS: μαθαίνει την αποσύνδεση μόνο όταν αποτύχει ένα write, και το write
// δεν αποτυγχάνει όσο εμείς αδειάζουμε το παράθυρο) εκπέμπει σαν να μη συνέβη
// τίποτα: το donePublish δεν βγαίνει ποτέ, ο ffmpeg του HLS ζει, οι θεατές βλέπουν
// stream που έχει ανακληθεί. Ο ffmpeg τυχαίνει να το καταλαβαίνει και να πεθαίνει —
// γι' αυτό η ανάκληση φαίνεται να δουλεύει σε δοκιμή με ffmpeg publisher.
// destroySoon και όχι destroy: πρώτα φεύγει ό,τι είναι ήδη στην ουρά (το onStatus
// της απόρριψης), μετά πέφτει και η κατεύθυνση της ανάγνωσης.
export function closeSession(session) {
  session.close();
  session.socket?.destroySoon();
}

export function loadPasswords() {
  return new Promise((resolve, reject) => {
    migratePasswords();
    fs.readFile(PASSWORDS, "utf8", (err, data) => {
      if (err) {
        // If the error is about the file not existing, resolve with null
        if (err.code === 'ENOENT') {
          resolve(null);
        } else {
          reject(err);
        }
        return;
      }

      try {
        // Convert the file content to an object
        const passwords = JSON.parse(data);

        resolve(passwords);
      } catch (parseErr) {
        console.error("Error parsing JSON string:", parseErr);
        reject(parseErr);
      }
    });
  });
}

export async function savePasswords(passwords) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync("./data", { recursive: true });
    fs.writeFile(
      PASSWORDS,
      JSON.stringify(passwords, null, 2),
      "utf8",
      (err) => {
        if (err) {
          console.error(err);
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
}
