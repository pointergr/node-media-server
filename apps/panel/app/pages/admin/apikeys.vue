<script setup lang="ts">
// API keys για εξωτερικές υπηρεσίες (provisioning). Ό,τι έκανε το
// `node dist/src/apikey.js` με shell στον server — συμβόλαιο: apps/api/README.md.
interface KeyRow {
  id: number
  name: string
  lastUsed: string | null
}

const api = useApi()
const ask = useConfirm()
const keys = ref<KeyRow[]>([])
const error = ref('')
const busy = ref(false)
const name = ref('')
// Το κλειδί που μόλις φτιάχτηκε: η μόνη στιγμή που φαίνεται η τιμή του.
const created = ref<{ name: string, key: string } | null>(null)

async function load() {
  try {
    keys.value = await api<KeyRow[]>('/apikeys')
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createKey() {
  if (!name.value.trim()) return
  busy.value = true
  try {
    created.value = await api<{ name: string, key: string }>('/apikeys', {
      method: 'POST',
      body: JSON.stringify({ name: name.value.trim() }),
    })
    name.value = ''
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

async function removeKey(k: KeyRow) {
  const ok = await ask({
    title: `Ανάκληση του κλειδιού «${k.name}»;`,
    description: 'Ό,τι το χρησιμοποιεί σταματάει αμέσως να έχει πρόσβαση στο API. Δεν αναιρείται — θέλει νέο κλειδί.',
  })
  if (!ok) return
  try {
    await api(`/apikeys/${k.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

const fmtDate = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('el-GR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : 'αχρησιμοποίητο'

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-key-round" class="text-primary size-5" />
      <h1>API keys</h1>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard>
      <template #header>
        <h2 class="mb-0">Νέο κλειδί</h2>
      </template>

      <form class="space-y-4" @submit.prevent="createKey">
        <UFormField label="Ποιος το κρατάει">
          <UInput v-model="name" placeholder="pointer.gr" required class="w-full sm:w-80" />
        </UFormField>

        <p class="note">
          Για <b>μηχανές</b>, όχι για ανθρώπους: <code>Authorization: Bearer pk_…</code> στα ίδια
          endpoints του admin, χωρίς login και χωρίς λήξη. Το όνομα είναι μόνο για να ξέρεις τι
          ακυρώνεις όταν το ακυρώσεις — δεν είναι μοναδικό.
          Ένα κλειδί <b>δεν</b> διαχειρίζεται κλειδιά: αυτή η οθόνη θέλει λογαριασμό διαχειριστή.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία κλειδιού</UButton>
      </form>
    </UCard>

    <UCard v-if="created" :ui="{ root: 'ring-2 ring-primary' }">
      <template #header>
        <div class="flex items-center gap-2">
          <h2 class="mb-0 grow">Το κλειδί «{{ created.name }}» δημιουργήθηκε</h2>
          <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="created = null" />
        </div>
      </template>

      <div class="space-y-3">
        <UAlert
          color="warning" variant="subtle" icon="i-lucide-key"
          description="Αντέγραψέ το τώρα — φαίνεται μόνο εδώ. Στη βάση αποθηκεύεται μόνο το sha256 του, οπότε χαμένο κλειδί σημαίνει νέο κλειδί."
        />
        <div class="flex items-center gap-2">
          <SecretKey :text="created.key" />
          <CopyButton :text="created.key" />
        </div>
      </div>
    </UCard>

    <UCard>
      <table v-if="keys.length">
        <thead>
          <tr><th>Όνομα</th><th>Τελευταία χρήση</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="k in keys" :key="k.id">
            <td>{{ k.name }}</td>
            <td class="quiet">{{ fmtDate(k.lastUsed) }}</td>
            <td class="text-right">
              <UButton icon="i-lucide-trash-2" size="xs" color="error" variant="ghost" @click="removeKey(k)">
                Ανάκληση
              </UButton>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="quiet">Κανένα κλειδί ακόμα</div>
    </UCard>
  </div>
</template>

<style scoped>
code { font-size: 12px; background: var(--plane); padding: 2px 6px; border-radius: 4px; }
</style>
