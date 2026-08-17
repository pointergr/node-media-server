<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

// Ο ρόλος διαβάζεται σε κάθε render του layout, όχι μία φορά στο boot: μετά το
// login το layout ξαναμπαίνει και πρέπει να δείξει τα σωστά links.
const session = computed(() => useSession())
const admin = computed(() => session.value?.role === 'admin')

const items = computed<NavigationMenuItem[]>(() => [
  // Το «Τα streams μου» μόνο στον πελάτη: ο admin δεν έχει clientId, το `/` τον
  // στέλνει στο `/admin` (pages/index.vue) — δύο links στην ίδια σελίδα.
  ...(admin.value
    ? [
        { label: 'Διαχείριση', icon: 'i-lucide-activity', to: '/admin' },
        { label: 'Πελάτες', icon: 'i-lucide-users', to: '/admin/clients' },
        { label: 'Πλάνα', icon: 'i-lucide-package', to: '/admin/plans' },
        { label: 'Servers', icon: 'i-lucide-server', to: '/admin/servers' },
      ]
    : [{ label: 'Τα streams μου', icon: 'i-lucide-radio', to: '/' }]),
  // Τελευταίο και για τους δύο ρόλους: ο admin δεν έχει άλλο σημείο να αλλάξει
  // τον κωδικό που του έδωσε το seed.
  { label: 'Ο λογαριασμός μου', icon: 'i-lucide-user-cog', to: '/account' },
])

// Ο διακόπτης θέματος γράφει στο color-mode του Nuxt UI, που βάζει την κλάση
// `.dark` — την ίδια που ακολουθούν και τα χρώματα των γραφημάτων (dashboard.css).
const colorMode = useColorMode()
const dark = computed({
  get: () => colorMode.value === 'dark',
  set: v => colorMode.preference = v ? 'dark' : 'light',
})

function logout() {
  clearToken()
  navigateTo('/login')
}
</script>

<template>
  <div>
    <UHeader :ui="{ container: 'max-w-(--ui-container)' }">
      <template #title>
        <span class="font-semibold">Pointer</span>
      </template>

      <UNavigationMenu :items="items" />

      <template #right>
        <UBadge variant="subtle" :color="admin ? 'primary' : 'neutral'" size="sm">
          {{ admin ? 'διαχειριστής' : 'πελάτης' }}
        </UBadge>
        <UButton
          :icon="dark ? 'i-lucide-moon' : 'i-lucide-sun'"
          color="neutral" variant="ghost"
          :aria-label="dark ? 'φωτεινό θέμα' : 'σκοτεινό θέμα'"
          @click="dark = !dark"
        />
        <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" @click="logout">
          Αποσύνδεση
        </UButton>
      </template>

      <!-- Το ίδιο μενού μέσα στο συρτάρι του κινητού: χωρίς αυτό το burger ανοίγει άδειο. -->
      <template #body>
        <UNavigationMenu :items="items" orientation="vertical" />
      </template>
    </UHeader>

    <UMain>
      <UContainer class="py-6">
        <slot />
      </UContainer>
    </UMain>
  </div>
</template>
