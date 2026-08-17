<script setup lang="ts">
// CRUD πλάνων: ο κατάλογος με ό,τι πουλάμε — όρια και ο server όπου πέφτουν οι
// νέες συνδρομές. Ο πελάτης αγοράζει όσα θέλει· κάθε συνδρομή κρατάει τα δικά
// της όρια, δεν αθροίζονται (δες admin/clients.vue).
interface Row {
  id: number
  name: string
  maxViewers: number
  maxStreams: number
  serverId: number
  server: { host: string }
  _count: { subscriptions: number }
}

const api = useApi()
const ask = useConfirm()
const plans = ref<Row[]>([])
const servers = ref<{ id: number, host: string }[]>([])
const error = ref('')
const busy = ref(false)

const serverItems = computed(() => servers.value.map(s => ({ label: s.host, value: s.id })))
const form = reactive<{ name: string, maxViewers: number, maxStreams: number, serverId: number | undefined }>({
  name: '', maxViewers: 50, maxStreams: 1, serverId: undefined,
})

async function load() {
  try {
    [plans.value, servers.value] = await Promise.all([
      api<Row[]>('/plans'),
      api<{ id: number, host: string }[]>('/servers'),
    ])
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createPlan() {
  if (!form.name || !form.serverId) return
  busy.value = true
  try {
    await api('/plans', { method: 'POST', body: JSON.stringify(form) })
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
async function savePlan(p: Row) {
  try {
    await api(`/plans/${p.id}`, {
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

async function removePlan(p: Row) {
  const ok = await ask({
    title: `Διαγραφή πλάνου «${p.name}»;`,
    // Το API το απορρίπτει με 409 όσο το κρατάει έστω ένας πελάτης — εδώ το λέμε
    // πριν, για να μην πατηθεί άσκοπα.
    description: p._count.subscriptions
      ? `Το έχουν ${p._count.subscriptions} συνδρομές — αφαίρεσέ το πρώτα από αυτές.`
      : 'Δεν το έχει καμία συνδρομή.',
  })
  if (!ok) return
  try {
    await api(`/plans/${p.id}`, { method: 'DELETE' })
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
      <h1>Πλάνα</h1>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <UCard>
      <template #header>
        <h2 class="mb-0">Νέο πλάνο</h2>
      </template>

      <form class="space-y-4" @submit.prevent="createPlan">
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
          Τα όρια είναι της <b>κάθε συνδρομής χωριστά</b> και δεν αθροίζονται: πελάτης με 2×
          «basic» των 50 θεατών έχει δύο πλάνα των 50, όχι ένα των 100. Τα «streams» είναι πόσα
          paths χωράει το πλάνο, όχι πόσα εκπέμπει ταυτόχρονα.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία πλάνου</UButton>
      </form>
    </UCard>

    <UCard v-for="p in plans" :key="p.id">
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
          Οι <b>{{ p._count.subscriptions }}</b> συνδρομές που υπάρχουν ήδη μένουν στον server
          τους — η αλλαγή <em>server</em> αφορά μόνο τις επόμενες. Έτσι γεμίζει ένα μηχάνημα και
          το πλάνο συνεχίζει στο επόμενο, χωρίς να μετακομίσει κανένας πελάτης. Τα <em>όρια</em>
          όμως τα ακολουθούν όλες, και οι παλιές.
        </p>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <span class="note">Συνδρομές σε αυτό το πλάνο: {{ p._count.subscriptions }}</span>
          <div class="flex gap-2">
            <UButton icon="i-lucide-save" color="neutral" variant="subtle" @click="savePlan(p)">Αποθήκευση</UButton>
            <UButton icon="i-lucide-trash-2" color="error" variant="ghost" @click="removePlan(p)">Διαγραφή</UButton>
          </div>
        </div>
      </div>
    </UCard>

    <UCard v-if="!plans.length">
      <div class="quiet">Κανένα πλάνο ακόμα</div>
    </UCard>
  </div>
</template>
