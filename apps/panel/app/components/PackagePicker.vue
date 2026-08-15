<script setup lang="ts">
// Ο κατάλογος των πακέτων με μια ποσότητα το καθένα (0 = δεν το έχει). Ίδιο
// κουτί και στη δημιουργία και στην επεξεργασία πελάτη — δύο αντίγραφα θα
// απέκλιναν στο πιο εύκολο σημείο να μη γίνει αντιληπτό, τα όρια.
// ponytail: δείχνει ΟΛΟΝ τον κατάλογο· με δεκάδες πακέτα θέλει select.
defineProps<{
  catalog: { id: number, name: string, maxViewers: number, maxStreams: number }[]
  totals: { viewers: number, streams: number }
}>()

// Το v-model είναι ο ίδιος reactive πίνακας ποσοτήτων (packageId -> qty) που
// κρατάει η σελίδα· γράφουμε μέσα του απευθείας.
const qty = defineModel<Record<number, number>>({ required: true })
</script>

<template>
  <div>
    <div class="text-xs text-dimmed mb-1">Πακέτα</div>

    <div v-if="catalog.length" class="flex flex-wrap gap-3">
      <div v-for="p in catalog" :key="p.id" class="flex items-center gap-2">
        <UInputNumber
          :model-value="qty[p.id] ?? 0" :min="0" class="w-28"
          :aria-label="`ποσότητα πακέτου ${p.name}`"
          @update:model-value="qty[p.id] = Number($event) || 0"
        />
        <div class="text-sm leading-tight">
          <div class="font-medium">{{ p.name }}</div>
          <div class="text-xs text-dimmed">{{ p.maxViewers }} θεατές · {{ p.maxStreams }} streams</div>
        </div>
      </div>
    </div>
    <div v-else class="note">
      Κανένα πακέτο ακόμα — φτιάξε ένα στα <NuxtLink to="/admin/packages" class="underline">Πακέτα</NuxtLink>.
    </div>

    <p class="note mt-2">
      Σύνολο:
      <template v-if="totals.viewers">
        <b>{{ totals.viewers }}</b> θεατές · <b>{{ totals.streams }}</b> streams
      </template>
      <template v-else>χωρίς πακέτο — χωρίς όρια</template>
    </p>
  </div>
</template>
