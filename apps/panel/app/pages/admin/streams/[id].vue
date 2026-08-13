<script setup lang="ts">
// Ο διάδοχος του παλιού `apps/stream/admin/player.html`. Το `id` είναι το
// streamPath με leading slash, url-encoded (το dashboard δίνει
// `/admin/streams/<encodeURIComponent(stream)>?host=<host>`) — ο vue-router το
// αποκωδικοποιεί μόνος του. Ο server έρχεται από το query, γιατί το ίδιο path
// μπορεί να υπάρχει σε δύο stream servers.
const route = useRoute()

const stream = computed(() => String(route.params.id ?? ''))
const host = computed(() => String(route.query.host ?? ''))

// Ίδιος κανόνας με το dashboard: ο stream server σερβίρει το HLS από το hostname
// με το οποίο δηλώνεται στο panel.
const src = computed(() => `https://${host.value}/${stream.value.replace(/^\//, '')}/index.m3u8`)
</script>

<template>
  <div>
    <header>
      <h1>{{ stream }}</h1>
      <span class="host">{{ host }}</span>
      <span class="spacer" />
      <NuxtLink to="/admin">στατιστικά</NuxtLink>
    </header>

    <div v-if="!host" class="card">
      <div class="quiet">Λείπει ο server από τη διεύθυνση — άνοιξε τον player από το dashboard.</div>
    </div>
    <div v-else class="card player-card">
      <PlayerStage :src="src" auto />
    </div>

    <p class="note">
      Ο player μετράει ως κανονικός θεατής στα στατιστικά όσο παίζει — το Stop σταματάει
      πραγματικά τη λήψη, το pause όχι. Το muted είναι απαραίτητο για να ξεκινάει η
      αναπαραγωγή χωρίς κλικ· ήχος/παύση/fullscreen από τη μπάρα πάνω στο βίντεο (ή space,
      m, f όταν ο player έχει το focus).
    </p>
  </div>
</template>

<style scoped>
/* Το βίντεο πιάνει όλο το πλάτος της κάρτας, τα paddings μόνο γύρω από το status. */
.player-card { padding: 0; overflow: hidden; }
</style>
