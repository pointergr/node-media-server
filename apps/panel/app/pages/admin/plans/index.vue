<script setup lang="ts">
// Ο κατάλογος με ό,τι πουλάμε. Τα όρια και ο server των επόμενων αγορών
// αλλάζουν στη σελίδα του κάθε πλάνου — εδώ μόνο ποια υπάρχουν.
interface Row {
  id: number
  name: string
  maxViewers: number
  maxStreams: number
  // csv από ύψη, φθίνουσα. null = καθόλου transcoding.
  ladder: string | null
  // Προορισμοί αναδιανομής ανά stream. Εδώ το 0 σημαίνει «δεν πουλάει
  // αναδιανομή» και όχι «χωρίς όριο», αντίθετα από τα δύο παραπάνω.
  maxRelays: number
  serverId: number
  server: { host: string }
  _count: { subscriptions: number }
}

const api = useApi()
const ask = useConfirm()
const plans = ref<Row[]>([])
const servers = ref<{ id: number, host: string }[]>([])
const error = ref('')
const busy = ref(false)
const creating = ref(false)

// Ο stream server έχει σταθερό bitrate ανά ύψος, οπότε τα ύψη είναι κλειστός
// κατάλογος και όχι ελεύθερο κείμενο: ένα «800» θα περνούσε το πληκτρολόγιο,
// θα κοβόταν στο API και ο admin θα μάθαινε γιατί μόνο από το μήνυμα λάθους.
const LADDER = [1080, 720, 480, 360, 240]
const ladderItems = LADDER.map(h => ({ label: `${h}p`, value: h }))
// Το UI δουλεύει με πίνακα, το API με csv. Φθίνουσα σειρά στην έξοδο: το
// var_stream_map βγαίνει με τη σειρά που το δίνεις, και το API απορρίπτει
// ό,τι δεν είναι φθίνον — ο admin δεν χρειάζεται να το ξέρει αυτό.
const toCsv = (heights: number[]) => [...heights].sort((a, b) => b - a).join(',')

const serverItems = computed(() => servers.value.map(s => ({ label: s.host, value: s.id })))
const form = reactive<{ name: string, maxViewers: number, maxStreams: number, maxRelays: number, ladder: number[], serverId: number | undefined }>({
  name: '', maxViewers: 50, maxStreams: 1, maxRelays: 0, ladder: [], serverId: undefined,
})

const { q, page, shown, paged, perPage } = usePaged(plans, p => `${p.name} ${p.server.host}`)

async function load() {
  try {
    [plans.value, servers.value] = await Promise.all([
      api<Row[]>('/plans'),
      api<{ id: number, host: string }[]>('/servers'),
    ])
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createPlan() {
  if (!form.name || !form.serverId) return
  busy.value = true
  try {
    await api('/plans', { method: 'POST', body: JSON.stringify({ ...form, ladder: toCsv(form.ladder) }) })
    Object.assign(form, { name: '', maxViewers: 50, maxStreams: 1, maxRelays: 0, ladder: [], serverId: undefined })
    creating.value = false
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

async function removePlan(p: Row) {
  const ok = await ask({
    title: `Διαγραφή πλάνου «${p.name}»;`,
    // Το API το απορρίπτει με 409 όσο το κρατάει έστω ένας πελάτης — εδώ το λέμε
    // πριν, για να μην πατηθεί άσκοπα.
    description: p._count.subscriptions
      ? `Το έχουν ${p._count.subscriptions} συνδρομές — αφαίρεσέ το πρώτα από αυτές.`
      : 'Δεν το έχει καμία συνδρομή.',
  })
  if (!ok) return
  try {
    await api(`/plans/${p.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2 flex-wrap">
      <UIcon name="i-lucide-package" class="text-primary size-5" />
      <h1>Πλάνα</h1>
      <UBadge color="neutral" variant="subtle">{{ plans.length }}</UBadge>
      <span class="grow" />
      <UInput
        v-model="q" icon="i-lucide-search" placeholder="Πλάνο, server…"
        class="w-full sm:w-64" @keydown.esc="q = ''"
      />
      <UButton icon="i-lucide-plus" @click="creating = !creating">Νέο πλάνο</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard v-if="creating">
      <template #header>
        <h2 class="mb-0">Νέο πλάνο</h2>
      </template>

      <form class="space-y-4" @submit.prevent="createPlan">
        <div class="grid gap-4 sm:grid-cols-6">
          <UFormField label="Όνομα">
            <UInput v-model="form.name" placeholder="basic" required class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστοι θεατές">
            <UInputNumber v-model="form.maxViewers" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστα streams">
            <UInputNumber v-model="form.maxStreams" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Αναδιανομή" help="προορισμοί ανά stream, 0 = καθόλου">
            <UInputNumber v-model="form.maxRelays" :min="0" class="w-full" />
          </UFormField>
          <UFormField label="Αναλύσεις" help="κενό = καμία μετατροπή">
            <USelectMenu v-model="form.ladder" multiple value-key="value" :items="ladderItems" placeholder="— καμία —" class="w-full" />
          </UFormField>
          <UFormField label="Server">
            <USelect v-model="form.serverId" :items="serverItems" placeholder="— επιλογή —" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Τα όρια είναι της <b>κάθε συνδρομής χωριστά</b> και δεν αθροίζονται: πελάτης με 2×
          «basic» των 50 θεατών έχει δύο πλάνα των 50, όχι ένα των 100. Τα «streams» είναι πόσα
          paths χωράει το πλάνο, όχι πόσα εκπέμπει ταυτόχρονα.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία πλάνου</UButton>
      </form>
    </UCard>

    <UCard>
      <div class="scroll">
        <table v-if="paged.length">
          <thead>
            <tr>
              <th>Πλάνο</th><th>Server</th><th class="num">Θεατές</th><th class="num">Streams</th>
              <th class="num">Αναδιανομή</th><th>Αναλύσεις</th><th class="num">Συνδρομές</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in paged" :key="p.id">
              <td><ULink :to="`/admin/plans/${p.id}`" class="font-semibold">{{ p.name }}</ULink></td>
              <td class="host">{{ p.server.host }}</td>
              <td class="num">{{ p.maxViewers }}</td>
              <td class="num">{{ p.maxStreams }}</td>
              <td class="num">{{ p.maxRelays || '—' }}</td>
              <td>
                <UBadge v-if="p.ladder" color="primary" variant="subtle" size="sm">{{ p.ladder }}</UBadge>
                <span v-else class="host">—</span>
              </td>
              <td class="num">{{ p._count.subscriptions }}</td>
              <td>
                <div class="flex gap-1 justify-end">
                  <UButton
                    icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost"
                    :to="`/admin/plans/${p.id}`" title="Επεξεργασία" aria-label="Επεξεργασία"
                  />
                  <UButton
                    icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                    title="Διαγραφή" aria-label="Διαγραφή" @click="removePlan(p)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">
          {{ plans.length ? 'Κανένα πλάνο δεν ταιριάζει στην αναζήτηση' : 'Κανένα πλάνο ακόμα' }}
        </div>
      </div>

      <div v-if="shown.length > perPage" class="flex justify-center mt-4">
        <UPagination v-model:page="page" :total="shown.length" :items-per-page="perPage" />
      </div>
    </UCard>
  </div>
</template>
