import { Password } from "@hosterai/passwords";
import crypto from "crypto";
import {
  loadConfig,
  saveConfig,
  loadPasswords,
  savePasswords,
} from "./config.js";
import { exit } from "process";

const passwords = await loadPasswords();
if (passwords) {
  console.log("Passwords already exist");
  console.log("-------------------------");
  printConfig(
    passwords.adminPassword,
    passwords.streamSecret,
    passwords.expire,
    passwords.hash
  );
  exit(0);
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

printConfig(adminPassword, streamSecret, expire, hash);

savePasswords({
  adminPassword,
  streamSecret,
  expire,
  hash,
});

function printConfig(adminPassword, streamSecret, expire, hash) {
  console.log(`Admin username: admin`);
  console.log(`Admin password: ${adminPassword}`);
  console.log(`Stream secret: ${streamSecret}`);
  console.log(`rtmp url: rtmp://hostname/live/stream?sign=${expire}-${hash}`);
}

async function updateConfig(config) {
  config.auth.api_pass = adminPassword;
  config.auth.secret = streamSecret;
  await saveConfig(config);
  return config;
}
