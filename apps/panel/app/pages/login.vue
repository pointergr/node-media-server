<script setup lang="ts">
definePageMeta({ layout: false }) // χωρίς header: δεν υπάρχει ακόμα ποιος να αποσυνδεθεί

const config = useRuntimeConfig()
const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

// Δύο δρόμοι για το ίδιο πράγμα — φόρμα και link από το billing — και ένα σημείο
// που κρατάει το token: αλλιώς ο ένας από τους δύο θα ξέχναγε το setToken ή το
// πού προσγειώνεται ο καθένας.
async function enter(path: string, body: object, failMsg: string) {
  busy.value = true
  error.value = ''
  try {
    const res = await fetch(config.public.apiBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(failMsg)
    const { access_token } = await res.json() as { access_token: string }
    setToken(access_token)
    // Ο admin δεν έχει clientId, άρα το /me/streams του είναι άδειο — δεν έχει
    // νόημα να προσγειώνεται στο user panel.
    await navigateTo(useSession()?.role === 'admin' ? '/admin' : '/')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

const submit = () => enter('/auth/login', { username: username.value, password: password.value }, 'λάθος όνομα χρήστη ή κωδικός')

// Link μιας χρήσης από το billing: `/login#t=<token>` (POST /auth/login-link).
// Στο fragment, οπότε δεν έφτασε ποτέ σε log του server — και το σβήνουμε από το
// URL πριν το ανταλλάξουμε, ώστε να μη μείνει στο ιστορικό ή σε copy-paste.
onMounted(() => {
  const t = new URLSearchParams(location.hash.slice(1)).get('t')
  if (!t) return
  history.replaceState(null, '', location.pathname)
  enter('/auth/exchange', { token: t }, 'ο σύνδεσμος σύνδεσης έληξε — μπες με τα στοιχεία σου')
})
</script>

<template>
  <UContainer class="flex min-h-screen items-center justify-center">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex flex-col items-center gap-3">
          <img src="/logo-dark.svg" alt="Pointer" class="h-9 w-auto dark:hidden">
          <img src="/logo-light.svg" alt="Pointer" class="hidden h-9 w-auto dark:block">
          <h1>Σύνδεση</h1>
        </div>
      </template>

      <form class="space-y-4" @submit.prevent="submit">
        <UFormField label="Όνομα χρήστη" name="username">
          <UInput v-model="username" autocomplete="username" autofocus required class="w-full" />
        </UFormField>
        <UFormField label="Κωδικός" name="password">
          <UInput v-model="password" type="password" autocomplete="current-password" required class="w-full" />
        </UFormField>

        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

        <UButton type="submit" block :loading="busy" icon="i-lucide-log-in">
          Σύνδεση
        </UButton>
      </form>
    </UCard>
  </UContainer>
</template>
