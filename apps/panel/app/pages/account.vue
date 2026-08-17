<script setup lang="ts">
// Ο λογαριασμός του συνδεδεμένου χρήστη, admin ή πελάτη αδιάκριτα: το API παίρνει
// το id από το token (PATCH /auth/me), οπότε δεν υπάρχει τίποτα να διαλέξει η
// σελίδα — και για τον admin είναι ο μόνος τρόπος να αλλάξει τον κωδικό του seed.
const api = useApi()
// Το username δεν είναι στο JWT (θα έμενε στάλε μετά από αλλαγή), οπότε το
// ρωτάμε — αλλιώς η οθόνη δεν δείχνει πουθενά ποιος είναι συνδεδεμένος.
const username = ref('')
onMounted(async () => {
  username.value = (await api<{ username: string }>('/auth/me')).username
})
const form = reactive({ currentPassword: '', username: '', password: '' })
const error = ref('')
const done = ref(false)
const busy = ref(false)

async function submit() {
  if (!form.username && !form.password) {
    error.value = 'συμπλήρωσε νέο όνομα χρήστη ή νέο κωδικό'
    return
  }
  busy.value = true
  error.value = ''
  done.value = false
  try {
    // Μόνο τα συμπληρωμένα: το API δεν αγγίζει ό,τι δεν του σταλεί.
    const body: Record<string, string> = { currentPassword: form.currentPassword }
    if (form.username) body.username = form.username
    if (form.password) body.password = form.password
    await api('/auth/me', { method: 'PATCH', body: JSON.stringify(body) })
    // Το token μένει έγκυρο (το payload δεν αλλάζει) — καμία αποσύνδεση.
    if (form.username) username.value = form.username
    Object.assign(form, { currentPassword: '', username: '', password: '' })
    done.value = true
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-user-cog" class="text-primary size-5" />
      <h1>Ο λογαριασμός μου</h1>
    </div>

    <UCard class="max-w-lg">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-at-sign" class="text-muted size-4" />
          <span class="note">Συνδεδεμένος ως</span>
          <strong>{{ username || '…' }}</strong>
        </div>
      </template>

      <form class="space-y-4" @submit.prevent="submit">
        <UFormField label="Τρέχων κωδικός" hint="απαιτείται">
          <UInput
            v-model="form.currentPassword" type="password" autocomplete="current-password"
            required class="w-full"
          />
        </UFormField>

        <UFormField label="Νέο όνομα χρήστη">
          <UInput v-model="form.username" autocomplete="off" placeholder="κενό = αμετάβλητο" class="w-full" />
        </UFormField>
        <UFormField label="Νέος κωδικός">
          <UInput
            v-model="form.password" type="password" autocomplete="new-password"
            placeholder="κενό = αμετάβλητος" class="w-full"
          />
        </UFormField>

        <p class="note">
          Ο τρέχων κωδικός ζητείται ξανά επίτηδες: μια συνεδρία που έμεινε ανοιχτή σε ξένο
          μηχάνημα δεν πρέπει να μπορεί να αλλάξει τα στοιχεία σύνδεσης. Η συνεδρία δεν κόβεται
          μετά την αλλαγή — ο νέος κωδικός χρειάζεται στην επόμενη σύνδεση.
        </p>

        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />
        <UAlert
          v-if="done" color="success" variant="subtle" icon="i-lucide-circle-check"
          description="Τα στοιχεία σύνδεσης άλλαξαν."
        />

        <UButton type="submit" icon="i-lucide-save" :loading="busy">Αποθήκευση</UButton>
      </form>
    </UCard>
  </div>
</template>
