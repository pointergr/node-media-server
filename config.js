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

export function loadPasswords() {
  return new Promise((resolve, reject) => {
    fs.readFile("./passwords.json", "utf8", (err, data) => {
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
    fs.writeFile(
      "./passwords.json",
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
