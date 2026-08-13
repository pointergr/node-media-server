<script setup lang="ts">
// Ο ρόλος διαβάζεται σε κάθε render του layout, όχι μία φορά στο boot: μετά το
// login το layout ξαναμπαίνει και πρέπει να δείξει τα σωστά links.
const session = computed(() => useSession())

function logout() {
  clearToken()
  navigateTo('/login')
}
</script>

<template>
  <div>
    <nav>
      <span class="brand">Pointer</span>
      <NuxtLink to="/">Τα streams μου</NuxtLink>
      <NuxtLink v-if="session?.role === 'admin'" to="/admin">Διαχείριση</NuxtLink>
      <NuxtLink v-if="session?.role === 'admin'" to="/admin/clients">Πελάτες</NuxtLink>
      <NuxtLink v-if="session?.role === 'admin'" to="/admin/servers">Servers</NuxtLink>
      <span class="spacer" />
      <span class="who">{{ session?.role === 'admin' ? 'διαχειριστής' : 'πελάτης' }}</span>
      <button @click="logout">Αποσύνδεση</button>
    </nav>
    <slot />
  </div>
</template>
