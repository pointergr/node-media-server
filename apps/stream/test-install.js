// Έλεγχος των DNS records του install: node test-install.js
//
// Το install είναι bash, οπότε το test το κάνει source με INSTALL_LIB=1 (μόνο οι
// συναρτήσεις, τίποτα από όσα αγγίζουν το μηχάνημα) και βάζει ψεύτικο curl στο
// PATH — έτσι ελέγχεται τι *θα* ζητούσε από το Cloudflare, χωρίς δίκτυο.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "fs";
import os from "os";

const dir = fs.mkdtempSync(`${os.tmpdir()}/install-test-`);
const log = `${dir}/curl.log`;

// Το ipify απαντάει IP· ό,τι άλλο γράφεται στο log και παίρνει το CURL_REPLY.
fs.writeFileSync(`${dir}/curl`, `#!/bin/bash
for a in "$@"; do case "$a" in *ipify*) echo 1.2.3.4; exit 0;; esac; done
printf '%s\\n' "$*" >> ${log}
echo "$CURL_REPLY"
`);
fs.chmodSync(`${dir}/curl`, 0o755);

const run = (reply) => {
  fs.writeFileSync(log, "");
  return execFileSync(
    "bash",
    ["-c", "source ./install stream.example.com --cf-token TKN --cf-zone ZONE && cloudflare_dns"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, INSTALL_LIB: "1", CURL_REPLY: reply },
    },
  );
};

// ── Τα δύο records, με διαφορετικό proxied το καθένα ───────────────────────
run('{"success":true}');
const lines = fs.readFileSync(log, "utf8").trim().split("\n");
assert.equal(lines.length, 2, "δύο A records: το hostname και το rtmp.");
assert.match(lines[0], /POST https:\/\/api\.cloudflare\.com\/client\/v4\/zones\/ZONE\/dns_records/);
assert.match(lines[0], /Bearer TKN/);
assert.match(lines[0], /"type":"A","name":"stream\.example\.com","content":"1\.2\.3\.4","proxied":true/);
// Το rtmp. πρέπει να μείνει DNS only — το proxy περνάει μόνο HTTP(S), όχι 1935.
assert.match(lines[1], /"name":"rtmp\.stream\.example\.com","content":"1\.2\.3\.4","proxied":false/);

// ── Ξανατρέξιμο στον ίδιο server: το record υπάρχει ήδη, δεν είναι σφάλμα ──
const dup = run('{"success":false,"errors":[{"code":81057,"message":"Record already exists."}]}');
assert.match(dup, /υπάρχει ήδη/);

// ── Οτιδήποτε άλλο σταματάει το install: χωρίς DNS ο Caddy δεν βγάζει cert ─
let err;
try {
  run('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}');
} catch (e) {
  err = e;
}
assert.ok(err, "λάθος token πρέπει να σταματάει το install");
assert.match(err.stdout, /απέρριψε/);

console.log("test-install: OK");
