<script setup lang="ts">
// CRUD πακέτων: ό,τι πουλάμε, με τα όριά του. Ο πελάτης παίρνει όσα θέλει, και
// σε όποια ποσότητα — τα όρια αθροίζονται (δες admin/clients.vue).
interface PackageRow {
  id: number
  name: string
  maxViewers: number
  maxStreams: number
  _count: { clients: number }
}

const api = useApi()
const ask = useConfirm()
const packages = ref<PackageRow[]>([])
const error = ref('')
const busy = ref(false)

const form = reactive({ name: '', maxViewers: 50, maxStreams: 1 })

async function load() {
  try {
    packages.value = await api<PackageRow[]>('/packages')
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

async function createPackage() {
  if (!form.name) return
  busy.value = true
  try {
    await api('/packages', { method: 'POST', body: JSON.stringify(form) })
    Object.assign(form, { name: '', maxViewers: 50, maxStreams: 1 })
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
async function savePackage(p: PackageRow) {
  try {
    await api(`/packages/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: p.name, maxViewers: p.maxViewers, maxStreams: p.maxStreams }),
    })
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    await load()
  }
}

async function removePackage(p: PackageRow) {
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
        <div class="grid gap-4 sm:grid-cols-3">
          <UFormField label="Όνομα">
            <UInput v-model="form.name" placeholder="basic" required class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστοι θεατές">
            <UInputNumber v-model="form.maxViewers" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστα streams">
            <UInputNumber v-model="form.maxStreams" :min="1" class="w-full" />
          </UFormField>
        </div>

        <p class="note">
          Τα όρια είναι ανά πακέτο και αθροίζονται: πελάτης με 2× «basic» των 50 θεατών έχει 100.
          Πελάτης <b>χωρίς</b> πακέτο δεν έχει όριο. Τα «streams» είναι πόσα paths μπορεί να έχει,
          όχι πόσα εκπέμπει ταυτόχρονα.
        </p>

        <UButton type="submit" icon="i-lucide-plus" :loading="busy">Δημιουργία πακέτου</UButton>
      </form>
    </UCard>

    <UCard v-for="p in packages" :key="p.id">
      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-3">
          <UFormField label="Όνομα">
            <UInput v-model="p.name" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστοι θεατές">
            <UInputNumber v-model="p.maxViewers" :min="1" class="w-full" />
          </UFormField>
          <UFormField label="Μέγιστα streams">
            <UInputNumber v-model="p.maxStreams" :min="1" class="w-full" />
          </UFormField>
        </div>

        <div class="flex items-center justify-between gap-3 flex-wrap">
          <span class="note">Πελάτες με αυτό το πακέτο: {{ p._count.clients }}</span>
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
