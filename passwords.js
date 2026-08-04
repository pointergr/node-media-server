import { Password } from "@hosterai/passwords";
import crypto from "crypto";
import {
  loadConfig,
  saveConfig,
  loadPasswords,
  savePasswords,
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

const passwords = await loadPasswords();
if (passwords && force===null) {
  console.log("Passwords already exist");
  console.log("-------------------------");
  printConfig(
    passwords.adminPassword,
    passwords.streamSecret,
    passwords.expire,
    passwords.hash,
    hostname
  );
  exit(0);
}

if(force) {
    console.log("Forcing new passwords generation");
    console.log("Please restart the server (pm2 restart stream)");
    console.log("-------------------------");
}

const password = new Password();

const adminPassword = password.generate(10);
const streamSecret = password
  .lowercaseLength(4)
  .uppercaseLength(4)
  .symbolsLength(0)
  .numbersLength(4)
  .generate(12);
const expire = Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 60 * 60;
const streamName = "/live/stream";
const hashString = `${streamName}-${expire}-${streamSecret}`;
console.log(`[hashString: ${hashString}]`);
const hash = crypto.createHash("md5").update(hashString).digest("hex");
const config = await loadConfig();
await updateConfig(config);

printConfig(adminPassword, streamSecret, expire, hash, hostname);

savePasswords({
  adminPassword,
  streamSecret,
  expire,
  hash,
});

function printConfig(adminPassword, streamSecret, expire, hash, hostname) {
  console.log(`Admin username: admin`);
  console.log(`Admin password: ${adminPassword}`);
  console.log(`Stream secret: ${streamSecret}`);
  console.log('');
  console.log(`rtmp url: rtmp://${hostname}/live/stream?sign=${expire}-${hash}`);
  console.log(`http url: http://${hostname}/live/stream.flv?sign=${expire}-${hash}`);
  console.log(`ws url: ws://${hostname}/live/stream.flv?sign=${expire}-${hash}`);
  console.log('');
  console.log(`hls url for player: https://${hostname}/live/stream/index.m3u8`);
  console.log('');
  console.log('--- Ρύθμιση OBS ---');
  console.log('Settings -> Stream');
  console.log(`  Service:    Custom...`);
  console.log(`  Server:     rtmp://${hostname}/live`);
  console.log(`  Stream Key: stream?sign=${expire}-${hash}`);
  console.log('Settings -> Output -> Output Mode: Advanced -> Streaming');
  console.log('  Keyframe Interval: 2  (υποχρεωτικό, αλλιώς σπάει το HLS)');
  console.log('  Encoder: x264 ή NVENC, Rate Control: CBR');
  console.log('Πάτα Start Streaming και μετά άνοιξε το hls url παραπάνω.');
}

async function updateConfig(config) {
  config.auth.jwt.users[0].password = adminPassword;
  config.auth.secret = streamSecret;
  await saveConfig(config);
  return config;
}
