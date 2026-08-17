<script setup lang="ts">
// Οι αγορές του πελάτη, μία γραμμή ανά (πακέτο, server): 0 = δεν το έχει. Ίδιο
// κουτί και στη δημιουργία και στην επεξεργασία πελάτη — δύο αντίγραφα θα
// απέκλιναν στο πιο εύκολο σημείο να μη γίνει αντιληπτό, τα όρια.
// ponytail: δείχνει ΟΛΟΝ τον κατάλογο· με δεκάδες πακέτα θέλει select.
const props = defineProps<{
  catalog: PackageRow[]
  servers: { id: number, host: string }[]
}>()

// Το v-model είναι ο ίδιος reactive πίνακας γραμμών που κρατάει η σελίδα·
// γράφουμε μέσα του απευθείας (δες packageLines).
const lines = defineModel<PackageLine[]>({ required: true })

const nameOf = (id: number) => props.catalog.find(p => p.id === id)
const hostOf = (id: number) => props.servers.find(s => s.id === id)?.host ?? `server #${id}`
// Τα σύνολα είναι ανά μηχάνημα: ο πελάτης μπορεί να έχει αγορές σε δύο, και το
// ένα δεν δανείζει θεατές στο άλλο.
const totals = computed(() => Object.entries(totalsByServer(lines.value, props.catalog)))
</script>

<template>
  <div>
    <div class="text-xs text-dimmed mb-1">Πακέτα</div>

    <div v-if="lines.length" class="flex flex-wrap gap-3">
      <div v-for="line in lines" :key="`${line.packageId}:${line.serverId}`" class="flex items-center gap-2">
        <UInputNumber
          :model-value="line.qty" :min="0" class="w-28"
          :aria-label="`ποσότητα πακέτου ${nameOf(line.packageId)?.name} στον ${hostOf(line.serverId)}`"
          @update:model-value="line.qty = Number($event) || 0"
        />
        <div class="text-sm leading-tight">
          <div class="font-medium">
            {{ nameOf(line.packageId)?.name }}
            <span class="host">{{ hostOf(line.serverId) }}</span>
          </div>
          <div class="text-xs text-dimmed">
            {{ nameOf(line.packageId)?.maxViewers }} θεατές · {{ nameOf(line.packageId)?.maxStreams }} streams
          </div>
        </div>
      </div>
    </div>
    <div v-else class="note">
      Κανένα πακέτο ακόμα — φτιάξε ένα στα <NuxtLink to="/admin/packages" class="underline">Πακέτα</NuxtLink>.
    </div>

    <p class="note mt-2">
      <template v-if="totals.length">
        Σύνολο ανά server:
        <template v-for="([serverId, t], i) in totals" :key="serverId">
          <template v-if="i"> · </template>
          <b>{{ hostOf(Number(serverId)) }}</b>: {{ t.viewers }} θεατές, {{ t.streams }} streams
        </template>
      </template>
      <template v-else>χωρίς πακέτο — χωρίς όρια, και χωρίς server</template>
    </p>
  </div>
</template>
