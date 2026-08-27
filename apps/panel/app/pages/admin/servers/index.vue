<script setup lang="ts">
// Κατάλογος stream servers. Ό,τι αλλάζει τιμές ζει στη σελίδα του καθενός —
// εδώ μόνο ποιοι υπάρχουν, πότε έκαναν sync και τι κουβαλάνε.
// Συμβόλαιο: apps/api/README.md.
interface ServerRow {
  id: number
  host: string
  adminUrl: string
  adminUser: string
  token: string
  lastSeen: string | null
  // Πλάνα που πουλάνε εδώ, συνδρομές που κάθονται εδώ, paths που ζουν εδώ — ο
  // πελάτης δεν ανήκει σε server (τον έχει η συνδρομή του).
  _count: { plans: number, subscriptions: number, paths: number }
}

const api = useApi()
const ask = useConfirm()
const servers = ref<ServerRow[]>([])
const error = ref('')
const busy = ref(false)
const creating = ref(false)

const form = reactive({ host: '', adminUrl: '', adminUser: '', adminPass: '' })
// Ο server μόλις δημιουργήθηκε — το token με context φαίνεται μόνο εδώ, μία φορά.
const created = ref<ServerRow | null>(null)

const { q, page, shown, paged, perPage } = usePaged(servers, s => `${s.host} ${s.adminUrl} ${s.adminUser}`)

async function load() {
  try {
    servers.value = await api<ServerRow[]>('/servers')
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createServer() {
  if (!form.host || !form.adminUrl || !form.adminUser || !form.adminPass) return
  busy.value = true
  try {
    created.value = await api<ServerRow>('/servers', { method: 'POST', body: JSON.stringify(form) })
    Object.assign(form, { host: '', adminUrl: '', adminUser: '', adminPass: '' })
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

async function removeServer(s: ServerRow) {
  const ok = await ask({
    title: `Διαγραφή server «${s.host}»;`,
    // Οι πελάτες ΔΕΝ κάνουν cascade (servers.service.ts) — με πελάτες πάνω του
    // το API απαντάει 409 και το μήνυμα βγαίνει στο UAlert.
    description: 'Φεύγει μόνο από το panel — ο ίδιος ο server συνεχίζει να τρέχει. Αν έχει πελάτες, η διαγραφή απορρίπτεται.',
  })
  if (!ok) return
  try {
    await api(`/servers/${s.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

const fmtDate = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('el-GR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : 'ποτέ'

// Το κομμάτι που πάει στο config.json του stream server — το url είναι πάντα
// /api κάτω από το ίδιο origin με το panel (nuxt.config.ts: apiBase).
const configBlock = (s: ServerRow) => JSON.stringify(
  { panel: { url: `${window.location.origin}/api`, token: s.token, host: s.host } }, null, 2,
)

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2 flex-wrap">
      <UIcon name="i-lucide-server" class="text-primary size-5" />
      <h1>Stream servers</h1>
      <UBadge color="neutral" variant="subtle">{{ servers.length }}</UBadge>
      <span class="grow" />
      <UInput
        v-model="q" icon="i-lucide-search" placeholder="Host, admin URL…"
        class="w-full sm:w-64" @keydown.esc="q = ''"
      />
      <UButton icon="i-lucide-plus" @click="creating = !creating">Νέος server</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard v-if="creating">
      <template #header>
        <h2 class="mb-0">Νέος server</h2>
      </template>

      <form class="space-y-4" @submit.prevent="createServer">
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <UFormField label="Host">
            <UInput v-model="form.host" placeholder="stream1.example.com" required class="w-full" />
          </UFormField>
          <UFormField label="Admin URL">
            <UInput v-model="form.adminUrl" placeholder="https://stream1.example.com" required class="w-full" />
          </UFormField>
          <UFormField label="Admin user">
            <UInput v-model="form.adminUser" required class="w-full" />
          </UFormField>
          <UFormField label="Admin κωδικός">
            <UInput v-model="form.adminPass" type="password" autocomplete="new-password" required class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Το host πρέπει να είναι το <b>δημόσιο domain</b> του stream server — το panel χτίζει από
          αυτό τα URL αναπαραγωγής (<code>https://&lt;host&gt;/&lt;stream&gt;/index.m3u8</code>).
          Το admin URL/user/κωδικός είναι το <code>/admin/api</code> του ίδιου server (βλ. stats.js).
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία server</UButton>
      </form>
    </UCard>

    <UCard v-if="created" :ui="{ root: 'ring-2 ring-primary' }">
      <template #header>
        <div class="flex items-center gap-2">
          <h2 class="mb-0 grow">Ο server «{{ created.host }}» δημιουργήθηκε</h2>
          <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="created = null" />
        </div>
      </template>

      <div class="space-y-3">
        <UAlert
          color="warning" variant="subtle" icon="i-lucide-key"
          description="Το token φαίνεται με context μόνο εδώ, τώρα — αντέγραψέ το πριν κλείσεις. Το μπλοκ παρακάτω πάει στο config.json του stream server (κλειδί panel) και θέλει restart του server για να πιάσει."
        />
        <div class="flex items-center gap-2 flex-wrap">
          <span>Token: <code>{{ created.token }}</code></span>
          <CopyButton :text="created.token" />
        </div>
        <pre>{{ configBlock(created) }}</pre>
        <CopyButton :text="configBlock(created)" label="Αντιγραφή μπλοκ" />
      </div>
    </UCard>

    <UCard>
      <div class="scroll">
        <table v-if="paged.length">
          <thead>
            <tr>
              <th>Host</th><th>Admin URL</th><th>Τελευταίο sync</th>
              <th class="num">Πλάνα</th><th class="num">Συνδρομές</th><th class="num">Streams</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in paged" :key="s.id">
              <td><ULink :to="`/admin/servers/${s.id}`" class="font-semibold">{{ s.host }}</ULink></td>
              <td class="host">{{ s.adminUrl }}</td>
              <td>{{ fmtDate(s.lastSeen) }}</td>
              <td class="num">{{ s._count.plans }}</td>
              <td class="num">{{ s._count.subscriptions }}</td>
              <td class="num">{{ s._count.paths }}</td>
              <td>
                <div class="flex gap-1 justify-end">
                  <UButton
                    icon="i-lucide-chart-line" size="xs" color="neutral" variant="ghost"
                    :to="`/admin?host=${s.host}`" title="Στατιστικά" aria-label="Στατιστικά"
                  />
                  <UButton
                    icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost"
                    :to="`/admin/servers/${s.id}`" title="Επεξεργασία" aria-label="Επεξεργασία"
                  />
                  <UButton
                    icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
                    title="Διαγραφή" aria-label="Διαγραφή" @click="removeServer(s)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">
          {{ servers.length ? 'Κανένας server δεν ταιριάζει στην αναζήτηση' : 'Κανένας server ακόμα' }}
        </div>
      </div>

      <div v-if="shown.length > perPage" class="flex justify-center mt-4">
        <UPagination v-model:page="page" :total="shown.length" :items-per-page="perPage" />
      </div>
    </UCard>
  </div>
</template>

<style scoped>
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
pre {
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; font-size: 12px; overflow-x: auto;
}
</style>
