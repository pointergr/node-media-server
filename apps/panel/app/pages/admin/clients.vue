<script setup lang="ts">
// CRUD πελατών: συνδρομές (= τα αγορασμένα πλάνα, το καθένα με δικό του server
// και δικά του όρια), streams (= paths + κλειδιά εκπομπής) και disable/enable.
// Συμβόλαιο των endpoints: apps/api/README.md.
//
// Ο πελάτης δεν έχει ούτε server ούτε όρια — τα έχει η κάθε συνδρομή του, και
// τίποτα δεν αθροίζεται μεταξύ τους (δες apps/api/prisma/schema.prisma).
interface ServerOption { id: number, host: string }
interface PlanRow { id: number, name: string, maxViewers: number, maxStreams: number, maxRelays: number, serverId: number }
interface PathRow { id: number, path: string, key: string, destinations: Destination[] }
// Οι εξωτερικοί προορισμοί του stream. Χωρίς `state` εδώ: το /clients διαβάζει τη
// βάση, όχι το τελευταίο snapshot — η ζωντανή κατάσταση φαίνεται στο /admin και
// στο panel του πελάτη.
interface Destination { id: number, name: string, url: string, key: string, enabled: boolean, state: null }
interface SubscriptionRow {
  id: number
  // Αναστολή της συνδρομής, ξεχωριστά από το disabled του πελάτη: ένα πλάνο
  // μπορεί να έχει λήξει ενώ τα υπόλοιπα τρέχουν κανονικά.
  disabled: boolean
  // Φιλικό όνομα της αγοράς — δύο συνδρομές του ίδιου πλάνου είναι αλλιώς δύο
  // ίδιες γραμμές «basic». Το αλλάζει και ο πελάτης από το panel του. Έρχεται
  // `null` από το API και γίνεται `''` στη φόρτωση, δες load().
  label: string
  plan: PlanRow
  server: ServerOption
  paths: PathRow[]
}
interface ClientRow {
  id: number
  name: string
  disabled: boolean
  subscriptions: SubscriptionRow[]
  // Ένας στην πράξη (το API αλλάζει τον παλαιότερο) — λίστα γιατί το σχήμα
  // επιτρέπει πολλούς. Χωρίς hash κωδικού, δεν το στέλνει το API.
  users: { id: number, username: string }[]
}

const api = useApi()
const ask = useConfirm()
const clients = ref<ClientRow[]>([])
const catalog = ref<PlanRow[]>([])
const error = ref('')
const busy = ref(false)

const form = reactive<{ name: string, username: string, password: string }>({
  name: '', username: '', password: '',
})
// Ένα πεδίο ανά πελάτη, όχι ξεχωριστό ref το καθένα — key = client.id.
const newPath = reactive<Record<number, string>>({})
const newPathSub = reactive<Record<number, number | undefined>>({})
const newPlan = reactive<Record<number, number | undefined>>({})
// Στοιχεία σύνδεσης ανά πελάτη. Ξεχωριστά από το `c` και όχι v-model πάνω στο
// c.users[0]: ο πελάτης μπορεί να μην έχει χρήστη ακόμα, άρα ούτε αντικείμενο να
// δεθεί. Το πεδίο κωδικού είναι πάντα κενό — δεν έχουμε τι να δείξουμε.
const cred = reactive<Record<number, { username: string, password: string }>>({})

// Έτοιμα για το USelect: το πλάνο δείχνει και πού θα πέσει η νέα συνδρομή, γιατί
// αυτό είναι που δεν φαίνεται πουθενά αλλού τη στιγμή της αγοράς.
const planItems = computed(() => catalog.value.map(p => ({
  label: `${p.name} — ${hostOf(p.serverId)} (${p.maxViewers} θεατές, ${p.maxStreams} streams)`,
  value: p.id,
})))
// Οι συνδρομές με χώρο για ακόμα ένα stream· γεμάτη συνδρομή δεν προσφέρεται,
// αλλιώς η επιλογή οδηγεί σε σίγουρο 409.
const subItems = (c: ClientRow) => c.subscriptions.map(s => ({
  label: `${s.plan.name} — ${s.server.host} (${s.paths.length}/${s.plan.maxStreams})${s.disabled ? ' — σε αναστολή' : ''}`,
  value: s.id,
  disabled: s.paths.length >= s.plan.maxStreams,
}))

// Ψάχνει και στα paths: ο διαχειριστής ξέρει συχνά το stream, όχι τον πελάτη.
const q = ref('')
const shown = computed(() => {
  const t = q.value.trim().toLowerCase()
  if (!t) return clients.value
  return clients.value.filter(c => [
    c.name,
    ...c.users.map(u => u.username),
    ...c.subscriptions.flatMap(s => [s.label ?? '', s.plan.name, s.server.host, ...s.paths.map(p => p.path)]),
  ].some(v => v.toLowerCase().includes(t)))
})

const servers = ref<ServerOption[]>([])
const hostOf = (id: number) => servers.value.find(s => s.id === id)?.host ?? `server #${id}`
// Τα μηχανήματα όπου κάθεται ο πελάτης — παράγωγο των συνδρομών του.
const hostsOf = (c: ClientRow) => [...new Set(c.subscriptions.map(s => s.server.host))]

async function load() {
  try {
    [clients.value, servers.value, catalog.value] = await Promise.all([
      api<ClientRow[]>('/clients'),
      api<ServerOption[]>('/servers'),
      api<PlanRow[]>('/plans'),
    ])
    for (const c of clients.value) {
      cred[c.id] = { username: c.users[0]?.username ?? '', password: '' }
      // Το API στέλνει null για «χωρίς όνομα»· το UInput θέλει string. Στην
      // αντίθετη κατεύθυνση το κενό ξαναγίνεται null (cleanLabel του API).
      for (const s of c.subscriptions) s.label ??= ''
    }
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
    const body: Record<string, unknown> = { name: form.name }
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
// Το panel του πελάτη με τα μάτια του, χωρίς να αποσυνδεθεί ο admin — η
// επιστροφή είναι η μπάρα του layout (useApi#impersonate).
async function viewAs(c: ClientRow) {
  try {
    await impersonate(c.id)
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function saveClient(c: ClientRow) {
  try {
    const body: Record<string, unknown> = { name: c.name }
    // Κενό πεδίο = αμετάβλητο, γι' αυτό μπαίνουν στο σώμα μόνο όταν έχουν τιμή:
    // ένα `password: ''` θα άλλαζε τον κωδικό σε κενό με την πρώτη «Αποθήκευση»
    // που ο διαχειριστής έκανε για το όνομα.
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
    description: 'Χάνονται και τα πλάνα και τα streams με τα κλειδιά εκπομπής τους.',
  })
  if (!ok) return
  try {
    // Όλα φεύγουν μαζί (cascade στο schema.prisma) — ένα request.
    await api(`/clients/${c.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Μία αγορά = μία γραμμή στον πίνακα. Ο server δεν επιλέγεται: τον δίνει το
// πλάνο τη στιγμή αυτή, και μένει καρφωμένος στη συνδρομή για πάντα.
async function addSubscription(c: ClientRow) {
  const planId = newPlan[c.id]
  if (!planId) return
  try {
    await api(`/clients/${c.id}/subscriptions`, { method: 'POST', body: JSON.stringify({ planId }) })
    newPlan[c.id] = undefined
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function toggleSubscription(c: ClientRow, s: SubscriptionRow) {
  try {
    await api(`/clients/${c.id}/subscriptions/${s.id}`, {
      method: 'PATCH', body: JSON.stringify({ disabled: !s.disabled }),
    })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

// Το ίδιο πεδίο που γράφει και ο πελάτης από το panel του: εδώ για τη στιγμή της
// πώλησης (ο admin ξέρει τι πούλησε) και για τους πελάτες που δεν θα μπουν ποτέ
// να το ονομάσουν μόνοι τους.
async function renameSubscription(c: ClientRow, s: SubscriptionRow) {
  try {
    await api(`/clients/${c.id}/subscriptions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ label: s.label }) })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function removeSubscription(c: ClientRow, s: SubscriptionRow) {
  const ok = await ask({
    title: `Αφαίρεση του πλάνου «${s.plan.name}» (${s.server.host});`,
    // Το API το απορρίπτει με 409 όσο κρατάει streams — εδώ το λέμε πριν.
    description: s.paths.length
      ? `Έχει ${s.paths.length} streams — σβήσε τα πρώτα.`
      : 'Δεν έχει streams.',
  })
  if (!ok) return
  try {
    await api(`/clients/${c.id}/subscriptions/${s.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function addPath(c: ClientRow) {
  const path = newPath[c.id]?.trim()
  const subscriptionId = newPathSub[c.id]
  if (!subscriptionId) {
    // Το γεμάτο πλάνο βγαίνει disabled στο select (δες subItems), οπότε δεν
    // υπάρχει τίποτα να διαλεχτεί και το κουμπί έμοιαζε χαλασμένο: σιωπηλό return.
    error.value = !c.subscriptions.length
      ? 'Ο πελάτης δεν έχει πλάνο ακόμα — πρόσθεσε πρώτα ένα.'
      : subItems(c).every(i => i.disabled)
        ? 'Όλα τα πλάνα του πελάτη είναι γεμάτα — πρόσθεσε πλάνο ή σβήσε ένα stream.'
        : 'Διάλεξε πλάνο για το νέο stream.'
    return
  }
  try {
    // Κενό path = το ονομάζει το API (δες clients.service.ts#nextPath).
    await api(`/clients/${c.id}/paths`, { method: 'POST', body: JSON.stringify({ path: path || undefined, subscriptionId }) })
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
    title: `Διαγραφή του stream ${p.path};`,
    description: 'Η εκπομπή που τρέχει με αυτό το κλειδί θα κοπεί.',
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

async function refreshKey(c: ClientRow, p: PathRow) {
  const ok = await ask({
    title: `Νέο κλειδί για το ${p.path};`,
    description: 'Το παλιό παύει να ισχύει — η εκπομπή που τρέχει με αυτό κόβεται σε ≤10s και θέλει το νέο.',
  })
  if (!ok) return
  try {
    await api(`/clients/${c.id}/paths/${p.id}/key`, { method: 'POST' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Ό,τι δίνεις στον πελάτη για το OBS: το όνομα του stream (τελευταίο κομμάτι
// του path) + το κλειδί — ίδια μορφή με το streamKey του GET /me/streams.
const streamKey = (p: PathRow) => `${p.path.split('/').pop()}?key=${p.key}`

// Ένα path ανοιχτό τη φορά: οι προορισμοί είναι μια δεύτερη σειρά κάτω από τη
// γραμμή του stream, και τρεις ανοιχτές μαζί κάνουν τον πίνακα αδιάβαστο.
const openDests = ref<number | null>(null)

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-users" class="text-primary size-5" />
      <h1>Πελάτες</h1>
      <span class="grow" />
      <UInput
        v-model="q" icon="i-lucide-search" placeholder="Πελάτης, χρήστης, stream…"
        class="w-full sm:w-72" @keydown.esc="q = ''"
      />
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

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Όνομα χρήστη (προαιρετικό)">
            <UInput v-model="form.username" autocomplete="off" class="w-full" />
          </UFormField>
          <UFormField label="Κωδικός (προαιρετικό)">
            <UInput v-model="form.password" type="password" autocomplete="new-password" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Ο πελάτης φτιάχνεται άδειος: τα πλάνα του τα αγοράζεις από την κάρτα του παρακάτω. Αν
          συμπληρώσεις και τα δύο πεδία σύνδεσης, φτιάχνεται μαζί ο χρήστης με τον οποίο θα
          μπαίνει ο ίδιος στο δικό του panel.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία πελάτη</UButton>
      </form>
    </UCard>

    <UCard v-for="c in shown" :key="c.id">
      <template #header>
        <div class="flex items-center gap-3 flex-wrap">
          <UBadge
            :color="c.disabled ? 'neutral' : 'success'" variant="subtle"
            :icon="c.disabled ? 'i-lucide-ban' : 'i-lucide-circle-check'"
          >
            {{ c.disabled ? 'ΑΝΕΝΕΡΓΟΣ' : 'ΕΝΕΡΓΟΣ' }}
          </UBadge>
          <span class="font-semibold">{{ c.name }}</span>
          <!-- Οι servers του πελάτη είναι παράγωγο των συνδρομών του — μπορεί να
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
          <!-- Απενεργοποιημένο χωρίς χρήστη σύνδεσης: το login-link χρειάζεται
               λογαριασμό, τα πεδία είναι λίγο πιο κάτω στην ίδια κάρτα. -->
          <UButton
            icon="i-lucide-eye" color="neutral" variant="subtle"
            :disabled="!c.users.length" @click="viewAs(c)"
          >
            Είσοδος ως πελάτης
          </UButton>
          <UButton icon="i-lucide-trash-2" color="error" variant="ghost" @click="removeClient(c)">Διαγραφή</UButton>
        </div>
      </template>

      <div class="space-y-4">
        <UFormField label="Όνομα">
          <UInput v-model="c.name" class="w-full sm:w-1/2" />
        </UFormField>

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
          Το disable/enable της κεφαλίδας κόβει <b>όλα</b> τα πλάνα του πελάτη· η αναστολή στη
          γραμμή ενός πλάνου κόβει μόνο εκείνο (π.χ. έληξε η μία συνδρομή). Και τα δύο πιάνουν σε
          ≤10s — όσο κάνει ο server να ξανασυγχρονίσει τη λίστα του — και δεν χάνουν paths ούτε
          κλειδιά. Οι αλλαγές στο όνομα και στα στοιχεία σύνδεσης
          θέλουν «Αποθήκευση»· τα πλάνα και τα streams αποθηκεύονται μόνα τους.
          <template v-if="!c.users.length">
            Ο πελάτης δεν έχει χρήστη ακόμα — συμπλήρωσε <em>και</em> όνομα <em>και</em> κωδικό.
          </template>
        </p>

        <!-- Τα αγορασμένα πλάνα, με τα όριά τους το καθένα: δεν αθροίζονται. -->
        <div class="text-xs text-dimmed">Πλάνα</div>
        <div class="scroll">
          <table v-if="c.subscriptions.length">
            <thead>
                  <tr>
                <th>Όνομα</th><th>Πλάνο</th><th>Server</th><th>Θεατές</th><th>Streams</th><th>Κατάσταση</th><th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in c.subscriptions" :key="s.id">
                <!-- Δύο συνδρομές του ίδιου πλάνου είναι αλλιώς δύο πανομοιότυπες
                     γραμμές. Αποθηκεύεται μόνο του, όπως τα υπόλοιπα του πίνακα. -->
                <td>
                  <UInput
                    v-model="s.label" size="xs" placeholder="— χωρίς όνομα —" :maxlength="60"
                    class="min-w-40" @change="renameSubscription(c, s)"
                  />
                </td>
                <td>{{ s.plan.name }}</td>
                <td class="host">{{ s.server.host }}</td>
                <td>{{ s.plan.maxViewers }}</td>
                <td>{{ s.paths.length }} / {{ s.plan.maxStreams }}</td>
                <td>
                  <UBadge :color="s.disabled ? 'warning' : 'success'" variant="subtle" size="sm">
                    {{ s.disabled ? 'ΣΕ ΑΝΑΣΤΟΛΗ' : 'ΕΝΕΡΓΟ' }}
                  </UBadge>
                </td>
                <td>
                  <div class="flex gap-1">
                    <UButton
                      :icon="s.disabled ? 'i-lucide-play' : 'i-lucide-pause'" size="xs" variant="ghost"
                      :color="s.disabled ? 'success' : 'warning'"
                      :aria-label="s.disabled ? 'Επαναφορά πλάνου' : 'Αναστολή πλάνου'"
                      @click="toggleSubscription(c, s)"
                    />
                    <UButton
                      icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                      aria-label="Αφαίρεση πλάνου" @click="removeSubscription(c, s)"
                    />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">Κανένα πλάνο ακόμα — χωρίς πλάνο δεν μπορεί να εκπέμψει</div>
        </div>

        <form class="flex gap-2 flex-wrap" @submit.prevent="addSubscription(c)">
          <USelect v-model="newPlan[c.id]" :items="planItems" placeholder="— πλάνο —" class="grow min-w-60" />
          <UButton type="submit" icon="i-lucide-plus" color="neutral" variant="subtle">Προσθήκη πλάνου</UButton>
        </form>

        <div class="text-xs text-dimmed">Streams</div>
        <div class="scroll">
          <table v-if="c.subscriptions.some(s => s.paths.length)">
            <thead>
                  <tr>
                <th>Path</th><th>Πλάνο</th><th>Stream Key</th><th>Αναδιανομή</th><th />
              </tr>
            </thead>
            <tbody>
              <template v-for="s in c.subscriptions" :key="s.id">
                <!-- Οι δύο γραμμές του stream —η ίδια και οι προορισμοί της— σε κοινό
                     `template v-for`, όχι δύο ξεχωριστά v-for: το `p` του δεύτερου `tr`
                     πρέπει να είναι το ίδιο path με του πρώτου. Με το v-for πάνω στο
                     `tr` το δεύτερο έμενε εκτός scope και το `p.id` έσκαγε σε render. -->
                <template v-for="p in s.paths" :key="p.id">
                  <tr>
                    <td>{{ p.path }}</td>
                    <td>{{ s.plan.name }} <span class="host">{{ s.server.host }}</span></td>
                    <td>
                      <div class="flex items-center gap-2">
                        <code>{{ streamKey(p) }}</code>
                        <CopyButton :text="streamKey(p)" label="" />
                      </div>
                    </td>
                    <!-- Ο admin τους βάζει «στο τηλέφωνο», όταν ο πελάτης δεν τα
                         καταφέρνει μόνος του από το δικό του panel. Πλάνο χωρίς
                         αναδιανομή δεν έχει τι να δείξει: το κουμπί θα οδηγούσε σε
                         φόρμα που απαντάει 409. -->
                    <td>
                      <UButton
                        v-if="s.plan.maxRelays"
                        size="xs" color="neutral" variant="ghost" icon="i-lucide-share-2"
                        :title="`${p.destinations.length} / ${s.plan.maxRelays} προορισμοί`"
                        @click="openDests = openDests === p.id ? null : p.id"
                      >
                        {{ p.destinations.length }} / {{ s.plan.maxRelays }}
                      </UButton>
                      <span v-else class="host">—</span>
                    </td>
                    <td>
                      <UButton
                        icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost"
                        aria-label="Νέο κλειδί" title="Νέο κλειδί" @click="refreshKey(c, p)"
                      />
                      <UButton
                        icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                        aria-label="Διαγραφή stream" @click="removePath(c, p)"
                      />
                    </td>
                  </tr>
                  <tr v-if="openDests === p.id">
                    <td colspan="5">
                      <!-- `live` false: εδώ δεν υπάρχει snapshot, μόνο η βάση — δες
                           το σχόλιο στο Destination. -->
                      <StreamDestinations
                        :endpoint="`/clients/${c.id}/paths/${p.id}/destinations`"
                        :destinations="p.destinations" :max="s.plan.maxRelays" :live="false"
                        @changed="load"
                      />
                    </td>
                  </tr>
                </template>
              </template>
            </tbody>
          </table>
          <div v-else class="empty">Κανένα stream ακόμα</div>
        </div>

        <form class="flex gap-2 flex-wrap" @submit.prevent="addPath(c)">
          <UInput v-model="newPath[c.id]" placeholder="/live/kamera1 — κενό για αυτόματο" class="grow min-w-45" />
          <!-- Το stream ανήκει σε πλάνο: από εκεί παίρνει server και όριο θεατών.
               Γεμάτο πλάνο εμφανίζεται απενεργοποιημένο αντί για σίγουρο 409. -->
          <USelect v-model="newPathSub[c.id]" :items="subItems(c)" placeholder="— πλάνο —" class="min-w-60" />
          <UButton type="submit" icon="i-lucide-plus" color="neutral" variant="subtle">Προσθήκη stream</UButton>
        </form>
      </div>
    </UCard>

    <UCard v-if="!shown.length">
      <div class="quiet">{{ clients.length ? 'Κανένας πελάτης δεν ταιριάζει στην αναζήτηση' : 'Κανένας πελάτης ακόμα' }}</div>
    </UCard>
  </div>
</template>

<style scoped>
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
</style>
