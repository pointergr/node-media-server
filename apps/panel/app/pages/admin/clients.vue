<script setup lang="ts">
// CRUD πελατών: server, πακέτα (= τα όριά του), paths (= κλειδιά εκπομπής) και
// disable/enable. Συμβόλαιο των endpoints: apps/api/README.md.
interface PathRow { id: number, path: string, key: string }
interface ServerOption { id: number, host: string }
interface PackageRow { id: number, name: string, maxViewers: number, maxStreams: number }
interface ClientRow {
  id: number
  name: string
  disabled: boolean
  serverId: number
  server: ServerOption
  paths: PathRow[]
  packages: { packageId: number, qty: number }[]
  // Ένας στην πράξη (το API αλλάζει τον παλαιότερο) — λίστα γιατί το σχήμα
  // επιτρέπει πολλούς. Χωρίς hash κωδικού, δεν το στέλνει το API.
  users: { id: number, username: string }[]
}

const api = useApi()
const ask = useConfirm()
const clients = ref<ClientRow[]>([])
const servers = ref<ServerOption[]>([])
const catalog = ref<PackageRow[]>([])
const error = ref('')
const busy = ref(false)

// Έτοιμο για το USelect: {label, value} — το v-model κρατάει το id του server.
const serverItems = computed(() => servers.value.map(s => ({ label: s.host, value: s.id })))

const form = reactive<{ name: string, serverId: number | undefined, username: string, password: string }>({
  name: '', serverId: undefined, username: '', password: '',
})
// Ποσότητες ανά πελάτη (clientId -> packageId -> qty) και μία ξεχωριστή για τη
// φόρμα δημιουργίας. 0 = δεν το έχει.
const qty = reactive<Record<number, Record<number, number>>>({})
const newQty = reactive<Record<number, number>>({})
// Ένα πεδίο "νέο path" ανά πελάτη, όχι ξεχωριστό ref το καθένα — key = client.id.
const newPath = reactive<Record<number, string>>({})
// Στοιχεία σύνδεσης ανά πελάτη. Ξεχωριστά από το `c` και όχι v-model πάνω στο
// c.users[0]: ο πελάτης μπορεί να μην έχει χρήστη ακόμα, άρα ούτε αντικείμενο να
// δεθεί. Το πεδίο κωδικού είναι πάντα κενό — δεν έχουμε τι να δείξουμε.
const cred = reactive<Record<number, { username: string, password: string }>>({})

// Τα όρια είναι άθροισμα επί ποσότητα — ο ίδιος κανόνας με το API
// (clients.service.ts#maxViewersOf). Εδώ μόνο για να βλέπει ο διαχειριστής τι
// αγοράζει· η επιβολή γίνεται εκεί.
function totals(get: (packageId: number) => number) {
  return catalog.value.reduce(
    (t, p) => {
      const n = get(p.id) || 0
      return { viewers: t.viewers + n * p.maxViewers, streams: t.streams + n * p.maxStreams }
    },
    { viewers: 0, streams: 0 },
  )
}
const totalsOf = (c: ClientRow) => totals(id => qty[c.id]?.[id] ?? 0)
const newTotals = computed(() => totals(id => newQty[id] ?? 0))

const packagesBody = (get: (packageId: number) => number) =>
  catalog.value.map(p => ({ packageId: p.id, qty: get(p.id) || 0 })).filter(r => r.qty > 0)

async function load() {
  try {
    [clients.value, servers.value, catalog.value] = await Promise.all([
      api<ClientRow[]>('/clients'),
      api<ServerOption[]>('/servers'),
      api<PackageRow[]>('/packages'),
    ])
    // Οι ποσότητες ξαναχτίζονται σε κάθε φόρτωση: αλλιώς μια αποτυχημένη
    // αποθήκευση θα άφηνε στην οθόνη νούμερα που δεν ισχύουν.
    for (const c of clients.value) {
      qty[c.id] = Object.fromEntries(
        catalog.value.map(p => [p.id, c.packages.find(x => x.packageId === p.id)?.qty ?? 0]),
      )
      cred[c.id] = { username: c.users[0]?.username ?? '', password: '' }
    }
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createClient() {
  if (!form.name || !form.serverId) return
  busy.value = true
  try {
    const body: Record<string, unknown> = {
      name: form.name,
      serverId: form.serverId,
      packages: packagesBody(id => newQty[id]!),
    }
    // Και τα δύο μαζί ή τίποτα — μισή φόρμα σημαίνει πελάτη χωρίς τρόπο σύνδεσης.
    if (form.username && form.password) Object.assign(body, { username: form.username, password: form.password })
    await api('/clients', { method: 'POST', body: JSON.stringify(body) })
    Object.assign(form, { name: '', serverId: undefined, username: '', password: '' })
    for (const p of catalog.value) newQty[p.id] = 0
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

// Πάντα ξαναφορτώνει μετά, επιτυχία ή όχι — σε αποτυχία ξαναφέρνει τις σωστές
// τιμές πάνω από ό,τι πληκτρολόγησε ο χρήστης στα inputs.
async function saveClient(c: ClientRow) {
  try {
    const body: Record<string, unknown> = {
      name: c.name,
      serverId: c.serverId,
      // Η λίστα είναι η τελική: ό,τι λείπει, αφαιρείται από τον πελάτη.
      packages: packagesBody(id => qty[c.id]?.[id] ?? 0),
    }
    // Κενό πεδίο = αμετάβλητο, γι' αυτό μπαίνουν στο σώμα μόνο όταν έχουν τιμή:
    // ένα `password: ''` θα άλλαζε τον κωδικό σε κενό με την πρώτη «Αποθήκευση»
    // που ο διαχειριστής έκανε για τα πακέτα.
    const { username, password } = cred[c.id] ?? { username: '', password: '' }
    if (username) body.username = username
    if (password) body.password = password
    await api(`/clients/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function toggleDisabled(c: ClientRow) {
  try {
    await api(`/clients/${c.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !c.disabled }) })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function removeClient(c: ClientRow) {
  const ok = await ask({
    title: `Διαγραφή πελάτη «${c.name}»;`,
    description: 'Χάνονται και τα paths και τα κλειδιά εκπομπής του.',
  })
  if (!ok) return
  try {
    // Τα paths φεύγουν μαζί (cascade στο schema.prisma) — ένα request.
    await api(`/clients/${c.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function addPath(c: ClientRow) {
  const path = newPath[c.id]?.trim()
  if (!path) return
  try {
    await api(`/clients/${c.id}/paths`, { method: 'POST', body: JSON.stringify({ path }) })
    newPath[c.id] = ''
    await load()
  }
  catch (e) {
    // Εδώ πέφτει και το μήνυμα για λάθος μορφή path (δες clients.controller.ts) — δείξ' το ως έχει.
    error.value = (e as Error).message
  }
}

async function removePath(c: ClientRow, p: PathRow) {
  const ok = await ask({
    title: `Διαγραφή του path ${p.path};`,
    description: 'Το OBS που εκπέμπει με αυτό το κλειδί θα κοπεί.',
  })
  if (!ok) return
  try {
    await api(`/clients/${c.id}/paths/${p.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Ό,τι δίνεις στον πελάτη για το OBS: το όνομα του stream (τελευταίο κομμάτι
// του path) + το κλειδί — ίδια μορφή με το streamKey του GET /me/streams.
const streamKey = (p: PathRow) => `${p.path.split('/').pop()}?key=${p.key}`

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-users" class="text-primary size-5" />
      <h1>Πελάτες</h1>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard>
      <template #header>
        <h2 class="mb-0">Νέος πελάτης</h2>
      </template>

      <form class="space-y-4" @submit.prevent="createClient">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Όνομα">
            <UInput v-model="form.name" required class="w-full" />
          </UFormField>
          <UFormField label="Server">
            <USelect v-model="form.serverId" :items="serverItems" placeholder="— επιλογή —" class="w-full" />
          </UFormField>
        </div>

        <PackagePicker v-model="newQty" :catalog="catalog" :totals="newTotals" />

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Όνομα χρήστη (προαιρετικό)">
            <UInput v-model="form.username" autocomplete="off" class="w-full" />
          </UFormField>
          <UFormField label="Κωδικός (προαιρετικό)">
            <UInput v-model="form.password" type="password" autocomplete="new-password" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Αν συμπληρώσεις και τα δύο, φτιάχνεται μαζί με τον πελάτη ο χρήστης με τον οποίο θα
          συνδέεται ο ίδιος στο δικό του panel. Χωρίς αυτά ο πελάτης δεν έχει σύνδεση — μόνο ο
          διαχειριστής βλέπει/αλλάζει τα paths του.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία πελάτη</UButton>
      </form>
    </UCard>

    <UCard v-for="c in clients" :key="c.id">
      <template #header>
        <div class="flex items-center gap-3 flex-wrap">
          <UBadge
            :color="c.disabled ? 'neutral' : 'success'" variant="subtle"
            :icon="c.disabled ? 'i-lucide-ban' : 'i-lucide-circle-check'"
          >
            {{ c.disabled ? 'ΑΝΕΝΕΡΓΟΣ' : 'ΕΝΕΡΓΟΣ' }}
          </UBadge>
          <span class="font-semibold">{{ c.name }}</span>
          <span class="host">{{ c.server.host }}</span>
          <span class="grow" />
          <UButton icon="i-lucide-save" color="neutral" variant="subtle" @click="saveClient(c)">Αποθήκευση</UButton>
          <UButton
            :icon="c.disabled ? 'i-lucide-power' : 'i-lucide-ban'"
            :color="c.disabled ? 'success' : 'warning'" variant="subtle"
            @click="toggleDisabled(c)"
          >
            {{ c.disabled ? 'Ενεργοποίηση' : 'Απενεργοποίηση' }}
          </UButton>
          <UButton icon="i-lucide-trash-2" color="error" variant="ghost" @click="removeClient(c)">Διαγραφή</UButton>
        </div>
      </template>

      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Όνομα">
            <UInput v-model="c.name" class="w-full" />
          </UFormField>
          <UFormField label="Server">
            <USelect v-model="c.serverId" :items="serverItems" class="w-full" />
          </UFormField>
        </div>

        <PackagePicker v-if="qty[c.id]" v-model="qty[c.id]!" :catalog="catalog" :totals="totalsOf(c)" />

        <div v-if="cred[c.id]" class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Όνομα χρήστη">
            <UInput v-model="cred[c.id]!.username" autocomplete="off" class="w-full" />
          </UFormField>
          <UFormField label="Νέος κωδικός">
            <UInput
              v-model="cred[c.id]!.password" type="password" autocomplete="new-password"
              placeholder="κενό = αμετάβλητος" class="w-full"
            />
          </UFormField>
        </div>

        <p class="note">
          Το disable/enable κόβει ή ξαναφέρνει τις εκπομπές του πελάτη μέσα σε ≤10s — όσο κάνει ο
          server να ξανασυγχρονίσει τη λίστα των πελατών του. Οι αλλαγές στα πακέτα και στα
          στοιχεία σύνδεσης θέλουν «Αποθήκευση».
          <template v-if="!c.users.length">
            Ο πελάτης δεν έχει χρήστη ακόμα — συμπλήρωσε <em>και</em> όνομα <em>και</em> κωδικό.
          </template>
        </p>

        <div class="scroll">
          <table v-if="c.paths.length">
            <thead>
              <tr>
                <!-- Πόσα paths επιτρέπουν τα πακέτα του: το 409 του API έρχεται
                     αλλιώς σαν έκπληξη τη στιγμή της προσθήκης. -->
                <th>Path{{ totalsOf(c).streams ? ` (${c.paths.length} / ${totalsOf(c).streams})` : '' }}</th>
                <th>Stream Key (OBS)</th><th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in c.paths" :key="p.id">
                <td>{{ p.path }}</td>
                <td>
                  <div class="flex items-center gap-2">
                    <code>{{ streamKey(p) }}</code>
                    <CopyButton :text="streamKey(p)" label="" />
                  </div>
                </td>
                <td>
                  <UButton
                    icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                    aria-label="Διαγραφή path" @click="removePath(c, p)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">Κανένα path ακόμα</div>
        </div>

        <form class="flex gap-2 flex-wrap" @submit.prevent="addPath(c)">
          <UInput v-model="newPath[c.id]" placeholder="/live/kamera1" required class="grow min-w-45" />
          <UButton type="submit" icon="i-lucide-plus" color="neutral" variant="subtle">Προσθήκη path</UButton>
        </form>
      </div>
    </UCard>

    <UCard v-if="!clients.length">
      <div class="quiet">Κανένας πελάτης ακόμα</div>
    </UCard>
  </div>
</template>

<style scoped>
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
</style>
