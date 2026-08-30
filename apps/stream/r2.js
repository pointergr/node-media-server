// Ανεβάζει τα HLS segments στο R2 και δημοσιεύει το playlist που τα δείχνει.
// Τα playlists μένουν πάντα στο origin (εκεί μετράμε τους θεατές), τα segments
// φεύγουν από το R2 — έτσι δεν περνάει βίντεο από το CDN του domain.
//
// Ό,τι δεν προλάβει να ανέβει μέσα σε ένα segment δημοσιεύεται με την *τοπική*
// του διαδρομή και το σερβίρει ο static server, όπως χωρίς R2: το R2 είναι
// βελτιστοποίηση της κίνησης, ποτέ εξάρτηση της αναπαραγωγής. Ο κανόνας αυτός
// είναι όλη η διαφορά ανάμεσα σε «το R2 αργεί σήμερα» και «η εκπομπή δεν παίζει»:
// όσο το playlist περίμενε τα uploads, ένας γύρος που ξεπερνούσε τα 2s άφηνε
// segment πίσω, ο επόμενος γύρος έβρισκε δύο, και από εκεί και πέρα το playlist
// δεν ξαναπρολάβαινε ποτέ.
import fs from "fs";
import { AwsClient } from "aws4fetch";
import { SEGMENT_SEC } from "./ladder.js";

// Τα segments ενός playlist: κάθε γραμμή που δεν είναι directive. Με -hls_base_url
// είναι απόλυτα URLs, οπότε κρατάμε μόνο το όνομα του αρχείου.
export const playlistSegments = (playlist) =>
  playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("/").pop());

// onUpload(name, bytes): κλήση μετά από κάθε *επιτυχημένο* PUT, για να τρέφει τον
// εκτιμητή bitrate εξόδου του stats.js (τα segments δεν περνάνε ποτέ από το δικό
// μας HTTP server όταν σερβίρονται από το R2). onFallback(name): κλήση μία φορά
// για κάθε segment που δεν πρόλαβε και δημοσιεύτηκε από το origin — έτσι η
// υποβάθμιση φαίνεται στο snapshot (και στο panel) όσο συμβαίνει. Το r2.js δεν
// κάνει require το stats.js — δεν ξέρει καν ότι υπάρχει — το app.js περνάει τα
// callbacks.
export function startR2Sync(dir, streamPath, r2, onUpload, onFallback) {
  const aws = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: "s3",
    region: "auto",
    retries: 0,
  });

  const src = `${dir}/ff`;
  const segments = new Map();
  const staged = new Map();
  const published = new Map();
  let stopped = false;
  let degraded = false;
  const pending = [];
  let activeUploads = 0;
  const maxUploads = 4;

  const publish = (name, body) => {
    if (stopped || published.get(name) === body) return;
    fs.writeFileSync(`${dir}/${name}.tmp`, body);
    fs.renameSync(`${dir}/${name}.tmp`, `${dir}/${name}`);
    published.set(name, body);
  };

  const setOrigin = (name, state, reason, report = true) => {
    if (state.status === "origin" || state.status === "missing") return;
    state.status = "origin";
    state.controller?.abort(new Error("segment δημοσιεύτηκε από το origin"));
    if (report) onFallback?.(name);
    if (report && !degraded) {
      degraded = true;
      const message = reason?.message ?? reason;
      console.warn(`R2 ${streamPath}: δεν προλαβαίνει — τα segments φεύγουν από το origin (${message})`);
    }
  };

  const setMissing = (name, err) => {
    segments.get(name)?.controller?.abort(err);
    if (segments.get(name)?.status === "missing") return;
    segments.set(name, { status: "missing" });
    onFallback?.(name);
    if (!degraded) {
      degraded = true;
      console.warn(`R2 ${streamPath}: λείπει segment — παραλείπεται από το playlist (${err.message})`);
    }
  };

  const put = async (name, body, signal) => {
    const res = await aws.fetch(`${r2.endpoint}/${r2.bucket}${streamPath}/${name}`, {
      method: "PUT",
      body,
      headers: {
        "Content-Type": "video/mp2t",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      signal,
    });
    if (!res.ok) throw new Error(`PUT ${name} -> ${res.status} ${await res.text()}`);
  };

  const pump = () => {
    if (stopped) return;
    while (activeUploads < maxUploads && pending.length) {
      const { name, body, state } = pending.shift();
      if (segments.get(name) !== state || state.status !== "uploading") continue;
      state.controller = new AbortController();
      const signal = AbortSignal.any([
        state.controller.signal,
        AbortSignal.timeout(SEGMENT_SEC * 1000),
      ]);
      activeUploads++;
      put(name, body, signal)
        .then(() => {
          if (stopped || segments.get(name) !== state || state.status !== "uploading") return;
          state.status = "uploaded";
          onUpload?.(name, body.length);
          if (degraded) {
            degraded = false;
            console.warn(`R2 ${streamPath}: ξαναπρολαβαίνει, τα segments ξαναπάνε στο R2`);
          }
        })
        .catch((err) => {
          if (stopped || segments.get(name) !== state || state.status !== "uploading") return;
          setOrigin(name, state, err);
        })
        .finally(() => {
          activeUploads--;
          pump();
        });
    }
  };

  const upload = (name, body) => {
    const state = { status: "uploading" };
    segments.set(name, state);
    pending.push({ name, body, state });
    pump();
  };

  const render = (body, limit = Infinity) => {
    const output = [];
    let discontinuity = false;
    let included = 0;
    let leadingMissing = 0;
    for (const line of body.split("\n")) {
      const url = line.trim();
      if (!url || url.startsWith("#")) {
        output.push(line);
        continue;
      }

      const name = url.split("/").pop();
      const status = segments.get(name)?.status;
      if (status === "missing") {
        if (output.at(-1)?.startsWith("#EXTINF")) output.pop();
        if (!included) leadingMissing++;
        discontinuity = true;
        continue;
      }
      if (included >= limit) {
        if (output.at(-1)?.startsWith("#EXTINF")) output.pop();
        continue;
      }

      if (discontinuity) {
        const beforeExtinf = output.at(-1)?.startsWith("#EXTINF") ? output.length - 1 : output.length;
        if (output[beforeExtinf - 1] !== "#EXT-X-DISCONTINUITY") {
          output.splice(beforeExtinf, 0, "#EXT-X-DISCONTINUITY");
        }
        discontinuity = false;
      }
      output.push(status === "uploaded" ? line : `ff/${name}`);
      included++;
    }
    if (leadingMissing) {
      const sequence = output.findIndex((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
      if (sequence !== -1) {
        const value = Number(output[sequence].slice("#EXT-X-MEDIA-SEQUENCE:".length));
        output[sequence] = `#EXT-X-MEDIA-SEQUENCE:${value + leadingMissing}`;
      }
    }
    return output.join("\n");
  };

  const sync = () => {
    if (stopped || !fs.existsSync(src)) return;
    const lists = fs.readdirSync(src)
      .filter((name) => name.endsWith(".m3u8"))
      .map((name) => ({ name, body: fs.readFileSync(`${src}/${name}`, "utf8") }));
    const media = lists.filter((l) => !l.body.includes("#EXT-X-STREAM-INF"));

    for (const l of media) {
      l.publishBody = staged.get(l.name);
      l.changed = l.publishBody !== l.body;
      if (l.changed) staged.set(l.name, l.body);
      l.segments = playlistSegments(l.body);
    }

    const changed = media.filter((l) => l.changed);
    const first = changed.filter((l) => !published.has(l.name));

    // Η πρώτη εικόνα κάθε variant βγαίνει αμέσως από το DNS-only origin. Αν το
    // watcher άργησε, μόνο το πρώτο διαθέσιμο segment βγαίνει έτσι· τα νεότερα
    // ξεκινούν ήδη το κανονικό upload-ahead.
    for (const l of first) {
      let immediate = false;
      for (const name of l.segments) {
        try {
          if (!immediate) {
            fs.accessSync(`${src}/${name}`);
            segments.set(name, { status: "origin" });
            immediate = true;
          } else {
            upload(name, fs.readFileSync(`${src}/${name}`));
          }
        } catch (err) {
          setMissing(name, err);
        }
      }
      publish(l.name, render(l.body, 1));
    }

    // Κάθε νέο segment αρχίζει να ανεβαίνει αμέσως, αλλά το sync δεν περιμένει
    // το Promise. Μόνο πραγματική αλλαγή του source playlist μετακινεί τη σκηνή:
    // το περιοδικό poll του ίδιου body δεν προωθεί μόνο του το live edge.
    const advancing = changed.filter((l) => published.has(l.name) && !first.includes(l));
    for (const l of advancing) {
      for (const name of l.segments) {
        if (segments.has(name)) continue;
        try {
          upload(name, fs.readFileSync(`${src}/${name}`));
        } catch (err) {
          setMissing(name, err);
        }
      }
    }

    for (const l of advancing) {
      const body = l.publishBody;
      for (const name of playlistSegments(body)) {
        const state = segments.get(name);
        if (state?.status === "uploading") {
          setOrigin(name, state, "δεν ολοκληρώθηκε πριν από τη δημοσίευση");
        }
      }
      publish(l.name, render(body));
    }

    // Το master υπόσχεται όλα τα variants, άρα δεν βγαίνει μέχρι να έχει
    // δημοσιευτεί καθένα έστω μία φορά.
    if (media.length && media.every((l) => published.has(l.name))) {
      for (const l of lists) if (!media.includes(l)) publish(l.name, l.body);
    }

    // Κρατάμε μόνο ό,τι υπάρχει στο τρέχον source ή στο playlist που βλέπουν
    // πράγματι οι θεατές. Το δεύτερο είναι επίτηδες έναν κύκλο παλαιότερο.
    const live = new Set(media.flatMap((l) => [
      ...l.segments,
      ...playlistSegments(published.get(l.name) ?? ""),
    ]));
    for (const [name, state] of segments) if (!live.has(name)) {
      state.controller?.abort(new Error("segment εκτός live window"));
      segments.delete(name);
    }
  };

  // Πολλά rename events του ίδιου ffmpeg tick συγχωνεύονται σε μία ανάγνωση.
  // Το πραγματικό upload ζει ανεξάρτητα και δεν κρατάει τη δημοσίευση σε αναμονή.
  let scheduled = false;
  const queue = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped) return;
      try {
        sync();
      } catch (err) {
        console.error(`R2 sync ${streamPath}: ${err.message}`);
      }
    });
  };

  const watcher = fs.watch(src, (_, file) => {
    if (file?.endsWith(".m3u8")) queue();
  });
  watcher.on("error", (err) => console.error(`R2 watch ${streamPath}: ${err.message}`));

  const poll = setInterval(queue, 2000);

  return () => {
    stopped = true;
    pending.length = 0;
    for (const state of segments.values()) {
      state.controller?.abort(new Error("R2 sync stopped"));
    }
    clearInterval(poll);
    watcher.close();
  };
}
