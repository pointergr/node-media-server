// Το impersonation είναι σκέτη ανταλλαγή token στο localStorage — αν χαθεί το
// token του admin στην πορεία, η «επιστροφή στη διαχείριση» γίνεται σιωπηλά
// αποσύνδεση. Γι' αυτό δοκιμάζεται εδώ και όχι με το μάτι στο UI.
import assert from "node:assert";

const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.useRuntimeConfig = () => ({ public: { apiBase: "/api" } });

// Η αλλαγή συνεδρίας γίνεται με πλήρη φόρτωση (δες useApi.ts) — καμία
// συνάρτηση του Nuxt, σκέτο location.href.
globalThis.location = { href: "/admin/clients" };
globalThis.navigateTo = () => {}; // το χρησιμοποιεί μόνο ο δρόμος του 401

// Ίδιο κόλπο με το test-r2.js του apps/stream: fake fetch, καμία εξάρτηση.
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body) });
  const json = url.endsWith("/auth/login-link")
    ? { url: "https://panel.example/login#t=LINK", expiresIn: 300 }
    : { access_token: "CUSTOMER" };
  return { ok: true, status: 200, text: async () => JSON.stringify(json) };
};

const { impersonate, stopImpersonating, impersonating, setToken, clearToken } =
  await import("./app/composables/useApi.ts");

// Είσοδος ως πελάτης: link μιας χρήσης -> ανταλλαγή -> το token του admin στην άκρη.
setToken("ADMIN");
await impersonate(5);
assert.equal(calls[0].url, "/api/auth/login-link");
assert.equal(calls[0].body.clientId, 5);
assert.equal(calls[1].url, "/api/auth/exchange");
assert.equal(calls[1].body.token, "LINK", "το token βγαίνει από το fragment του url");
assert.equal(store.get("pointer_token"), "CUSTOMER");
assert.equal(store.get("pointer_admin_token"), "ADMIN");
assert.equal(impersonating(), true);
assert.equal(location.href, "/");

// Επιστροφή: το token του admin ξαναγίνεται η συνεδρία και φεύγει από την άκρη.
await stopImpersonating();
assert.equal(store.get("pointer_token"), "ADMIN");
assert.equal(store.has("pointer_admin_token"), false);
assert.equal(impersonating(), false);
assert.equal(location.href, "/admin");

// Χωρίς φυλαγμένο token δεν κάνει τίποτα — δεν πετάει έξω τον χρήστη.
location.href = "/";
await stopImpersonating();
assert.equal(store.get("pointer_token"), "ADMIN");
assert.equal(location.href, "/");

// Το 401 (και η αποσύνδεση) καθαρίζει **και τα δύο** κλειδιά: αλλιώς ένα ξεχασμένο
// admin token ξυπνάει στην επόμενη σύνδεση και δείχνει μπάρα επιστροφής σε πελάτη.
setToken("A");
localStorage.setItem("pointer_admin_token", "B");
clearToken();
assert.equal(store.size, 0);

console.log("ok");
