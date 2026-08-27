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
        { label: 'API keys', icon: 'i-lucide-key-round', to: '/admin/apikeys' },
      ]
    : [{ label: 'Τα streams μου', icon: 'i-lucide-radio', to: '/' }]),
  // Τελευταία και για τους δύο ρόλους: οι οδηγίες τις διαβάζει και ο admin (τις
  // λέει στον πελάτη στο τηλέφωνο), και ο admin δεν έχει άλλο σημείο να αλλάξει
  // τον κωδικό που του έδωσε το seed.
  { label: 'Οδηγίες', icon: 'i-lucide-book-open', to: '/help' },
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
        <!-- Δύο αρχεία, όχι ένα με φίλτρο: το logo-dark έχει σκούρα γράμματα και
             χάνεται στο σκοτεινό θέμα, το logo-light λευκά και χάνεται στο φωτεινό. -->
        <img src="/logo-dark.svg" alt="Pointer" class="h-7 w-auto dark:hidden">
        <img src="/logo-light.svg" alt="Pointer" class="hidden h-7 w-auto dark:block">
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
        <!-- Χωρίς αυτή τη μπάρα ο admin δεν έχει δρόμο πίσω: η συνεδρία είναι
             πελάτη, οπότε το μενού διαχείρισης έχει εξαφανιστεί. -->
        <UAlert
          v-if="impersonating()"
          class="mb-6" color="warning" variant="subtle" icon="i-lucide-eye"
          title="Βλέπεις το panel ως πελάτης"
          description="Οι ενέργειες που κάνεις εδώ γίνονται στον λογαριασμό του."
        >
          <template #actions>
            <UButton color="warning" size="sm" icon="i-lucide-corner-up-left" @click="stopImpersonating()">
              Επιστροφή στη διαχείριση
            </UButton>
          </template>
        </UAlert>
        <slot />
      </UContainer>
    </UMain>
  </div>
</template>
