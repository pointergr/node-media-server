<script setup lang="ts">
// CRUD πακέτων: ό,τι πουλάμε, με τα όριά του και τον server όπου πέφτουν οι νέες
// αγορές του. Ο πελάτης παίρνει όσα θέλει, και σε όποια ποσότητα — τα όρια
// αθροίζονται ανά server (δες admin/clients.vue).
interface Row {
  id: number
  name: string
  maxViewers: number
  maxStreams: number
  serverId: number
  server: { host: string }
  _count: { clients: number }
}

const api = useApi()
const ask = useConfirm()
const packages = ref<Row[]>([])
const servers = ref<{ id: number, host: string }[]>([])
const error = ref('')
const busy = ref(false)

const serverItems = computed(() => servers.value.map(s => ({ label: s.host, value: s.id })))
const form = reactive<{ name: string, maxViewers: number, maxStreams: number, serverId: number | undefined }>({
  name: '', maxViewers: 50, maxStreams: 1, serverId: undefined,
})

async function load() {
  try {
    [packages.value, servers.value] = await Promise.all([
      api<Row[]>('/packages'),
      api<{ id: number, host: string }[]>('/servers'),
    ])
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createPackage() {
  if (!form.name || !form.serverId) return
  busy.value = true
  try {
    await api('/packages', { method: 'POST', body: JSON.stringify(form) })
    Object.assign(form, { name: '', maxViewers: 50, maxStreams: 1, serverId: undefined })
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
// τιμές πάνω από ό,τι πληκτρολόγησε ο χρήστης.
async function savePackage(p: Row) {
  try {
    await api(`/packages/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: p.name, maxViewers: p.maxViewers, maxStreams: p.maxStreams, serverId: p.serverId,
      }),
    })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function removePackage(p: Row) {
  const ok = await ask({
    title: `Διαγραφή πακέτου «${p.name}»;`,
    // Το API το απορρίπτει με 409 όσο το κρατάει έστω ένας πελάτης — εδώ το λέμε
    // πριν, για να μην πατηθεί άσκοπα.
    description: p._count.clients
      ? `Το κρατούν ${p._count.clients} πελάτες — αφαίρεσέ το πρώτα από αυτούς.`
      : 'Δεν το χρησιμοποιεί κανένας πελάτης.',
  })
  if (!ok) return
  try {
    await api(`/packages/${p.id}`, { method: 'DELETE' })
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
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-package" class="text-primary size-5" />
      <h1>Πακέτα</h1>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard>
      <template #header>
        <h2 class="mb-0">Νέο πακέτο</h2>
      </template>

      <form class="space-y-4" @submit.prevent="createPackage">
        <div class="grid gap-4 sm:grid-cols-4">
          <UFormField label="Όνομα">
            <UInput v-model="form.name" placeholder="basic" required class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστοι θεατές">
            <UInputNumber v-model="form.maxViewers" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστα streams">
            <UInputNumber v-model="form.maxStreams" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Server">
            <USelect v-model="form.serverId" :items="serverItems" placeholder="— επιλογή —" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Τα όρια είναι ανά πακέτο και αθροίζονται <b>ανά server</b>: πελάτης με 2× «basic» των 50
          θεατών στο ίδιο μηχάνημα έχει 100 εκεί. Πελάτης <b>χωρίς</b> πακέτο δεν έχει όριο. Τα
          «streams» είναι πόσα paths μπορεί να έχει, όχι πόσα εκπέμπει ταυτόχρονα.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία πακέτου</UButton>
      </form>
    </UCard>

    <UCard v-for="p in packages" :key="p.id">
      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-4">
          <UFormField label="Όνομα">
            <UInput v-model="p.name" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστοι θεατές">
            <UInputNumber v-model="p.maxViewers" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστα streams">
            <UInputNumber v-model="p.maxStreams" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Server" help="μόνο για τις επόμενες αγορές">
            <USelect v-model="p.serverId" :items="serverItems" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Οι <b>{{ p._count.clients }}</b> αγορές που έγιναν ήδη μένουν στον server τους — η αλλαγή
          εδώ αφορά μόνο τις επόμενες. Έτσι γεμίζει ένα μηχάνημα και το πακέτο συνεχίζει στο
          επόμενο, χωρίς να μετακομίσει κανένας πελάτης.
        </p>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <span class="note">Αγορές αυτού του πακέτου: {{ p._count.clients }}</span>
          <div class="flex gap-2">
            <UButton icon="i-lucide-save" color="neutral" variant="subtle" @click="savePackage(p)">Αποθήκευση</UButton>
            <UButton icon="i-lucide-trash-2" color="error" variant="ghost" @click="removePackage(p)">Διαγραφή</UButton>
          </div>
        </div>
      </div>
    </UCard>

    <UCard v-if="!packages.length">
      <div class="quiet">Κανένα πακέτο ακόμα</div>
    </UCard>
  </div>
</template>
