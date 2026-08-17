<script setup lang="ts">
// CRUD stream servers. Συμβόλαιο: apps/api/README.md.
interface ServerRow {
  id: number
  host: string
  adminUrl: string
  adminUser: string
  adminPass: string
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

const form = reactive({ host: '', adminUrl: '', adminUser: '', adminPass: '' })
// Ο server μόλις δημιουργήθηκε — το token με context φαίνεται μόνο εδώ, μία φορά.
const created = ref<ServerRow | null>(null)
// Νέος κωδικός ανά server, άδειο = μένει ο ίδιος (δεν ξαναδείχνουμε τον παλιό).
const editPass = reactive<Record<number, string>>({})

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
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

async function saveServer(s: ServerRow) {
  const body: Record<string, unknown> = { host: s.host, adminUrl: s.adminUrl, adminUser: s.adminUser }
  const pass = editPass[s.id]?.trim()
  if (pass) body.adminPass = pass
  try {
    await api(`/servers/${s.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    editPass[s.id] = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
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
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-server" class="text-primary size-5" />
      <h1>Stream servers</h1>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard>
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

    <UCard v-for="s in servers" :key="s.id">
      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <UFormField label="Host">
            <UInput v-model="s.host" class="w-full" />
          </UFormField>
          <UFormField label="Admin URL">
            <UInput v-model="s.adminUrl" class="w-full" />
          </UFormField>
          <UFormField label="Admin user">
            <UInput v-model="s.adminUser" class="w-full" />
          </UFormField>
          <UFormField label="Νέος κωδικός">
            <UInput v-model="editPass[s.id]" type="password" placeholder="κενό = ίδιος" class="w-full" />
          </UFormField>
        </div>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <span class="note">Τελευταίο sync: {{ fmtDate(s.lastSeen) }} · πλάνα: {{ s._count.plans }} · συνδρομές: {{ s._count.subscriptions }} · streams: {{ s._count.paths }}</span>
          <div class="flex gap-2">
            <UButton icon="i-lucide-save" color="neutral" variant="subtle" @click="saveServer(s)">Αποθήκευση</UButton>
            <UButton icon="i-lucide-trash-2" color="error" variant="ghost" @click="removeServer(s)">Διαγραφή</UButton>
          </div>
        </div>
      </div>
    </UCard>

    <UCard v-if="!servers.length">
      <div class="quiet">Κανένας server ακόμα</div>
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
