// Έλεγχος της μεταφοράς του passwords.json στο ./data: node test-passwords.js
import assert from "node:assert";
import fs from "fs";
import os from "os";
import { loadPasswords, savePasswords } from "./config.js";

const cwd = process.cwd();
process.chdir(fs.mkdtempSync(`${os.tmpdir()}/pw-test-`));

assert.equal(await loadPasswords(), null, "χωρίς αρχείο, τίποτα — δεν σκάει");

await savePasswords({ adminPassword: "x" });
assert.ok(fs.existsSync("./data/passwords.json"), "γράφεται στο data volume");

// Υπάρχων server: το παλιό αρχείο μεταφέρεται αντί να αγνοηθεί. Αν αγνοούνταν,
// το generate-passwords θα έφτιαχνε νέους κωδικούς και θα άλλαζε το stream key.
fs.rmSync("./data", { recursive: true });
fs.writeFileSync("./passwords.json", JSON.stringify({ adminPassword: "παλιό" }));
assert.equal((await loadPasswords()).adminPassword, "παλιό", "οι παλιοί κωδικοί βρίσκονται");
assert.ok(!fs.existsSync("./passwords.json"), "το παλιό αρχείο δεν μένει πίσω");
assert.ok(fs.existsSync("./data/passwords.json"), "μεταφέρθηκε στο data");

fs.rmSync(process.cwd(), { recursive: true, force: true });
process.chdir(cwd);
console.log("passwords migration OK");
