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
const hash = crypto.createHash("md5").update(hashString).digest("hex");
const config = await loadConfig();
const newConfig = await updateConfig(config);

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
  console.log(`rtmp url: rtmp://${hostname}/live/stream?sign=${expire}-${hash}`);
}

async function updateConfig(config) {
  config.auth.api_pass = adminPassword;
  config.auth.secret = streamSecret;
  await saveConfig(config);
  return config;
}
