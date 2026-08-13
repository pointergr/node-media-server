<script setup lang="ts">
// CRUD πελατών: server, όριο θεατών, paths (= κλειδιά εκπομπής) και disable/enable.
// Συμβόλαιο των endpoints: apps/api/README.md.
interface PathRow { id: number, path: string, key: string }
interface ServerOption { id: number, host: string }
interface ClientRow {
  id: number
  name: string
  limit: number
  disabled: boolean
  serverId: number
  server: ServerOption
  paths: PathRow[]
}

const api = useApi()
const clients = ref<ClientRow[]>([])
const servers = ref<ServerOption[]>([])
const error = ref('')
const busy = ref(false)

const form = reactive<{ name: string, serverId: number | '', limit: number, username: string, password: string }>({
  name: '', serverId: '', limit: 0, username: '', password: '',
})
// Ένα πεδίο "νέο path" ανά πελάτη, όχι ξεχωριστό ref το καθένα — key = client.id.
const newPath = reactive<Record<number, string>>({})

async function load() {
  try {
    [clients.value, servers.value] = await Promise.all([
      api<ClientRow[]>('/clients'),
      api<ServerOption[]>('/servers'),
    ])
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
    const body: Record<string, unknown> = { name: form.name, serverId: form.serverId, limit: form.limit }
    // Και τα δύο μαζί ή τίποτα — μισή φόρμα σημαίνει πελάτη χωρίς τρόπο σύνδεσης.
    if (form.username && form.password) Object.assign(body, { username: form.username, password: form.password })
    await api('/clients', { method: 'POST', body: JSON.stringify(body) })
    Object.assign(form, { name: '', serverId: '', limit: 0, username: '', password: '' })
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
    await api(`/clients/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: c.name, limit: c.limit, serverId: c.serverId }),
    })
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
  if (!confirm(`Διαγραφή πελάτη «${c.name}»; Χάνονται και τα paths/κλειδιά του.`)) return
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
  if (!confirm(`Διαγραφή του path ${p.path}; Το OBS που εκπέμπει με αυτό το κλειδί θα κοπεί.`)) return
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
  <div>
    <h1>Πελάτες</h1>
    <p v-if="error" class="error">{{ error }}</p>

    <form class="card" @submit.prevent="createClient">
      <h2>Νέος πελάτης</h2>
      <div class="row">
        <label>Όνομα <input v-model="form.name" required></label>
        <label>Server
          <select v-model="form.serverId" required>
            <option value="" disabled>— επιλογή —</option>
            <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.host }}</option>
          </select>
        </label>
        <label>Όριο θεατών <input v-model.number="form.limit" type="number" min="0"></label>
      </div>
      <p class="note">0 = χωρίς όριο θεατών, αθροιστικά σε όλα τα paths του πελάτη.</p>
      <div class="row">
        <label>Όνομα χρήστη (προαιρετικό) <input v-model="form.username" autocomplete="off"></label>
        <label>Κωδικός (προαιρετικό) <input v-model="form.password" type="password" autocomplete="new-password"></label>
      </div>
      <p class="note">
        Αν συμπληρώσεις και τα δύο, φτιάχνεται μαζί με τον πελάτη ο χρήστης με τον οποίο θα
        συνδέεται ο ίδιος στο δικό του panel. Χωρίς αυτά ο πελάτης δεν έχει σύνδεση — μόνο ο
        διαχειριστής βλέπει/αλλάζει τα paths του.
      </p>
      <button :disabled="busy">{{ busy ? 'δημιουργία…' : 'Δημιουργία πελάτη' }}</button>
    </form>

    <div v-for="c in clients" :key="c.id" class="card">
      <div class="row client-head">
        <span v-if="c.disabled" class="offair">ΑΝΕΝΕΡΓΟΣ</span>
        <span v-else class="onair">ΕΝΕΡΓΟΣ</span>
        <label>Όνομα <input v-model="c.name"></label>
        <label>Server
          <select v-model="c.serverId">
            <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.host }}</option>
          </select>
        </label>
        <label>Όριο θεατών <input v-model.number="c.limit" type="number" min="0" class="narrow"></label>
        <span class="spacer" />
        <button @click="saveClient(c)">Αποθήκευση</button>
        <button @click="toggleDisabled(c)">{{ c.disabled ? 'Ενεργοποίηση' : 'Απενεργοποίηση' }}</button>
        <button class="kill" @click="removeClient(c)">Διαγραφή</button>
      </div>
      <p class="note">
        Το disable/enable κόβει ή ξαναφέρνει τις εκπομπές του πελάτη μέσα σε ≤10s — όσο κάνει ο
        server να ξανασυγχρονίσει τη λίστα των πελατών του.
      </p>

      <table v-if="c.paths.length">
        <thead>
          <tr><th>Path</th><th>Stream Key (OBS)</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="p in c.paths" :key="p.id">
            <td>{{ p.path }}</td>
            <td><code>{{ streamKey(p) }}</code> <AdminCopyButton :text="streamKey(p)" /></td>
            <td><button class="kill" @click="removePath(c, p)">Διαγραφή</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">Κανένα path ακόμα</div>

      <form class="row add-path" @submit.prevent="addPath(c)">
        <input v-model="newPath[c.id]" placeholder="/live/kamera1" required>
        <button>Προσθήκη path</button>
      </form>
    </div>
    <div v-if="!clients.length" class="card"><div class="quiet">Κανένας πελάτης ακόμα</div></div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 10px; }
.row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.client-head { align-items: center; margin-bottom: 4px; }
.client-head label { flex-direction: row; align-items: center; gap: 6px; }
input, select {
  font: inherit; padding: 6px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary);
}
.narrow { width: 70px; }
.add-path { margin-top: 12px; }
.add-path input { flex: 1; min-width: 180px; }
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
</style>
