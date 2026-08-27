// Το usePaged είναι η μόνη λογική πίσω από τις τρεις λίστες του /admin, και οι
// δύο τρόποι που σπάει μια σελιδοποιημένη λίστα είναι σιωπηλοί: φιλτράρεις από
// τη σελίδα 3 και βλέπεις άδειο, ή σβήνεις εγγραφές και μένεις σε σελίδα που δεν
// υπάρχει πια. Γι' αυτό δοκιμάζεται εδώ και όχι με το μάτι.
import assert from "node:assert";
import { ref } from "vue";
import { usePaged } from "./app/composables/usePaged.ts";

const rows = ref(Array.from({ length: 45 }, (_, i) => ({ name: `row${i}` })));
const { q, page, shown, paged } = usePaged(rows, r => r.name, 20);

assert.equal(paged.value.length, 20);
assert.equal(paged.value[0].name, "row0");

page.value = 3;
assert.equal(paged.value.length, 5, "η τελευταία σελίδα είναι το υπόλοιπο");
assert.equal(paged.value[0].name, "row40");

// Φίλτρο από βαθιά σελίδα: επιστροφή στην πρώτη, αλλιώς η αναζήτηση δείχνει άδειο.
q.value = "row1";
assert.equal(page.value, 1);
assert.equal(shown.value.length, 11, "row1 + row10..row19");
assert.equal(paged.value.length, 11);

// Κενό/κενά = καθόλου φίλτρο.
q.value = "  ";
assert.equal(shown.value.length, 45);

// Διαγραφή εγγραφών κάτω από τα πόδια της τρέχουσας σελίδας.
page.value = 3;
rows.value = rows.value.slice(0, 5);
assert.equal(page.value, 1, "η σελίδα δεν μένει έξω από τη λίστα");
assert.equal(paged.value.length, 5);

// Άδεια λίστα: σελίδα 1, όχι 0 — το UPagination μετράει από το 1.
rows.value = [];
assert.equal(page.value, 1);
assert.deepEqual(paged.value, []);

console.log("ok");
