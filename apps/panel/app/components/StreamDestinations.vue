<script setup lang="ts">
// Οι εξωτερικοί προορισμοί ενός stream: πού αλλού πάει η ίδια εκπομπή. Ένα
// component για τους δύο δρόμους (ο πελάτης από το `/`, ο admin από το
// `/admin/clients`) — γι' αυτό δέχεται σκέτο `endpoint` αντί να χτίζει μόνο του
// τη διαδρομή: τα δύο URL διαφέρουν, η οθόνη όχι.

interface Destination {
  id: number
  name: string
  url: string
  key: string
  enabled: boolean
  // "live" | "retrying" από τον stream server. `null` όταν δεν εκπέμπει, και
  // **απόν** όταν η λίστα έρχεται από το /clients — εκεί το API διαβάζει τη
  // βάση, όχι το τελευταίο snapshot (δες apps/stream/relay.js).
  state?: string | null
}

const props = defineProps<{
  // `/me/streams/:id/destinations` ή `/clients/:id/paths/:pathId/destinations`.
  endpoint: string
  destinations: Destination[]
  // Πόσους επιτρέπει το πλάνο. 0 = δεν πουλάει αναδιανομή — τότε δεν δείχνουμε
  // φόρμα, γιατί το API θα απαντούσε 409 και ο πελάτης δεν θα καταλάβαινε γιατί.
  max: number
  // Χωρίς publisher δεν υπάρχει relay να έχει κατάσταση: τα badge θα έλεγαν
  // ψέματα («δεν συνδέεται») για κάτι που απλώς δεν τρέχει.
  live: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const ask = useConfirm()

// Οι πλατφόρμες που καλύπτουν τη συντριπτική πλειοψηφία, με το ingest URL τους
// έτοιμο. Δεν είναι κλειστή λίστα: το «Άλλο» δέχεται οποιοδήποτε rtmp/rtmps, και
// γι' αυτό ακριβώς δεν υπάρχει ούτε μία γραμμή ανά πλατφόρμα στον stream server.
// Το Facebook θέλει rtmps — δες apps/api/src/clients/destinations.ts.
// Μόνο όσες έχουν **σταθερή** διεύθυνση για όλους. Το Kick δίνει ingest URL ανά
// χρήστη και το Twitch ανά περιοχή: ένα preset εκεί θα ήταν λάθος τιμή που
// φαίνεται σωστή, δηλαδή χειρότερο από κενό πεδίο. Ο πελάτης τα κολλάει με το
// «Άλλο», ακριβώς όπως τα βρίσκει στη σελίδα τους.
const PRESETS = [
  { label: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2' },
  { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  { label: 'Άλλο', url: '' },
]

const open = ref(false)
const busy = ref(false)
const error = ref('')
const form = reactive({ name: '', url: '', key: '' })

// Το preset γεμίζει και το όνομα: ο πελάτης που διάλεξε «YouTube» δεν έχει λόγο
// να το ξαναγράψει, αλλά μπορεί να το αλλάξει (δύο κανάλια YouTube θέλουν δύο
// ονόματα για να ξεχωρίζουν στα badge κατάστασης).
function pick(p: (typeof PRESETS)[number]) {
  form.url = p.url
  if (!form.name || PRESETS.some(x => x.label === form.name)) form.name = p.url ? p.label : ''
}

async function add() {
  busy.value = true
  error.value = ''
  try {
    await api(props.endpoint, { method: 'POST', body: JSON.stringify({ ...form }) })
    form.name = form.url = form.key = ''
    open.value = false
    emit('changed')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

// On/off χωρίς να χαθεί το κλειδί της πλατφόρμας. Δεν ισχύει άμεσα: οι
// προορισμοί διαβάζονται στην αρχή της εκπομπής, οπότε η αλλαγή πιάνει στην
// επόμενη — το λέμε ρητά, αλλιώς ο πελάτης πατάει το κουμπί και δεν καταλαβαίνει
// γιατί το YouTube συνεχίζει να παίρνει σήμα.
async function toggle(d: Destination) {
  try {
    await api(`${props.endpoint}/${d.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !d.enabled }),
    })
    emit('changed')
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function remove(d: Destination) {
  const ok = await ask({
    title: `Αφαίρεση του «${d.name}»;`,
    description: 'Το κλειδί της πλατφόρμας χάνεται — θα χρειαστεί να το ξαναφέρεις από εκεί.',
  })
  if (!ok) return
  try {
    await api(`${props.endpoint}/${d.id}`, { method: 'DELETE' })
    emit('changed')
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Η κατάσταση έχει νόημα μόνο εν ώρα εκπομπής. «retrying» δεν σημαίνει
// απαραίτητα βλάβη: το YouTube κλείνει τη σύνδεση όσο ο πελάτης δεν έχει πατήσει
// «Go live» στο δικό του πάνελ, και ο stream server ξαναδοκιμάζει μόνος του.
const badge = (d: Destination) => {
  if (!d.enabled) return { color: 'neutral' as const, icon: 'i-lucide-circle-pause', text: 'ανενεργό' }
  if (!props.live) return null
  if (d.state === 'live') return { color: 'success' as const, icon: 'i-lucide-radio', text: 'στέλνει' }
  if (d.state) return { color: 'warning' as const, icon: 'i-lucide-refresh-cw', text: 'επανασύνδεση' }
  return null
}
</script>

<template>
  <div class="dests">
    <div class="dest-head">
      <UIcon name="i-lucide-share-2" class="text-dimmed size-4" />
      <h3>Αναδιανομή</h3>
      <span class="grow" />
      <!-- Κλειδωμένο κουμπί αντί για κρυμμένο όταν γέμισε το όριο: έτσι φαίνεται
           ότι υπάρχει όριο και ποιο είναι. Με max 0 δεν υπάρχει καν κουμπί — το
           πλάνο δεν πουλάει αναδιανομή και δεν έχει νόημα να τη διαφημίζουμε. -->
      <UButton
        v-if="max"
        size="xs" color="neutral" variant="subtle"
        :icon="open ? 'i-lucide-x' : 'i-lucide-plus'"
        :disabled="!open && destinations.length >= max"
        :title="destinations.length >= max ? `Το πλάνο επιτρέπει ${max} προορισμούς` : 'Νέος προορισμός'"
        @click="open = !open"
      >
        {{ open ? 'Άκυρο' : `Προσθήκη (${destinations.length}/${max})` }}
      </UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <div v-for="d in destinations" :key="d.id" class="dest">
      <strong>{{ d.name }}</strong>
      <UBadge v-if="badge(d)" :color="badge(d)!.color" variant="subtle" :icon="badge(d)!.icon">
        {{ badge(d)!.text }}
      </UBadge>
      <code>{{ d.url }}</code>
      <!-- Το κλειδί της πλατφόρμας είναι μυστικό όσο και το δικό μας: ίδιο
           component, κρυμμένο by default. -->
      <SecretKey :text="d.key" />
      <UButton
        :icon="d.enabled ? 'i-lucide-pause' : 'i-lucide-play'"
        size="xs" color="neutral" variant="ghost"
        :aria-label="d.enabled ? 'Απενεργοποίηση' : 'Ενεργοποίηση'"
        :title="d.enabled ? 'Απενεργοποίηση — ισχύει από την επόμενη εκπομπή' : 'Ενεργοποίηση — ισχύει από την επόμενη εκπομπή'"
        @click="toggle(d)"
      />
      <UButton
        icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
        aria-label="Αφαίρεση προορισμού" title="Αφαίρεση προορισμού" @click="remove(d)"
      />
    </div>

    <form v-if="open" class="dest-form" @submit.prevent="add">
      <div class="presets">
        <UButton
          v-for="p in PRESETS" :key="p.label"
          size="xs" :color="form.url === p.url ? 'primary' : 'neutral'"
          :variant="form.url === p.url ? 'subtle' : 'ghost'"
          @click="pick(p)"
        >{{ p.label }}</UButton>
      </div>
      <UInput v-model="form.name" size="sm" placeholder="Όνομα (π.χ. YouTube)" :maxlength="40" required />
      <UInput v-model="form.url" size="sm" placeholder="rtmp://… (Stream URL της πλατφόρμας)" required />
      <UInput v-model="form.key" size="sm" placeholder="Stream key της πλατφόρμας" required />
      <UButton type="submit" size="sm" color="primary" :loading="busy" icon="i-lucide-check">
        Προσθήκη
      </UButton>
    </form>

    <!-- Η χρήσιμη μισή πληροφορία: όλα τα υπόλοιπα τα ξέρει ο πελάτης από την
         πλατφόρμα του, αυτό όχι — και είναι ο νούμερο ένα λόγος που «δεν παίζει
         στο YouTube» ενώ σε εμάς παίζει μια χαρά. -->
    <p v-if="open" class="hint">
      Η εκπομπή προωθείται όπως έρχεται, χωρίς επανακωδικοποίηση: το πρόγραμμα εκπομπής
      πρέπει να τηρεί τα όρια της πλατφόρμας (keyframe interval 2s, ήχος AAC, και το όριο
      bitrate της — το Twitch κόβει πάνω από ~6 Mbps).
    </p>
  </div>
</template>

<style scoped>
.dests { display: flex; flex-direction: column; gap: 8px; }
.dest-head { display: flex; align-items: center; gap: 8px; }
.dest-head h3 { margin: 0; font-size: 12px; color: var(--muted); font-weight: 500; }
.dest { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dest strong { font-size: 13px; }
.dest code {
  flex: 1; min-width: 120px; overflow-x: auto; white-space: nowrap;
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 4px 8px; font-size: 12px;
}
.dest-form { display: flex; flex-direction: column; gap: 8px; }
.presets { display: flex; gap: 4px; flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--muted); margin: 0; }
</style>
