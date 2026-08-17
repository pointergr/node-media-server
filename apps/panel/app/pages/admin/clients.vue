<script setup lang="ts">
// CRUD πελατών: πακέτα (= τα όριά του ΚΑΙ ο server του), paths (= κλειδιά
// εκπομπής) και disable/enable. Συμβόλαιο των endpoints: apps/api/README.md.
// Ο πελάτης δεν έχει server: τον δίνει η κάθε αγορά ξεχωριστά — δες
// utils/packages.ts και apps/api/prisma/schema.prisma.
interface PathRow { id: number, path: string, key: string, serverId: number, server: ServerOption }
interface ServerOption { id: number, host: string }
interface ClientRow {
  id: number
  name: string
  disabled: boolean
  paths: PathRow[]
  packages: PackageLine[]
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

const form = reactive<{ name: string, username: string, password: string }>({
  name: '', username: '', password: '',
})
// Γραμμές αγορών ανά πελάτη (clientId -> [{packageId, serverId, qty}]) και μία
// ξεχωριστή για τη φόρμα δημιουργίας. 0 = δεν το έχει.
const lines = reactive<Record<number, PackageLine[]>>({})
const newLines = ref<PackageLine[]>([])
// Ένα πεδίο "νέο path" ανά πελάτη, όχι ξεχωριστό ref το καθένα — key = client.id.
const newPath = reactive<Record<number, string>>({})
const newPathServer = reactive<Record<number, number | undefined>>({})
// Στοιχεία σύνδεσης ανά πελάτη. Ξεχωριστά από το `c` και όχι v-model πάνω στο
// c.users[0]: ο πελάτης μπορεί να μην έχει χρήστη ακόμα, άρα ούτε αντικείμενο να
// δεθεί. Το πεδίο κωδικού είναι πάντα κενό — δεν έχουμε τι να δείξουμε.
const cred = reactive<Record<number, { username: string, password: string }>>({})

// Τα όρια ανά server (utils/packages.ts) — ο ίδιος κανόνας με το API.
const totalsOf = (c: ClientRow) => totalsByServer(lines[c.id] ?? [], catalog.value)
// Ό,τι δείχνει η κεφαλίδα: τα μηχανήματα όπου ο πελάτης έχει αγορά ή path.
function hostsOf(c: ClientRow) {
  const ids = new Set([...c.packages.map(p => p.serverId), ...c.paths.map(p => p.serverId)])
  return servers.value.filter(s => ids.has(s.id)).map(s => s.host)
}

// Οι servers όπου «είναι» ο πελάτης: αυτοί των αγορών του. Χωρίς αγορά δεν
// ανήκει πουθενά, οπότε ο διαχειριστής μπορεί να τον βάλει όπου θέλει — ίδιος
// κανόνας με το API (clients.service.ts#addPath).
function serverOptions(c: ClientRow) {
  const mine = new Set(c.packages.map(p => p.serverId))
  const items = mine.size ? servers.value.filter(s => mine.has(s.id)) : servers.value
  return items.map(s => ({ label: s.host, value: s.id }))
}

// Ό,τι έχει ποσότητα, με τον server του: οι παλιές γραμμές κρατούν τον δικό τους
// (γι' αυτό ταξιδεύει το serverId), οι νέες φέρνουν τον σημερινό του πακέτου.
const packagesBody = (rows: PackageLine[]) => rows.filter(r => r.qty > 0)

async function load() {
  try {
    [clients.value, servers.value, catalog.value] = await Promise.all([
      api<ClientRow[]>('/clients'),
      api<ServerOption[]>('/servers'),
      api<PackageRow[]>('/packages'),
    ])
    // Οι γραμμές ξαναχτίζονται σε κάθε φόρτωση: αλλιώς μια αποτυχημένη
    // αποθήκευση θα άφηνε στην οθόνη νούμερα που δεν ισχύουν.
    for (const c of clients.value) {
      lines[c.id] = packageLines(c.packages, catalog.value)
      cred[c.id] = { username: c.users[0]?.username ?? '', password: '' }
    }
    newLines.value = packageLines([], catalog.value)
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createClient() {
  if (!form.name) return
  busy.value = true
  try {
    const body: Record<string, unknown> = {
      name: form.name,
      packages: packagesBody(newLines.value),
    }
    // Και τα δύο μαζί ή τίποτα — μισή φόρμα σημαίνει πελάτη χωρίς τρόπο σύνδεσης.
    if (form.username && form.password) Object.assign(body, { username: form.username, password: form.password })
    await api('/clients', { method: 'POST', body: JSON.stringify(body) })
    Object.assign(form, { name: '', username: '', password: '' })
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
      // Η λίστα είναι η τελική: ό,τι λείπει, αφαιρείται από τον πελάτη.
      packages: packagesBody(lines[c.id] ?? []),
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
  const serverId = newPathServer[c.id]
  if (!path || !serverId) return
  try {
    await api(`/clients/${c.id}/paths`, { method: 'POST', body: JSON.stringify({ path, serverId }) })
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
        <UFormField label="Όνομα">
          <UInput v-model="form.name" required class="w-full sm:w-1/2" />
        </UFormField>

        <PackagePicker v-model="newLines" :catalog="catalog" :servers="servers" />

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
          <!-- Οι servers του πελάτη είναι παράγωγο των αγορών του — μπορεί να
               είναι και δύο, μπορεί και κανένας. -->
          <span v-for="host in hostsOf(c)" :key="host" class="host">{{ host }}</span>
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
        <UFormField label="Όνομα">
          <UInput v-model="c.name" class="w-full sm:w-1/2" />
        </UFormField>

        <PackagePicker v-if="lines[c.id]" v-model="lines[c.id]!" :catalog="catalog" :servers="servers" />

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
                <th>Path</th><th>Server</th><th>Stream Key (OBS)</th><th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in c.paths" :key="p.id">
                <td>{{ p.path }}</td>
                <td class="host">{{ p.server.host }}</td>
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

        <!-- Πόσα paths επιτρέπουν τα πακέτα του σε κάθε μηχάνημα: το 409 του API
             έρχεται αλλιώς σαν έκπληξη τη στιγμή της προσθήκης. -->
        <p v-if="Object.keys(totalsOf(c)).length" class="note">
          Streams:
          <template v-for="([serverId, t], i) in Object.entries(totalsOf(c))" :key="serverId">
            <template v-if="i"> · </template>
            <b>{{ servers.find(s => s.id === Number(serverId))?.host }}</b>
            {{ c.paths.filter(p => p.serverId === Number(serverId)).length }} / {{ t.streams }}
          </template>
        </p>

        <form class="flex gap-2 flex-wrap" @submit.prevent="addPath(c)">
          <UInput v-model="newPath[c.id]" placeholder="/live/kamera1" required class="grow min-w-45" />
          <!-- Το path ζει σε ένα μηχάνημα, και ο πελάτης μπορεί να έχει δύο:
               επιλογή μόνο ανάμεσα σε αυτά που του έδωσαν οι αγορές του. -->
          <USelect v-model="newPathServer[c.id]" :items="serverOptions(c)" placeholder="— server —" class="min-w-40" />
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
