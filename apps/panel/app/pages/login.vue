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
  <UContainer class="flex min-h-screen items-center justify-center">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-radio" class="text-primary size-5" />
          <h1>Pointer — Σύνδεση</h1>
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
