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
