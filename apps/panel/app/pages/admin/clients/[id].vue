<script setup lang="ts">
// Ένας πελάτης: συνδρομές (= τα αγορασμένα πλάνα, το καθένα με δικό του server
// και δικά του όρια), streams (= paths + κλειδιά εκπομπής) και disable/enable.
// Ό,τι ήταν κάρτα μέσα στη λίστα, τώρα σε δική του σελίδα.
// Συμβόλαιο των endpoints: apps/api/README.md.
//
// Ο πελάτης δεν έχει ούτε server ούτε όρια — τα έχει η κάθε συνδρομή του, και
// τίποτα δεν αθροίζεται μεταξύ τους (δες apps/api/prisma/schema.prisma).
import { hlsUrl } from '~/utils/dash'

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

const route = useRoute()
const id = Number(route.params.id)
const api = useApi()
const ask = useConfirm()
const toast = useToast()

const c = ref<ClientRow | null>(null)
const catalog = ref<PlanRow[]>([])
const servers = ref<ServerOption[]>([])
const error = ref('')

const newPath = ref('')
const newPathSub = ref<number>()
const newPlan = ref<number>()
// Στοιχεία σύνδεσης. Ξεχωριστά από το `c` και όχι v-model πάνω στο c.users[0]:
// ο πελάτης μπορεί να μην έχει χρήστη ακόμα, άρα ούτε αντικείμενο να δεθεί. Το
// πεδίο κωδικού είναι πάντα κενό — δεν έχουμε τι να δείξουμε.
const cred = reactive({ username: '', password: '' })

const hostOf = (sid: number) => servers.value.find(s => s.id === sid)?.host ?? `server #${sid}`

// Έτοιμα για το USelect: το πλάνο δείχνει και πού θα πέσει η νέα συνδρομή, γιατί
// αυτό είναι που δεν φαίνεται πουθενά αλλού τη στιγμή της αγοράς.
const planItems = computed(() => catalog.value.map(p => ({
  label: `${p.name} — ${hostOf(p.serverId)} (${p.maxViewers} θεατές, ${p.maxStreams} streams)`,
  value: p.id,
})))
// Το πλάνο μιας ΥΠΑΡΧΟΥΣΑΣ συνδρομής: χωρίς τον server του πλάνου, που εδώ δεν
// ισχύει — ο server της συνδρομής πάγωσε στην αγορά και δεν ακολουθεί. Πλάνο που
// δεν χωράει τα streams της βγαίνει disabled, αλλιώς η επιλογή οδηγεί σε 409.
const planItemsFor = (s: SubscriptionRow) => catalog.value.map(p => ({
  label: `${p.name} (${p.maxViewers} θεατές, ${p.maxStreams} streams)`,
  value: p.id,
  disabled: s.paths.length > p.maxStreams,
}))

// Οι συνδρομές με χώρο για ακόμα ένα stream· γεμάτη συνδρομή δεν προσφέρεται,
// αλλιώς η επιλογή οδηγεί σε σίγουρο 409.
const subItems = computed(() => (c.value?.subscriptions ?? []).map(s => ({
  label: `${s.plan.name} — ${s.server.host} (${s.paths.length}/${s.plan.maxStreams})${s.disabled ? ' — σε αναστολή' : ''}`,
  value: s.id,
  disabled: s.paths.length >= s.plan.maxStreams,
})))

async function load() {
  try {
    const [row, srv, plans] = await Promise.all([
      api<ClientRow>(`/clients/${id}`),
      api<ServerOption[]>('/servers'),
      api<PlanRow[]>('/plans'),
    ])
    // Το API στέλνει null για «χωρίς όνομα»· το UInput θέλει string. Στην
    // αντίθετη κατεύθυνση το κενό ξαναγίνεται null (cleanLabel του API).
    for (const s of row.subscriptions) s.label ??= ''
    c.value = row
    servers.value = srv
    catalog.value = plans
    cred.username = row.users[0]?.username ?? ''
    cred.password = ''
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Πάντα ξαναφορτώνει μετά, επιτυχία ή όχι — σε αποτυχία ξαναφέρνει τις σωστές
// τιμές πάνω από ό,τι πληκτρολόγησε ο χρήστης στα inputs.
async function saveClient() {
  if (!c.value) return
  try {
    const body: Record<string, unknown> = { name: c.value.name }
    // Κενό πεδίο = αμετάβλητο, γι' αυτό μπαίνουν στο σώμα μόνο όταν έχουν τιμή:
    // ένα `password: ''` θα άλλαζε τον κωδικό σε κενό με την πρώτη «Αποθήκευση»
    // που ο διαχειριστής έκανε για το όνομα.
    if (cred.username) body.username = cred.username
    if (cred.password) body.password = cred.password
    await api(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
    toast.add({ title: 'Αποθηκεύτηκε', color: 'success', icon: 'i-lucide-circle-check' })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function toggleDisabled() {
  if (!c.value) return
  try {
    await api(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !c.value.disabled }) })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function removeClient() {
  if (!c.value) return
  const ok = await ask({
    title: `Διαγραφή πελάτη «${c.value.name}»;`,
    description: 'Χάνονται και τα πλάνα και τα streams με τα κλειδιά εκπομπής τους.',
  })
  if (!ok) return
  try {
    // Όλα φεύγουν μαζί (cascade στο schema.prisma) — ένα request.
    await api(`/clients/${id}`, { method: 'DELETE' })
    await navigateTo('/admin/clients')
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Μία αγορά = μία γραμμή στον πίνακα. Ο server δεν επιλέγεται: τον δίνει το
// πλάνο τη στιγμή αυτή, και μένει καρφωμένος στη συνδρομή για πάντα.
async function addSubscription() {
  if (!newPlan.value) return
  try {
    await api(`/clients/${id}/subscriptions`, { method: 'POST', body: JSON.stringify({ planId: newPlan.value }) })
    newPlan.value = undefined
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function toggleSubscription(s: SubscriptionRow) {
  try {
    await api(`/clients/${id}/subscriptions/${s.id}`, {
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

// Αναβάθμιση/υποβάθμιση: αλλάζει μόνο το πλάνο. Paths, κλειδιά και server μένουν
// — γι' αυτό και δεν είναι «αφαίρεση + προσθήκη» με δύο κλικ. Το `load()` στο
// finally ξαναφέρνει το παλιό πλάνο όταν το API πει 409 (το select έχει ήδη
// γράψει πάνω στο s.plan.id).
async function changePlan(s: SubscriptionRow) {
  try {
    await api(`/clients/${id}/subscriptions/${s.id}`, {
      method: 'PATCH', body: JSON.stringify({ planId: s.plan.id }),
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
async function renameSubscription(s: SubscriptionRow) {
  try {
    await api(`/clients/${id}/subscriptions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ label: s.label }) })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function removeSubscription(s: SubscriptionRow) {
  const ok = await ask({
    title: `Αφαίρεση του πλάνου «${s.plan.name}» (${s.server.host});`,
    // Το API το απορρίπτει με 409 όσο κρατάει streams — εδώ το λέμε πριν.
    description: s.paths.length
      ? `Έχει ${s.paths.length} streams — σβήσε τα πρώτα.`
      : 'Δεν έχει streams.',
  })
  if (!ok) return
  try {
    await api(`/clients/${id}/subscriptions/${s.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function addPath() {
  if (!c.value) return
  const path = newPath.value.trim()
  if (!newPathSub.value) {
    // Το γεμάτο πλάνο βγαίνει disabled στο select (δες subItems), οπότε δεν
    // υπάρχει τίποτα να διαλεχτεί και το κουμπί έμοιαζε χαλασμένο: σιωπηλό return.
    error.value = !c.value.subscriptions.length
      ? 'Ο πελάτης δεν έχει πλάνο ακόμα — πρόσθεσε πρώτα ένα.'
      : subItems.value.every(i => i.disabled)
        ? 'Όλα τα πλάνα του πελάτη είναι γεμάτα — πρόσθεσε πλάνο ή σβήσε ένα stream.'
        : 'Διάλεξε πλάνο για το νέο stream.'
    return
  }
  try {
    // Κενό path = το ονομάζει το API (δες clients.service.ts#nextPath).
    await api(`/clients/${id}/paths`, {
      method: 'POST',
      body: JSON.stringify({ path: path || undefined, subscriptionId: newPathSub.value }),
    })
    newPath.value = ''
    await load()
  }
  catch (e) {
    // Εδώ πέφτει και το μήνυμα για λάθος μορφή path (δες clients.controller.ts) — δείξ' το ως έχει.
    error.value = (e as Error).message
  }
}

async function removePath(p: PathRow) {
  const ok = await ask({
    title: `Διαγραφή του stream ${p.path};`,
    description: 'Η εκπομπή που τρέχει με αυτό το κλειδί θα κοπεί.',
  })
  if (!ok) return
  try {
    await api(`/clients/${id}/paths/${p.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function refreshKey(p: PathRow) {
  const ok = await ask({
    title: `Νέο κλειδί για το ${p.path};`,
    description: 'Το παλιό παύει να ισχύει — η εκπομπή που τρέχει με αυτό κόβεται σε ≤10s και θέλει το νέο.',
  })
  if (!ok) return
  try {
    await api(`/clients/${id}/paths/${p.id}/key`, { method: 'POST' })
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

// Ίδιο μοτίβο με το dashboard: ο player ζει σε modal και ξηλώνεται με το
// κλείσιμο (v-if), αλλιώς μια ξεχασμένη καρτέλα μετράει ως κανονικός θεατής.
const playing = ref<{ host: string, stream: string } | null>(null)
const playerOpen = computed({
  get: () => !!playing.value,
  set: (v: boolean) => { if (!v) playing.value = null },
})

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3 flex-wrap">
      <UButton
        to="/admin/clients" icon="i-lucide-arrow-left" color="neutral" variant="ghost"
        aria-label="Πίσω στους πελάτες"
      />
      <UIcon name="i-lucide-user" class="text-primary size-5" />
      <h1>{{ c?.name ?? '…' }}</h1>
      <UBadge
        v-if="c" :color="c.disabled ? 'neutral' : 'success'" variant="subtle"
        :icon="c.disabled ? 'i-lucide-ban' : 'i-lucide-circle-check'"
      >
        {{ c.disabled ? 'ΑΝΕΝΕΡΓΟΣ' : 'ΕΝΕΡΓΟΣ' }}
      </UBadge>
      <span class="grow" />
      <template v-if="c">
        <UButton
          icon="i-lucide-eye" color="neutral" variant="subtle"
          :disabled="!c.users.length" @click="impersonate(c.id)"
        >
          Είσοδος ως πελάτης
        </UButton>
        <UButton
          :icon="c.disabled ? 'i-lucide-power' : 'i-lucide-ban'"
          :color="c.disabled ? 'success' : 'warning'" variant="subtle"
          @click="toggleDisabled"
        >
          {{ c.disabled ? 'Ενεργοποίηση' : 'Απενεργοποίηση' }}
        </UButton>
        <UButton icon="i-lucide-trash-2" color="error" variant="ghost" @click="removeClient">Διαγραφή</UButton>
      </template>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <template v-if="c">
      <UCard>
        <template #header>
          <h2 class="mb-0">Στοιχεία</h2>
        </template>

        <div class="space-y-4">
          <UFormField label="Όνομα">
            <UInput v-model="c.name" class="w-full sm:w-1/2" />
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Όνομα χρήστη">
              <UInput v-model="cred.username" autocomplete="off" class="w-full" />
            </UFormField>
            <UFormField label="Νέος κωδικός">
              <UInput
                v-model="cred.password" type="password" autocomplete="new-password"
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

          <UButton icon="i-lucide-save" color="neutral" variant="subtle" @click="saveClient">Αποθήκευση</UButton>
        </div>
      </UCard>

      <!-- Τα αγορασμένα πλάνα, με τα όριά τους το καθένα: δεν αθροίζονται. -->
      <UCard>
        <template #header>
          <h2 class="mb-0">Πλάνα</h2>
        </template>

        <div class="space-y-4">
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
                      class="min-w-40" @change="renameSubscription(s)"
                    />
                  </td>
                  <!-- Αναβάθμιση/υποβάθμιση επιτόπου: τα streams και τα κλειδιά
                       τους δεν πειράζονται, ο server μένει αυτός της αγοράς. -->
                  <td>
                    <USelect
                      v-model="s.plan.id" :items="planItemsFor(s)" size="xs" class="min-w-52"
                      @update:model-value="changePlan(s)"
                    />
                  </td>
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
                        @click="toggleSubscription(s)"
                      />
                      <UButton
                        icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                        aria-label="Αφαίρεση πλάνου" @click="removeSubscription(s)"
                      />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="empty">Κανένα πλάνο ακόμα — χωρίς πλάνο δεν μπορεί να εκπέμψει</div>
          </div>

          <form class="flex gap-2 flex-wrap" @submit.prevent="addSubscription">
            <USelect v-model="newPlan" :items="planItems" placeholder="— πλάνο —" class="grow min-w-60" />
            <UButton type="submit" icon="i-lucide-plus" color="neutral" variant="subtle">Προσθήκη πλάνου</UButton>
          </form>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="mb-0">Streams</h2>
        </template>

        <div class="space-y-4">
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
                        <div class="flex gap-1 justify-end">
                          <UButton
                            icon="i-lucide-play" size="xs" color="neutral" variant="ghost"
                            aria-label="Player" title="Player"
                            @click="playing = { host: s.server.host, stream: p.path }"
                          />
                          <UButton
                            icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost"
                            aria-label="Νέο κλειδί" title="Νέο κλειδί" @click="refreshKey(p)"
                          />
                          <UButton
                            icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                            aria-label="Διαγραφή stream" title="Διαγραφή stream" @click="removePath(p)"
                          />
                        </div>
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

          <form class="flex gap-2 flex-wrap" @submit.prevent="addPath">
            <UInput v-model="newPath" placeholder="/live/kamera1 — κενό για αυτόματο" class="grow min-w-45" />
            <!-- Το stream ανήκει σε πλάνο: από εκεί παίρνει server και όριο θεατών.
                 Γεμάτο πλάνο εμφανίζεται απενεργοποιημένο αντί για σίγουρο 409. -->
            <USelect v-model="newPathSub" :items="subItems" placeholder="— πλάνο —" class="min-w-60" />
            <UButton type="submit" icon="i-lucide-plus" color="neutral" variant="subtle">Προσθήκη stream</UButton>
          </form>
        </div>
      </UCard>
    </template>

    <UModal
      v-model:open="playerOpen" :title="playing?.stream" :description="playing?.host"
      :ui="{ content: 'sm:max-w-4xl', body: 'p-0 sm:p-0' }"
    >
      <template #body>
        <PlayerStage v-if="playing" :src="hlsUrl(playing.host, playing.stream)" auto />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
</style>
