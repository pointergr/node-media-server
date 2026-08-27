import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  loadConfig,
  saveConfig,
  loadPasswords,
  savePasswords,
  loadClients,
  clientOf,
  CLIENTS,
} from "./config.js";
import { exit } from "process";

const args = process.argv.slice(2); 
const hostname = args[0];
const force = args[1] || null;
if(!hostname) {
  console.log("Please provide a server hostname in order to generate passwords");
  console.log("Example: node passwords.js myserver.streamings.gr");    
  exit(1);
}

const streamName = "/live/stream";
const streamKey = ensureClient();

const passwords = await loadPasswords();
if (passwords && force===null) {
  console.log("Passwords already exist");
  console.log("-------------------------");
  printConfig(passwords.adminPassword, streamKey, hostname);
  exit(0);
}

if(force) {
    console.log("Forcing new passwords generation");
    console.log("Please restart the server (pm2 restart stream)");
    console.log("-------------------------");
}

// Σκέτο crypto αντί για γεννήτρια κωδικών: το @hosterai/passwords κουβαλούσε
// bcrypt -> node-pre-gyp -> tar (1 critical, 3 high στο npm audit) για να κάνει
// αυτό που κάνει μια γραμμή — και κανείς δεν πληκτρολογεί αυτούς τους κωδικούς,
// τους κάνει αντιγραφή από το config block.
const adminPassword = crypto.randomBytes(12).toString("base64url"); // 16 χαρακτήρες
const streamSecret = crypto.randomBytes(18).toString("base64url"); // 24 χαρακτήρες
const config = await loadConfig();
await updateConfig(config);

printConfig(adminPassword, streamKey, hostname);

savePasswords({
  adminPassword,
  streamSecret,
});

// Με το νέο μοντέλο ο έλεγχος εκπομπής γίνεται από το clients.json, όχι από το
// sign του nms (auth.publish: false). Χωρίς clients.json δεν επιβάλλεται τίποτα
// — δηλαδή μια καθαρή εγκατάσταση θα ήταν ορθάνοιχτη σε όποιον ξέρει το URL.
// Γι' αυτό φτιάχνουμε εδώ έναν προεπιλεγμένο πελάτη: ο server είναι κλειστός από
// το πρώτο λεπτό, και ο πελάτης παίρνει ένα κλειδί αντί για secret + sign.
// Υπάρχον clients.json (π.χ. από το panel) δεν πειράζεται.
function ensureClient() {
  const existing = clientOf(streamName);
  if (existing) return existing.paths[streamName];
  const key = crypto.randomBytes(18).toString("base64url"); // 24 χαρακτήρες
  const clients = { ...loadClients(), default: { limit: 0, paths: { [streamName]: key } } };
  fs.mkdirSync(path.dirname(CLIENTS), { recursive: true });
  fs.writeFileSync(CLIENTS, JSON.stringify(clients, null, 2));
  return key;
}

function printConfig(adminPassword, streamKey, hostname) {
  console.log(`Admin username: admin`);
  console.log(`Admin password: ${adminPassword}`);
  console.log(`Admin API:     https://${hostname}/admin/api/live  (JSON, βασικό auth — το UI ζει στο κεντρικό panel)`);
  console.log('');
  console.log(`=== ΕΚΠΟΜΠΗ (OBS) -> rtmp.${hostname} ===`);
  console.log('Το rtmp. πρέπει να είναι DNS only στο Cloudflare (γκρι σύννεφο):');
  console.log('το proxy περνάει μόνο HTTP(S), το 1935 δεν φτάνει ποτέ στον server.');
  console.log('');
  console.log('OBS -> Settings -> Stream');
  console.log('  Service:    Custom...');
  console.log(`  Server:     rtmp://rtmp.${hostname}/live`);
  console.log(`  Stream Key: stream?key=${streamKey}`);
  console.log('OBS -> Settings -> Output -> Output Mode: Advanced -> Streaming');
  console.log('  Keyframe Interval: 2  (υποχρεωτικό, αλλιώς σπάει το HLS)');
  console.log('  Encoder: x264 ή NVENC, Rate Control: CBR');
  console.log('');
  console.log(`=== ΑΝΑΠΑΡΑΓΩΓΗ (players) -> ${hostname} ===`);
  console.log('Αυτά περνάνε από το Cloudflare (πορτοκαλί σύννεφο).');
  console.log('');
  console.log(`  hls: https://${hostname}/live/stream/index.m3u8`);
  console.log(`  flv: https://${hostname}/live/stream.flv`);
  console.log(`  ws:  wss://${hostname}/live/stream.flv`);
  console.log('');
  console.log('Η αναπαραγωγή είναι ανοιχτή — το κλειδί χρειάζεται μόνο στην εκπομπή.');
  console.log(`Τα paths και τα κλειδιά ζουν στο ${CLIENTS} (τα γράφει το panel).`);
}

async function updateConfig(config) {
  config.auth.jwt.users[0].password = adminPassword;
  config.auth.secret = streamSecret;
  // Το κλειδί που μόλις τυπώσαμε το ελέγχει το clients.json, όχι το sign του nms.
  // Σε server που αναβαθμίζεται, ένα ξεχασμένο auth.publish: true θα απέρριπτε το
  // `?key=` πριν φτάσει καν στον δικό μας έλεγχο.
  config.auth.publish = false;
  await saveConfig(config);
  return config;
}
