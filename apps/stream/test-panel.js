// Έλεγχος του sync με το panel: node test-panel.js
import assert from "node:assert";
import fs from "fs";
import os from "os";

const file = `${fs.mkdtempSync(`${os.tmpdir()}/panel-test-`)}/clients.json`;
process.env.CLIENTS_FILE = file;
const { startPanelSync } = await import("./panel.js");

let reply = null; // τι απαντάει το panel σε αυτόν τον γύρο
const calls = [];

globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (typeof reply === "function") return reply();
  return new Response(JSON.stringify(reply), { status: 200 });
};

const snapshot = () => ({ streams: [{ stream: "/live/stream", viewers: 7 }] });
const sync = (panel) => startPanelSync({ panel }, snapshot);

// Χωρίς url το sync είναι απενεργοποιημένο (ίδιο μοτίβο με το hls.r2.accessKeyId)
assert.equal(sync({ url: "", token: "t", host: "h" }), undefined, "χωρίς url δεν συγχρονίζει");
assert.equal(calls.length, 0, "και δεν χτυπάει τίποτα");

// Επιτυχία: το clients.json γράφεται, το σώμα του request έχει το snapshot
reply = { a: { limit: 5, paths: { "/live/k1": "K1" } } };
await sync({ url: "https://panel.test", token: "μυστικό", host: "srv1" })();

assert.equal(calls[0].url, "https://panel.test/servers/srv1/sync");
assert.equal(calls[0].init.headers.authorization, "Bearer μυστικό");
assert.deepEqual(JSON.parse(calls[0].init.body), snapshot(), "το σώμα είναι το snapshot");
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), reply, "η απάντηση γράφτηκε στο clients.json");
assert.ok(!fs.existsSync(`${file}.tmp`), "το tmp δεν μένει πίσω (γράψιμο με tmp+rename)");

const saved = fs.readFileSync(file, "utf8");

// Panel κάτω δεν σημαίνει εκπομπές κάτω: ό,τι κι αν συμβεί, το τελευταίο
// clients.json μένει ανέγγιχτο — αλλιώς κάθε 500 θα έκοβε όλους τους πελάτες.
reply = () => new Response("boom", { status: 500 });
await sync({ url: "https://panel.test", token: "t", host: "srv1" })();
assert.equal(fs.readFileSync(file, "utf8"), saved, "HTTP 500 δεν αγγίζει το clients.json");

reply = () => { throw new Error("The operation was aborted due to timeout"); };
await sync({ url: "https://panel.test", token: "t", host: "srv1" })();
assert.equal(fs.readFileSync(file, "utf8"), saved, "timeout δεν αγγίζει το clients.json");

fs.rmSync(file.slice(0, file.lastIndexOf("/")), { recursive: true, force: true });
console.log("panel sync OK");
process.exit(0);
