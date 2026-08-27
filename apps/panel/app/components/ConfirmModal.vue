<script setup lang="ts">
// Το κουτί επιβεβαίωσης για κάθε μη αναστρέψιμη ενέργεια. Δεν το στήνει καμία
// σελίδα μόνη της — το ανοίγει το useConfirm() μέσω του useOverlay, δες εκεί.
// Το συμβόλαιο του OverlayProvider: `v-model:open` από πάνω, `close` με την
// απάντηση από κάτω (Esc ή κλικ έξω = κλείσιμο χωρίς τιμή, δηλαδή άκυρο).
defineProps<{ title: string, description?: string, confirmLabel?: string }>()
const emit = defineEmits<{ close: [boolean] }>()
const open = defineModel<boolean>('open', { default: true })

// Esc, κλικ έξω και το X δεν περνάνε από τα κουμπιά: κλείνουν μόνο το modal.
// Χωρίς αυτό το watch, η υπόσχεση του useConfirm δεν έλυνε ποτέ — ο καλών έμενε
// να περιμένει για πάντα και το κλειστό modal δεν ξεφορτωνόταν ποτέ. Το διπλό
// emit μετά από κουμπί είναι ακίνδυνο: ο provider λύνει την υπόσχεση μία φορά.
watch(open, v => !v && emit('close', false))
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description">
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" @click="emit('close', false)">Άκυρο</UButton>
        <UButton color="error" @click="emit('close', true)">{{ confirmLabel ?? 'Διαγραφή' }}</UButton>
      </div>
    </template>
  </UModal>
</template>
