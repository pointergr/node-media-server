<script setup lang="ts">
// Ένας stream server: τα στοιχεία σύνδεσης με το /admin/api του και τίποτα
// άλλο — το token δίνεται μία φορά, στη δημιουργία (δες servers/index.vue).
interface ServerRow {
  id: number
  host: string
  adminUrl: string
  adminUser: string
  lastSeen: string | null
  _count: { plans: number, subscriptions: number, paths: number }
}

const id = Number(useRoute().params.id)
const api = useApi()
const ask = useConfirm()
const toast = useToast()

const s = ref<ServerRow | null>(null)
const error = ref('')
// Νέος κωδικός, άδειο = μένει ο ίδιος (δεν ξαναδείχνουμε τον παλιό).
const pass = ref('')

async function load() {
  try {
    s.value = await api<ServerRow>(`/servers/${id}`)
    pass.value = ''
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Πάντα ξαναφορτώνει μετά, επιτυχία ή όχι — σε αποτυχία ξαναφέρνει τις σωστές
// τιμές πάνω από ό,τι πληκτρολόγησε ο χρήστης.
async function save() {
  if (!s.value) return
  const body: Record<string, unknown> = {
    host: s.value.host, adminUrl: s.value.adminUrl, adminUser: s.value.adminUser,
  }
  if (pass.value.trim()) body.adminPass = pass.value.trim()
  try {
    await api(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
    toast.add({ title: 'Αποθηκεύτηκε', color: 'success', icon: 'i-lucide-circle-check' })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function remove() {
  if (!s.value) return
  const ok = await ask({
    title: `Διαγραφή server «${s.value.host}»;`,
    // Οι πελάτες ΔΕΝ κάνουν cascade (servers.service.ts) — με πελάτες πάνω του
    // το API απαντάει 409 και το μήνυμα βγαίνει στο UAlert.
    description: 'Φεύγει μόνο από το panel — ο ίδιος ο server συνεχίζει να τρέχει. Αν έχει πελάτες, η διαγραφή απορρίπτεται.',
  })
  if (!ok) return
  try {
    await api(`/servers/${id}`, { method: 'DELETE' })
    await navigateTo('/admin/servers')
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

const fmtDate = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('el-GR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : 'ποτέ'

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3 flex-wrap">
      <UButton
        to="/admin/servers" icon="i-lucide-arrow-left" color="neutral" variant="ghost"
        aria-label="Πίσω στους servers"
      />
      <UIcon name="i-lucide-server" class="text-primary size-5" />
      <h1>{{ s?.host ?? '…' }}</h1>
      <span class="grow" />
      <template v-if="s">
        <UButton
          :to="`/admin?host=${s.host}`" icon="i-lucide-chart-line" color="neutral" variant="subtle"
        >
          Στατιστικά
        </UButton>
        <UButton icon="i-lucide-trash-2" color="error" variant="ghost" @click="remove">Διαγραφή</UButton>
      </template>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard v-if="s">
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
            <UInput v-model="pass" type="password" placeholder="κενό = ίδιος" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Το host πρέπει να είναι το <b>δημόσιο domain</b> του stream server — το panel χτίζει από
          αυτό τα URL αναπαραγωγής. Αλλαγή του host δεν ενημερώνει τον ίδιο τον server: το
          <code>panel.host</code> του config.json του πρέπει να πει το ίδιο, αλλιώς το sync του
          δεν βρίσκει εγγραφή.
        </p>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <span class="note">Τελευταίο sync: {{ fmtDate(s.lastSeen) }} · πλάνα: {{ s._count.plans }} · συνδρομές: {{ s._count.subscriptions }} · streams: {{ s._count.paths }}</span>
          <UButton icon="i-lucide-save" color="neutral" variant="subtle" @click="save">Αποθήκευση</UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>

<style scoped>
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
</style>
