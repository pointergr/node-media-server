<script setup lang="ts">
// Το stream key φαίνεται κρυμμένο: το panel το ανοίγει ο πελάτης σε οθόνη που
// βλέπουν κι άλλοι (screen sharing, γραφείο) και το κλειδί είναι ό,τι και ο
// κωδικός. Η αντιγραφή δεν περνάει από εδώ — το CopyButton έχει το ίδιο text,
// άρα δουλεύει και κρυμμένο.
defineProps<{ text: string }>()
const show = ref(false)
</script>

<template>
  <UInput
    :model-value="text" :type="show ? 'text' : 'password'" readonly
    size="xs" class="flex-1 min-w-0" :ui="{ base: 'font-mono' }"
  >
    <template #trailing>
      <UButton
        :icon="show ? 'i-lucide-eye-off' : 'i-lucide-eye'"
        size="xs" color="neutral" variant="link"
        :aria-label="show ? 'Απόκρυψη κλειδιού' : 'Εμφάνιση κλειδιού'"
        :title="show ? 'Απόκρυψη κλειδιού' : 'Εμφάνιση κλειδιού'"
        @click="show = !show"
      />
    </template>
  </UInput>
</template>
