<script setup lang="ts">
// Ένα πλάνο του καταλόγου: όρια και ο server όπου πέφτουν οι *επόμενες*
// συνδρομές. Ο πελάτης αγοράζει όσα θέλει· κάθε συνδρομή κρατάει τα δικά της
// όρια, δεν αθροίζονται (δες admin/clients/[id].vue).
interface Row {
  id: number
  name: string
  maxViewers: number
  maxStreams: number
  // csv από ύψη, φθίνουσα — δες LADDER παρακάτω. null = καθόλου transcoding.
  ladder: string | null
  // Προορισμοί αναδιανομής ανά stream. Εδώ το 0 σημαίνει «δεν πουλάει
  // αναδιανομή» και όχι «χωρίς όριο», αντίθετα από τα δύο παραπάνω.
  maxRelays: number
  serverId: number
  server: { host: string }
  _count: { subscriptions: number }
}

// Ο stream server έχει σταθερό bitrate ανά ύψος, οπότε τα ύψη είναι κλειστός
// κατάλογος και όχι ελεύθερο κείμενο.
const LADDER = [1080, 720, 480, 360, 240]
const ladderItems = LADDER.map(h => ({ label: `${h}p`, value: h }))
// Το UI δουλεύει με πίνακα, το API με csv. Φθίνουσα σειρά στην έξοδο: το
// var_stream_map βγαίνει με τη σειρά που το δίνεις, και το API απορρίπτει
// ό,τι δεν είναι φθίνον — ο admin δεν χρειάζεται να το ξέρει αυτό.
const toCsv = (heights: number[]) => [...heights].sort((a, b) => b - a).join(',')
const toList = (csv: string | null) => (csv ? csv.split(',').map(Number) : [])

const id = Number(useRoute().params.id)
const api = useApi()
const ask = useConfirm()
const toast = useToast()

const p = ref<Row | null>(null)
// heights: μόνο για το UI, δεν ταξιδεύει ποτέ προς το API — το `ladder` του
// server είναι csv, το USelectMenu θέλει πίνακα.
const heights = ref<number[]>([])
const servers = ref<{ id: number, host: string }[]>([])
const error = ref('')

const serverItems = computed(() => servers.value.map(s => ({ label: s.host, value: s.id })))

// Δεν υπάρχει GET /plans/:id — ο κατάλογος είναι λίγες γραμμές και έρχεται
// ούτως ή άλλως ολόκληρος για το select του server· ένα endpoint παραπάνω δεν
// θα γλίτωνε ούτε μια κλήση.
async function load() {
  try {
    const [list, srv] = await Promise.all([
      api<Row[]>('/plans'),
      api<{ id: number, host: string }[]>('/servers'),
    ])
    p.value = list.find(r => r.id === id) ?? null
    heights.value = toList(p.value?.ladder ?? null)
    servers.value = srv
    error.value = p.value ? '' : 'Το πλάνο δεν βρέθηκε'
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Πάντα ξαναφορτώνει μετά, επιτυχία ή όχι — σε αποτυχία ξαναφέρνει τις σωστές
// τιμές πάνω από ό,τι πληκτρολόγησε ο χρήστης.
async function save() {
  if (!p.value) return
  try {
    await api(`/plans/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: p.value.name, maxViewers: p.value.maxViewers, maxStreams: p.value.maxStreams,
        maxRelays: p.value.maxRelays, ladder: toCsv(heights.value), serverId: p.value.serverId,
      }),
    })
    toast.add({ title: 'Αποθηκεύτηκε', color: 'success', icon: 'i-lucide-circle-check' })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function remove() {
  if (!p.value) return
  const ok = await ask({
    title: `Διαγραφή πλάνου «${p.value.name}»;`,
    // Το API το απορρίπτει με 409 όσο το κρατάει έστω ένας πελάτης — εδώ το λέμε
    // πριν, για να μην πατηθεί άσκοπα.
    description: p.value._count.subscriptions
      ? `Το έχουν ${p.value._count.subscriptions} συνδρομές — αφαίρεσέ το πρώτα από αυτές.`
      : 'Δεν το έχει καμία συνδρομή.',
  })
  if (!ok) return
  try {
    await api(`/plans/${id}`, { method: 'DELETE' })
    await navigateTo('/admin/plans')
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3 flex-wrap">
      <UButton
        to="/admin/plans" icon="i-lucide-arrow-left" color="neutral" variant="ghost"
        aria-label="Πίσω στα πλάνα"
      />
      <UIcon name="i-lucide-package" class="text-primary size-5" />
      <h1>{{ p?.name ?? '…' }}</h1>
      <span class="grow" />
      <UButton v-if="p" icon="i-lucide-trash-2" color="error" variant="ghost" @click="remove">Διαγραφή</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard v-if="p">
      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-6">
          <UFormField label="Όνομα">
            <UInput v-model="p.name" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστοι θεατές">
            <UInputNumber v-model="p.maxViewers" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστα streams">
            <UInputNumber v-model="p.maxStreams" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Αναδιανομή" help="0 = καθόλου">
            <UInputNumber v-model="p.maxRelays" :min="0" class="w-full" />
          </UFormField>
          <UFormField label="Αναλύσεις" help="ισχύει από την επόμενη εκπομπή">
            <USelectMenu v-model="heights" multiple value-key="value" :items="ladderItems" placeholder="— καμία —" class="w-full" />
          </UFormField>
          <UFormField label="Server" help="μόνο για τις επόμενες αγορές">
            <USelect v-model="p.serverId" :items="serverItems" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Οι <b>{{ p._count.subscriptions }}</b> συνδρομές που υπάρχουν ήδη μένουν στον server
          τους — η αλλαγή <em>server</em> αφορά μόνο τις επόμενες. Έτσι γεμίζει ένα μηχάνημα και
          το πλάνο συνεχίζει στο επόμενο, χωρίς να μετακομίσει κανένας πελάτης. Τα <em>όρια</em>
          όμως τα ακολουθούν όλες, και οι παλιές.
        </p>

        <p class="note">
          Οι <b>αναλύσεις</b> είναι τα σκαλοπάτια <em>κάτω</em> από την εκπομπή: η αρχική
          ποιότητα προσφέρεται πάντα, αυτούσια και δωρεάν. Κάθε σκαλοπάτι όμως είναι
          πραγματική μετατροπή στον server — ένα «720+480» κοστίζει περίπου 1,5 πυρήνα ανά
          εκπομπή, οπότε βάλ' το σε πλάνα που πουλιούνται αναλόγως και σε server που το
          αντέχει.
        </p>

        <p class="note">
          Η <b>αναδιανομή</b> είναι πόσους εξωτερικούς προορισμούς (YouTube, Facebook, Twitch…)
          δέχεται <em>κάθε stream</em> του πλάνου. Δεν κοστίζει CPU — η εκπομπή προωθείται
          αυτούσια — αλλά κάθε προορισμός είναι ένα ακόμα αντίγραφό της στο upstream του
          μηχανήματος: τρεις προορισμοί σε εκπομπή 6 Mbps είναι 18 Mbps έξω, πάνω από τους
          θεατές. Εδώ το <b>0 σημαίνει «καθόλου»</b>, όχι «απεριόριστοι».
        </p>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <span class="note">Συνδρομές σε αυτό το πλάνο: {{ p._count.subscriptions }}</span>
          <UButton icon="i-lucide-save" color="neutral" variant="subtle" @click="save">Αποθήκευση</UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
