// Μεταβλητή v-for που διέφυγε από το scope της. Το `<tr v-for="p in s.paths">`
// κλείνει στο `</tr>`: ένα δεύτερο `<tr v-if="… p.id">` από κάτω δεν βλέπει πια
// το `p`, ο compiler το αναλύει ως `_ctx.p` (property του component, δηλαδή
// undefined) και η σελίδα σκάει σε render με «Cannot read properties of
// undefined». Ούτε το `nuxt build` ούτε το lint το πιάνουν — το template
// μεταγλωττίζεται μια χαρά, απλώς δείχνει σε λάθος αντικείμενο. Γι' αυτό ο
// έλεγχος γίνεται εδώ, πάνω στο ίδιο το generated code του compiler.
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse, compileTemplate } from "@vue/compiler-sfc";

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".vue")) files.push(p);
  }
})("app");

assert.ok(files.length > 5, "δεν βρέθηκαν .vue — λάθος cwd;");

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const { descriptor } = parse(source, { filename: file });
  if (!descriptor.template) continue;

  // Τα ονόματα που δεσμεύει κάθε v-for του αρχείου: `v-for="p in s.paths"`,
  // `v-for="(v, k) in map"`, `v-for="{ id } in rows"`. Ό,τι από αυτά βρεθεί
  // ως `_ctx.<όνομα>` στο generated code έχει διαρρεύσει εκτός βρόχου.
  const bound = new Set();
  for (const m of descriptor.template.content.matchAll(/v-for="\s*\(?([^)]*?)\)?\s+(?:in|of)\s/g)) {
    for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(n[0]);
  }
  if (!bound.size) continue;

  const { code, errors } = compileTemplate({
    id: file,
    filename: file,
    source: descriptor.template.content,
  });
  assert.equal(errors.length, 0, `${file}: ${errors.map(e => e.message).join(", ")}`);

  for (const name of bound) {
    assert.ok(
      !new RegExp(`_ctx\\.${name}\\b`).test(code),
      `${file}: το «${name}» του v-for χρησιμοποιείται και εκτός του βρόχου του `
      + `(ο compiler το έβγαλε _ctx.${name}) — τύλιξε τα αδέρφια σε κοινό <template v-for>`,
    );
  }
}

console.log("ok");
