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
const ask = useConfirm()
const clients = ref<ClientRow[]>([])
const servers = ref<ServerOption[]>([])
const error = ref('')
const busy = ref(false)

// Έτοιμο για το USelect: {label, value} — το v-model κρατάει το id του server.
const serverItems = computed(() => servers.value.map(s => ({ label: s.host, value: s.id })))

const form = reactive<{ name: string, serverId: number | undefined, limit: number, username: string, password: string }>({
  name: '', serverId: undefined, limit: 0, username: '', password: '',
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
    Object.assign(form, { name: '', serverId: undefined, limit: 0, username: '', password: '' })
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
        <div class="grid gap-4 sm:grid-cols-3">
          <UFormField label="Όνομα">
            <UInput v-model="form.name" required class="w-full" />
          </UFormField>
          <UFormField label="Server">
            <USelect v-model="form.serverId" :items="serverItems" placeholder="— επιλογή —" class="w-full" />
          </UFormField>
          <UFormField label="Όριο θεατών" help="0 = χωρίς όριο, αθροιστικά σε όλα τα paths του πελάτη">
            <UInputNumber v-model="form.limit" :min="0" class="w-full" />
          </UFormField>
        </div>

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
        <div class="grid gap-4 sm:grid-cols-3">
          <UFormField label="Όνομα">
            <UInput v-model="c.name" class="w-full" />
          </UFormField>
          <UFormField label="Server">
            <USelect v-model="c.serverId" :items="serverItems" class="w-full" />
          </UFormField>
          <UFormField label="Όριο θεατών">
            <UInputNumber v-model="c.limit" :min="0" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Το disable/enable κόβει ή ξαναφέρνει τις εκπομπές του πελάτη μέσα σε ≤10s — όσο κάνει ο
          server να ξανασυγχρονίσει τη λίστα των πελατών του.
        </p>

        <div class="scroll">
          <table v-if="c.paths.length">
            <thead>
              <tr><th>Path</th><th>Stream Key (OBS)</th><th /></tr>
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
