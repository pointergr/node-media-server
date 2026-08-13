<script setup lang="ts">
definePageMeta({ layout: false }) // χωρίς header: δεν υπάρχει ακόμα ποιος να αποσυνδεθεί

const config = useRuntimeConfig()
const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    const res = await fetch(config.public.apiBase + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    })
    if (!res.ok) throw new Error('λάθος όνομα χρήστη ή κωδικός')
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
</script>

<template>
  <form class="login card" @submit.prevent="submit">
    <h1>Σύνδεση</h1>
    <label for="u">Όνομα χρήστη</label>
    <input id="u" v-model="username" autocomplete="username" autofocus required>
    <label for="p">Κωδικός</label>
    <input id="p" v-model="password" type="password" autocomplete="current-password" required>
    <button :disabled="busy">{{ busy ? 'σύνδεση…' : 'Σύνδεση' }}</button>
    <p v-if="error" class="error">{{ error }}</p>
  </form>
</template>
