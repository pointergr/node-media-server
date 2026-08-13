<script setup lang="ts">
// Μικρό κοινό κουμπί αντιγραφής — το χρειάζονται clients.vue (stream key) και
// servers.vue (token, μπλοκ config.json). Πρόθεμα Admin* γιατί ζει έξω από τα
// αρχεία της αρχικής σελίδας διαχείρισης.
const props = defineProps<{ text: string }>()
const copied = ref(false)

async function copy() {
  await navigator.clipboard.writeText(props.text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <button type="button" @click="copy">{{ copied ? 'Αντιγράφηκε!' : 'Αντιγραφή' }}</button>
</template>
