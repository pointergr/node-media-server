<script setup lang="ts">
import Hls from 'hls.js'

// Ο preview μετράει ως κανονικός HLS θεατής (cookie nmsv στο playlist), οπότε
// δεν ξεκινάει μόνος του — ένα dashboard ανοιχτό όλη μέρα θα φούσκωνε τους
// ίδιους αριθμούς που δείχνει.
const props = defineProps<{ src: string }>()

const video = ref<HTMLVideoElement>()
const started = ref(false)
let hls: Hls | null = null
let retry: ReturnType<typeof setTimeout> | undefined
let stall: ReturnType<typeof setTimeout> | undefined

function play() {
  started.value = true
  const el = video.value
  if (!el) return
  stop()
  // Το πρώτο segment αργεί λίγο μετά το postPublish· χωρίς retry ένα κλικ πολύ
  // νωρίς άφηνε μαύρο κουτί για πάντα. Ξαναπερνάει από εδώ, δεν κάνει σκέτο
  // loadSource: μετά από restart του OBS το playlist ξαναρχίζει από media
  // sequence 0 με καινούριο timeline, που μόνο καινούριο Hls το καθαρίζει.
  const again = () => retry = setTimeout(play, 3000)
  if (!Hls.isSupported()) {
    // Safari: δεν έχει MSE για TS, αλλά παίζει HLS native
    el.src = props.src
    el.play().catch(() => {})
    return
  }
  hls = new Hls()
  hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}))
  hls.on(Hls.Events.ERROR, (_, d) => d.fatal && again())
  hls.loadSource(props.src)
  hls.attachMedia(el)
  // Το κόλλημα μετά από restart του publisher δεν βγάζει fatal error — φαίνεται
  // μόνο ως waiting που δεν κλείνει ποτέ.
  el.onplaying = () => clearTimeout(stall)
  el.onwaiting = () => {
    clearTimeout(stall)
    stall = setTimeout(again, 10000)
  }
}

// Το hls.js συνεχίζει να ζητάει playlist όσο ζει, και τα timers ξαναστήνουν
// player πάνω σε <video> που έχει ήδη φύγει από το DOM.
function stop() {
  hls?.destroy()
  hls = null
  clearTimeout(retry)
  clearTimeout(stall)
}

onBeforeUnmount(stop)
</script>

<template>
  <div class="preview">
    <video ref="video" muted playsinline />
    <button v-if="!started" class="play" title="preview (μετράει ως θεατής)" @click="play">▶</button>
  </div>
</template>
