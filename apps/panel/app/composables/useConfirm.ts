import ConfirmModal from '~/components/ConfirmModal.vue'

// Το `confirm()` του browser σε μορφή Nuxt UI: ίδιο σχήμα κλήσης (μια γραμμή,
// await, boolean), ώστε τα σημεία που ρωτούν να μη γεμίσουν state για modals.
//
// Νέο overlay ανά ερώτηση: το useOverlay κρατάει κοινό πίνακα για όλη την
// εφαρμογή, οπότε ένα instance που στηνόταν μια φορά ανά σελίδα θα συσσωρευόταν
// σε κάθε πλοήγηση.
//
// Το ξεφόρτωμα το κάνουμε εμείς και όχι ο provider με το `after:leave` του
// UModal: εκείνο δεν βγαίνει σε αυτή την έκδοση (το animation κλεισίματος είναι
// CSS, όχι Vue transition) και κάθε ερώτηση άφηνε πίσω της ένα κλειστό modal στο
// DOM. Ένας ιδιοκτήτης, όχι δύο — το `unmount` δεύτερη φορά θα έσκαγε με
// «Overlay not found». Ο χρόνος είναι όσο το animation του Nuxt UI (200ms).
const LEAVE_MS = 250

export function useConfirm() {
  const overlay = useOverlay()

  return async (props: { title: string, description?: string, confirmLabel?: string }) => {
    const instance = overlay.create(ConfirmModal, { props, destroyOnClose: true })
    const answer = await (instance.open() as unknown as Promise<boolean | undefined>)
    setTimeout(() => overlay.unmount(instance.id), LEAVE_MS)
    return answer
  }
}
