<script setup lang="ts">
// Ο διάδοχος του παλιού `apps/stream/admin/player.html`. Το `id` είναι το
// streamPath με leading slash, url-encoded (το dashboard δίνει
// `/admin/streams/<encodeURIComponent(stream)>?host=<host>`) — ο vue-router το
// αποκωδικοποιεί μόνος του. Ο server έρχεται από το query, γιατί το ίδιο path
// μπορεί να υπάρχει σε δύο stream servers.
import { hlsUrl } from '~/utils/dash'

const route = useRoute()

const stream = computed(() => String(route.params.id ?? ''))
const host = computed(() => String(route.query.host ?? ''))

const src = computed(() => hlsUrl(host.value, stream.value))
</script>

<template>
  <div class="space-y-4">
    <header>
      <UIcon name="i-lucide-monitor-play" class="text-primary size-5" />
      <h1>{{ stream }}</h1>
      <span class="host">{{ host }}</span>
      <span class="spacer" />
      <UButton to="/admin" icon="i-lucide-chart-line" color="neutral" variant="subtle" size="sm">
        στατιστικά
      </UButton>
    </header>

    <UCard v-if="!host">
      <div class="quiet">Λείπει ο server από τη διεύθυνση — άνοιξε τον player από το dashboard.</div>
    </UCard>
    <UCard v-else :ui="{ body: 'p-0 sm:p-0' }" class="overflow-hidden">
      <PlayerStage :src="src" auto />
    </UCard>

    <UAlert
      color="neutral" variant="subtle" icon="i-lucide-info"
      description="Ο player μετράει ως κανονικός θεατής στα στατιστικά όσο παίζει — το Stop σταματάει πραγματικά τη λήψη, το pause όχι. Το muted είναι απαραίτητο για να ξεκινάει η αναπαραγωγή χωρίς κλικ· ήχος/παύση/fullscreen από τη μπάρα πάνω στο βίντεο (ή space, m, f όταν ο player έχει το focus)."
    />
  </div>
</template>
