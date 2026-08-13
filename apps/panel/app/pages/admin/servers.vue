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
  _count: { clients: number }
}

const api = useApi()
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
  if (!confirm(`Διαγραφή server «${s.host}»;`)) return
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
  <div>
    <h1>Stream servers</h1>
    <p v-if="error" class="error">{{ error }}</p>

    <form class="card" @submit.prevent="createServer">
      <h2>Νέος server</h2>
      <div class="row">
        <label>Host <input v-model="form.host" placeholder="stream1.example.com" required></label>
        <label>Admin URL <input v-model="form.adminUrl" placeholder="https://stream1.example.com" required></label>
        <label>Admin user <input v-model="form.adminUser" required></label>
        <label>Admin κωδικός <input v-model="form.adminPass" type="password" autocomplete="new-password" required></label>
      </div>
      <p class="note">
        Το host πρέπει να είναι το <b>δημόσιο domain</b> του stream server — το panel χτίζει από
        αυτό τα URL αναπαραγωγής (<code>https://&lt;host&gt;/&lt;stream&gt;/index.m3u8</code>).
        Το admin URL/user/κωδικός είναι το <code>/admin/api</code> του ίδιου server (βλ. stats.js).
      </p>
      <button :disabled="busy">{{ busy ? 'δημιουργία…' : 'Δημιουργία server' }}</button>
    </form>

    <div v-if="created" class="card highlight">
      <div class="row-between">
        <h2>Ο server «{{ created.host }}» δημιουργήθηκε</h2>
        <button type="button" @click="created = null">Έκλεισε</button>
      </div>
      <p class="note">
        Το token φαίνεται με context μόνο εδώ, τώρα — αντέγραψέ το πριν κλείσεις. Το μπλοκ
        παρακάτω πάει στο <code>config.json</code> του stream server (κλειδί <code>panel</code>)
        και θέλει restart του server για να πιάσει.
      </p>
      <div class="row">
        <span>Token: <code>{{ created.token }}</code></span>
        <AdminCopyButton :text="created.token" />
      </div>
      <pre>{{ configBlock(created) }}</pre>
      <AdminCopyButton :text="configBlock(created)" />
    </div>

    <div v-for="s in servers" :key="s.id" class="card">
      <div class="row">
        <label>Host <input v-model="s.host"></label>
        <label>Admin URL <input v-model="s.adminUrl"></label>
        <label>Admin user <input v-model="s.adminUser"></label>
        <label>Νέος κωδικός <input v-model="editPass[s.id]" type="password" placeholder="κενό = ίδιος"></label>
      </div>
      <div class="row-between">
        <span class="note">Τελευταίο sync: {{ fmtDate(s.lastSeen) }} · πελάτες: {{ s._count.clients }}</span>
        <div class="row">
          <button @click="saveServer(s)">Αποθήκευση</button>
          <button class="kill" @click="removeServer(s)">Διαγραφή</button>
        </div>
      </div>
    </div>
    <div v-if="!servers.length" class="card"><div class="quiet">Κανένας server ακόμα</div></div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 10px; }
.row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
input {
  font: inherit; padding: 6px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary);
}
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
.highlight { border-color: var(--s1); }
pre {
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; font-size: 12px; overflow-x: auto; margin: 10px 0;
}
</style>
