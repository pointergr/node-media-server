import fs from "fs";
import path from "path";
import { CLIENTS } from "./config.js";

// Ένα POST ανά 10s προς το panel: στέλνει το snapshot (τι παίζει, πόσοι θεατές)
// και παίρνει πίσω το clients.json αυτού του server. Pull αντί για push γιατί
// ο server συγχρονίζεται μόνος του μετά από restart/deploy, ενώ ένα push προς
// server εκτός λειτουργίας χάνεται και το panel θα έπρεπε να κρατάει ουρά και να
// ξέρει ποιος είναι πάνω. WebSocket δεν χρειάζεται: η μόνη απαίτηση χαμηλής
// καθυστέρησης είναι η ανάκληση, και τα 10s φτάνουν.
const SYNC_MS = 10_000;

export function startPanelSync(config, snapshot) {
  const { url, token, host } = config.panel ?? {};
  if (!url) return; // χωρίς panel, το clients.json το γράφει το χέρι

  // Ο φάκελος μπορεί να μην υπάρχει: το stats.js φτιάχνει μόνο τον φάκελο του
  // stats.db, που με το προεπιλεγμένο config είναι η ρίζα (./stats.db) — τότε το
  // ./data δεν το φτιάχνει κανείς και κάθε sync θα απέτυχε σιωπηλά στο log.
  fs.mkdirSync(path.dirname(CLIENTS), { recursive: true });

  const tick = async () => {
    try {
      const res = await fetch(`${url}/servers/${host}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(snapshot()),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const clients = JSON.stringify(await res.json(), null, 2);
      // tmp+rename: ο loader διαβάζει σύγχρονα και μπορεί να πέσει ακριβώς εδώ —
      // με το rename δεν βλέπει ποτέ μισό JSON (που θα ίσχυε σαν «χωρίς πελάτες»).
      fs.writeFileSync(`${CLIENTS}.tmp`, clients);
      fs.renameSync(`${CLIENTS}.tmp`, CLIENTS);
    } catch (e) {
      // Το τελευταίο clients.json μένει σε ισχύ: panel κάτω δεν σημαίνει εκπομπές κάτω.
      console.error(`panel sync: ${e.message}`);
    }
  };

  tick();
  // unref: το sync δεν είναι λόγος να μείνει ζωντανή η διεργασία.
  setInterval(tick, SYNC_MS).unref();
  return tick; // τα tests περιμένουν έναν γύρο χωρίς να κοιτάνε το ρολόι
}
