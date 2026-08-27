<script setup lang="ts">
// Ένα κουμπί αντιγραφής για όλο το panel: stream key και token στη διαχείριση,
// διεύθυνση RTMP και stream key στο panel του πελάτη.
const props = defineProps<{ text: string, label?: string }>()
const copied = ref(false)
const toast = useToast()

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  }
  catch {
    // http origin ή browser χωρίς Clipboard API: το κείμενο είναι επιλέξιμο
    // ούτως ή άλλως, οπότε ο χρήστης δεν μένει χωρίς τρόπο.
    toast.add({
      title: 'Η αντιγραφή απέτυχε',
      description: 'Διάλεξε το κείμενο και αντίγραψέ το με Ctrl+C.',
      color: 'warning',
      icon: 'i-lucide-triangle-alert',
    })
  }
}
</script>

<template>
  <UButton
    type="button" size="xs" color="neutral" variant="subtle"
    :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
    :label="label ?? (copied ? 'Αντιγράφηκε!' : 'Αντιγραφή')"
    @click="copy"
  />
</template>
