// Φίλτρο + σελιδοποίηση στον browser, όχι στο API: οι τρεις κατάλογοι του
// /admin (πελάτες, πλάνα, servers) έρχονται ούτως ή άλλως ολόκληροι σε μία
// κλήση — ένα `?page=` θα ζητούσε αλλαγή σε τρία endpoints για να λύσει κάτι
// που δεν έχει σπάσει ακόμα.
//
// Ρητά imports από το `vue` και όχι auto-import: το test-paged.js το φορτώνει
// σκέτο σε node, όπου δεν υπάρχει Nuxt.
import { computed, ref, watch, type Ref } from 'vue'

// `text` = ό,τι ψάχνεται για τη συγκεκριμένη λίστα, σε μία σειρά ανά εγγραφή.
export function usePaged<T>(rows: Ref<T[]>, text: (row: T) => string, perPage = 20) {
  const q = ref('')
  const page = ref(1)

  const shown = computed(() => {
    const t = q.value.trim().toLowerCase()
    return t ? rows.value.filter(r => text(r).toLowerCase().includes(t)) : rows.value
  })
  const paged = computed(() => shown.value.slice((page.value - 1) * perPage, page.value * perPage))

  // Νέα αναζήτηση = από την αρχή: με 3 σελίδες αποτελεσμάτων και τον δείκτη
  // στην 5η, η λίστα βγαίνει άδεια και μοιάζει με «κανένα αποτέλεσμα».
  // `sync`: το reset πρέπει να έχει γίνει πριν διαβαστεί το `paged` — με το
  // προεπιλεγμένο `pre` ο δείκτης προλαβαίνει να δείξει μία φορά άδεια λίστα.
  watch(q, () => page.value = 1, { flush: 'sync' })
  // Και όταν κονταίνει η λίστα από κάτω (διαγραφή, φίλτρο σε άλλο πεδίο).
  watch(shown, (list) => {
    const last = Math.max(1, Math.ceil(list.length / perPage))
    if (page.value > last) page.value = last
  }, { flush: 'sync' })

  return { q, page, shown, paged, perPage }
}
