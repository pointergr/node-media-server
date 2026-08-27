<script setup lang="ts">
// Κατάλογος πελατών: μία γραμμή ανά πελάτη και τρία κουμπιά. Ό,τι αλλάζει
// τιμές (όνομα, στοιχεία σύνδεσης, πλάνα, streams, προορισμοί) ζει στη σελίδα
// του καθενός — με είκοσι πελάτες ανοιχτούς μαζί, η σελίδα ήταν αδιάβαστη και
// κάθε αποθήκευση ήταν σε λάθος κάρτα ένα scroll μακριά.
// Συμβόλαιο των endpoints: apps/api/README.md.
interface ClientRow {
  id: number
  name: string
  disabled: boolean
  subscriptions: {
    id: number
    disabled: boolean
    label: string | null
    plan: { name: string }
    server: { host: string }
    paths: { id: number, path: string }[]
  }[]
  users: { id: number, username: string }[]
}

const api = useApi()
const ask = useConfirm()
const clients = ref<ClientRow[]>([])
const error = ref('')
const busy = ref(false)
const creating = ref(false)

const form = reactive({ name: '', username: '', password: '' })

// Ψάχνει και στα paths: ο διαχειριστής ξέρει συχνά το stream, όχι τον πελάτη.
const { q, page, shown, paged, perPage } = usePaged(clients, c => [
  c.name,
  ...c.users.map(u => u.username),
  ...c.subscriptions.flatMap(s => [s.label ?? '', s.plan.name, s.server.host, ...s.paths.map(p => p.path)]),
].join(' '))

// Τα μηχανήματα όπου κάθεται ο πελάτης — παράγωγο των συνδρομών του.
const hostsOf = (c: ClientRow) => [...new Set(c.subscriptions.map(s => s.server.host))]
const streamCount = (c: ClientRow) => c.subscriptions.reduce((a, s) => a + s.paths.length, 0)

async function load() {
  try {
    clients.value = await api<ClientRow[]>('/clients')
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
    const created = await api<ClientRow>('/clients', { method: 'POST', body: JSON.stringify(body) })
    Object.assign(form, { name: '', username: '', password: '' })
    creating.value = false
    // Κατευθείαν στη σελίδα του: ο νέος πελάτης είναι σκέτο όνομα, το επόμενο
    // βήμα είναι πάντα να του δώσεις πλάνο.
    await navigateTo(`/admin/clients/${created.id}`)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

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

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2 flex-wrap">
      <UIcon name="i-lucide-users" class="text-primary size-5" />
      <h1>Πελάτες</h1>
      <UBadge color="neutral" variant="subtle">{{ clients.length }}</UBadge>
      <span class="grow" />
      <UInput
        v-model="q" icon="i-lucide-search" placeholder="Πελάτης, χρήστης, stream…"
        class="w-full sm:w-72" @keydown.esc="q = ''"
      />
      <UButton icon="i-lucide-plus" @click="creating = !creating">Νέος πελάτης</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard v-if="creating">
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
          Ο πελάτης φτιάχνεται άδειος: τα πλάνα του τα αγοράζεις από τη σελίδα του, όπου
          πηγαίνεις αμέσως μετά. Αν συμπληρώσεις και τα δύο πεδία σύνδεσης, φτιάχνεται μαζί ο
          χρήστης με τον οποίο θα μπαίνει ο ίδιος στο δικό του panel.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία πελάτη</UButton>
      </form>
    </UCard>

    <UCard>
      <div class="scroll">
        <table v-if="paged.length">
          <thead>
            <tr>
              <th>Κατάσταση</th><th>Πελάτης</th><th>Χρήστης</th><th>Servers</th>
              <th class="num">Πλάνα</th><th class="num">Streams</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in paged" :key="c.id">
              <td>
                <UBadge
                  :color="c.disabled ? 'neutral' : 'success'" variant="subtle"
                  :icon="c.disabled ? 'i-lucide-ban' : 'i-lucide-circle-check'"
                >
                  {{ c.disabled ? 'ΑΝΕΝΕΡΓΟΣ' : 'ΕΝΕΡΓΟΣ' }}
                </UBadge>
              </td>
              <td>
                <ULink :to="`/admin/clients/${c.id}`" class="font-semibold">{{ c.name }}</ULink>
              </td>
              <td>{{ c.users[0]?.username ?? '—' }}</td>
              <td>
                <span v-for="host in hostsOf(c)" :key="host" class="host">{{ host }}</span>
                <span v-if="!c.subscriptions.length" class="host">—</span>
              </td>
              <td class="num">{{ c.subscriptions.length }}</td>
              <td class="num">{{ streamCount(c) }}</td>
              <td>
                <div class="flex gap-1 justify-end">
                  <!-- Απενεργοποιημένο χωρίς χρήστη σύνδεσης: το login-link
                       χρειάζεται λογαριασμό, που φτιάχνεται στη σελίδα του. -->
                  <UButton
                    icon="i-lucide-eye" size="xs" color="neutral" variant="ghost"
                    :disabled="!c.users.length" title="Είσοδος ως πελάτης"
                    aria-label="Είσοδος ως πελάτης" @click="viewAs(c)"
                  />
                  <UButton
                    icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost"
                    :to="`/admin/clients/${c.id}`" title="Επεξεργασία" aria-label="Επεξεργασία"
                  />
                  <UButton
                    icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                    title="Διαγραφή" aria-label="Διαγραφή" @click="removeClient(c)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">
          {{ clients.length ? 'Κανένας πελάτης δεν ταιριάζει στην αναζήτηση' : 'Κανένας πελάτης ακόμα' }}
        </div>
      </div>

      <div v-if="shown.length > perPage" class="flex justify-center mt-4">
        <UPagination v-model:page="page" :total="shown.length" :items-per-page="perPage" />
      </div>
    </UCard>
  </div>
</template>
