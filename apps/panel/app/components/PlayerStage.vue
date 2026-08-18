<script setup lang="ts">
import Hls from 'hls.js'

// Μεταφορά του παλιού `apps/stream/admin/player.html` (σβήστηκε στο Βήμα 4, ζει
// στο git: `git show eeb8fac^:apps/stream/admin/player.html`). Κάθε σχόλιο εδώ
// περιγράφει παθολογία που χτυπήθηκε σε πραγματική εκπομπή — μην απλοποιήσεις
// χωρίς να την ξαναδοκιμάσεις.
const props = defineProps<{
  src: string
  // Αυτόματη έναρξη μόνο εκεί που ο χρήστης ήρθε αποκλειστικά για να δει (σελίδα
  // player). Στο user panel κάθε player μετράει ως θεατής στο όριο του πελάτη,
  // οπότε ξεκινάει με κλικ.
  auto?: boolean
}>()

const wrap = ref<HTMLElement>()
const video = ref<HTMLVideoElement>()

const status = ref('')
const bad = ref(false)
const shown = ref(true) // ορατότητα της μπάρας
const stopped = ref(true)
const paused = ref(true) // αντίγραφο του video.paused, για το εικονίδιο
const muted = ref(true)
const volume = ref(1)
const live = ref<'off' | 'on' | 'behind'>('off')
const fsOn = ref(false)
// Οι διαθέσιμες ποιότητες του master playlist (κενό = εκπομπή χωρίς ladder) και
// η επιλογή του χρήστη· -1 = αυτόματο, δηλαδή ό,τι κρίνει το ABR του hls.js.
const levels = ref<{ i: number, label: string }[]>([])
const level = ref(-1)

let hls: Hls | null = null
let retry: ReturnType<typeof setTimeout> | undefined
let stall: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined

// Δύο ξεχωριστές έννοιες «σταματημένο»: το stopped (Stop, πραγματικό teardown) και
// το userPaused (ο χρήστης πάτησε pause). Και τα δύο μπλοκάρουν το auto-retry —
// αλλιώς ο stall detector ή το later() ζωντανεύουν μόνα τους ένα stream που ο
// χρήστης σταμάτησε επίτηδες.
let userPaused = false

// Fatal error ενώ ήταν σε pause: το ERROR handler δεν έκανε τίποτα ορατό (σωστά,
// δεν κάνουμε auto-resume), αλλά το hls instance μπορεί να έχει μείνει νεκρό. Το
// resumePlay() το ελέγχει για να ξέρει αν αρκεί play() ή χρειάζεται πλήρες load().
let pendingFatalError = false

// Πόσο πίσω από το live edge μετράει ακόμα ως «live» — λίγο πάνω από ένα segment
// (~2s), ώστε το φυσιολογικό jitter να μη γυρίζει το dot.
const LIVE_TOLERANCE = 4

// Πόσο αντέχουμε ένα waiting που δεν κλείνει — αρκετά πάνω από τα 2s του segment,
// ώστε ένα κανονικό rebuffer να μη μετράει ως κοπή.
const STALL_MS = 10000

const showPlay = computed(() => stopped.value || paused.value)

function say(msg: string, isBad = false) {
  status.value = msg
  bad.value = isBad
}

// --- ορατότητα μπάρας -------------------------------------------------------

// Αν παίζει κανονικά ξεκινάει countdown απόκρυψης, αλλιώς (pause/stopped) μένει
// μόνιμα ορατή — αλλιώς ο χρήστης βλέπει μαύρη οθόνη χωρίς τρόπο να ξαναπατήσει
// play.
function syncControls() {
  clearTimeout(hideTimer)
  if (holding || stopped.value || userPaused || video.value?.paused !== false) {
    shown.value = true
    return
  }
  hideTimer = setTimeout(() => shown.value = false, 2000)
}

// Κίνηση ποντικιού/tap: δείξε τη μπάρα και ξαναφόρτωσε το countdown απόκρυψης.
function nudge() {
  shown.value = true
  syncControls()
}

// Όσο είναι ανοιχτό το μενού ποιότητας η μπάρα δεν κρύβεται: το native dropdown
// δεν παράγει mousemove, οπότε το countdown θα έσβηνε τη μπάρα κάτω από το ίδιο
// το μενού που μόλις άνοιξε ο χρήστης.
let holding = false
function holdControls(on: boolean) {
  holding = on
  nudge()
}

// --- live edge --------------------------------------------------------------

function liveEdge(): number | null {
  if (hls?.liveSyncPosition != null) return hls.liveSyncPosition
  const el = video.value
  if (el?.seekable.length) return el.seekable.end(el.seekable.length - 1)
  return null
}

function jumpToLiveEdge() {
  const edge = liveEdge()
  if (edge != null && video.value) {
    try {
      video.value.currentTime = edge
    }
    catch {}
  }
}

function updateLive() {
  const edge = stopped.value ? null : liveEdge()
  live.value = edge == null
    ? 'off'
    : (edge - (video.value?.currentTime ?? 0)) > LIVE_TOLERANCE ? 'behind' : 'on'
}

function goLive() {
  if (live.value !== 'behind') return
  if (video.value?.paused) return resumePlay()
  jumpToLiveEdge()
}

// --- play / pause / stop ----------------------------------------------------

function userPause() {
  userPaused = true
  clearTimeout(stall) // σκόπιμο pause: ο stall detector δεν πρέπει να ξυπνήσει το stream
  video.value?.pause()
}

function resumePlay() {
  userPaused = false
  if (pendingFatalError) {
    // Το hls instance πέθανε ενώ ήμασταν σε pause· ένα σκέτο play() δεν θα κάνει
    // τίποτα ορατό. Πλήρες load() αντί για jump+play — το ίδιο μονοπάτι με stopped.
    pendingFatalError = false
    return load()
  }
  jumpToLiveEdge() // αλλιώς συνεχίζει από εκεί που πάγωσε και μένει μόνιμα πίσω από το live window
  video.value?.play().catch(() => say('πάτα play', true))
}

function togglePlay() {
  if (stopped.value) return load()
  if (video.value?.paused) return resumePlay()
  userPause()
}

function stop() {
  stopped.value = true
  userPaused = false
  clearTimeout(retry)
  clearTimeout(stall)
  hls?.destroy()
  hls = null
  const el = video.value
  if (el) {
    el.pause()
    el.removeAttribute('src')
    el.load() // καθαρίζει src/buffer — αλλιώς συνεχίζει να μετράει ως θεατής
  }
  paused.value = true
  levels.value = []
  level.value = -1
  updateLive()
  syncControls()
  say('σταματημένο')
}

// --- φόρτωση ----------------------------------------------------------------

// Το stream μπορεί να μην εκπέμπει ακόμα: ξαναδοκιμάζουμε αντί να πεθάνει η σελίδα.
function later() {
  if (stopped.value || userPaused) return // ίδιο guard με το onWaiting
  clearTimeout(retry)
  retry = setTimeout(load, 3000)
}

function load() {
  const el = video.value
  if (!el) return
  clearTimeout(retry)
  clearTimeout(stall)
  hls?.destroy()
  hls = null
  stopped.value = false
  userPaused = false
  pendingFatalError = false
  // Νέο manifest, νέα levels: ό,τι είχε διαλέξει ο χρήστης δεν αντιστοιχεί
  // απαραίτητα στους ίδιους δείκτες.
  levels.value = []
  level.value = -1
  say('σύνδεση…')
  updateLive()
  syncControls()

  // Πρώτα το hls.js, μετά το native — ποτέ ανάποδα. Το canPlayType δεν είναι
  // δήλωση υποστήριξης: ο Chrome απαντάει "maybe" στο vnd.apple.mpegurl χωρίς να
  // παίζει HLS, οπότε το <video src> έμενε για πάντα σε readyState 0 — χωρίς
  // error event, δηλαδή ούτε καν retry, μόνιμο «σύνδεση…».
  if (Hls.isSupported()) {
    hls = new Hls()
    hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
      // Ο hls.js κάνει ABR μόνος του αλλά δεν δίνει κανένα UI: χωρίς αυτό ο
      // θεατής βλέπει τις αναλύσεις μόνο στο playlist, ποτέ στην οθόνη.
      levels.value = qualityLevels(d.levels)
      el.play().catch(() => say('πάτα play', true))
    })
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || stopped.value) return
      // Ο πελάτης δεν διαβάζει «manifestLoadError»: 404 στο playlist σημαίνει ότι
      // ο publisher δεν εκπέμπει (ή δεν ξεκίνησε ακόμα το πρώτο segment).
      const why = d.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
        ? 'δεν εκπέμπει'
        : d.details
      if (userPaused) {
        // Σκόπιμο pause: ενημέρωσε το status αλλά μη ξαναρχίσεις μόνη της την
        // αναπαραγωγή. Το later() θα το μπλόκαρε ούτως ή άλλως, αλλά το «νέα
        // προσπάθεια…» θα ήταν ψέμα αν δεν προσπαθήσουμε πραγματικά.
        pendingFatalError = true
        return say(`${why} (σε παύση, δεν συνεχίζει μόνο του)`, true)
      }
      say(`${why}, νέα προσπάθεια…`, true)
      later()
    })
    hls.loadSource(props.src)
    hls.attachMedia(el)
    return
  }

  // Safari: δεν έχει MSE για TS, αλλά παίζει HLS native
  if (!el.canPlayType('application/vnd.apple.mpegurl')) {
    return say('ο browser δεν υποστηρίζει HLS', true)
  }
  el.src = props.src
  el.onerror = () => {
    if (stopped.value) return
    if (userPaused) {
      pendingFatalError = true
      return say('σφάλμα φόρτωσης (σε παύση, δεν συνεχίζει μόνο του)', true)
    }
    say('δεν παίζει, νέα προσπάθεια…', true)
    later()
  }
  el.play().catch(() => say('πάτα play', true))
}

// Άμεση αλλαγή (currentLevel) και όχι στο επόμενο fragment (nextLevel): ο χρήστης
// που μόλις διάλεξε ποιότητα περιμένει να τη δει τώρα, όχι σε δύο δευτερόλεπτα.
function applyLevel() {
  if (hls) hls.currentLevel = level.value
  nudge()
}

// --- events του <video> -----------------------------------------------------

function onPlaying() {
  clearTimeout(stall)
  pendingFatalError = false // αν αυτοθεραπεύτηκε χωρίς νέο load(), δεν είναι πια νεκρό
  paused.value = false
  const el = video.value!
  say(`live · ${el.videoWidth}x${el.videoHeight}`)
  syncControls()
}

// Restart του OBS: το postPublish σβήνει τον φάκελο κι ο ffmpeg ξαναρχίζει από
// media sequence 0 με καινούριο timeline. Ο hls.js δεν το θεωρεί σφάλμα — απλώς
// βάζει τα νέα fragments πίσω από το currentTime και η αναπαραγωγή κολλάει για
// πάντα, χωρίς ποτέ fatal error. Το μόνο αξιόπιστο σημάδι είναι ένα waiting που
// δεν κλείνει, και ξεκολλάει μόνο με καινούριο Hls (το loadSource πάνω στο ίδιο
// instance κρατάει το παλιό timeline).
function onWaiting() {
  if (stopped.value || userPaused) return // σκόπιμο pause/stop: δεν είναι κόλλημα
  clearTimeout(stall)
  stall = setTimeout(() => {
    say('το stream κόπηκε, επανασύνδεση…', true)
    load()
  }, STALL_MS)
}

function onVolume() {
  const el = video.value!
  muted.value = el.muted
  volume.value = el.volume
}

function setVolume(ev: Event) {
  const el = video.value!
  el.volume = Number((ev.target as HTMLInputElement).value)
  el.muted = el.volume === 0
  nudge()
}

// --- fullscreen -------------------------------------------------------------

// Fullscreen στο wrapper, όχι στο <video>: αν ζητηθεί στο ίδιο το video element,
// το overlay μας μένει έξω από το fullscreen surface και εξαφανίζεται.
// Τα webkit-prefixed δεν υπάρχουν στα lib.dom types — casts αντί για δηλώσεις.
function toggleFs() {
  const doc = document as any
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)
    return
  }
  const el = wrap.value as any
  const v = video.value as any
  if (el?.requestFullscreen) el.requestFullscreen()
  else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen()
  else if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen() // iOS Safari: μόνο το <video>
}

// Το iOS webkitEnterFullscreen() βάζει fullscreen στο ίδιο το <video>, όχι στο
// document — το webkitDisplayingFullscreen είναι το μόνο σημάδι εκεί. Ο έλεγχος
// γίνεται με ταυτότητα στοιχείου: σε σελίδα με πολλούς players, το fullscreen του
// ενός δεν πρέπει να γυρίζει το εικονίδιο των άλλων.
function updateFs() {
  const doc = document as any
  const el = doc.fullscreenElement || doc.webkitFullscreenElement
  fsOn.value = (!!el && el === wrap.value) || !!(video.value as any)?.webkitDisplayingFullscreen
}

// --- πληκτρολόγιο -----------------------------------------------------------

// Στο παλιό player ήταν σε document listener — εδώ στο wrapper (tabindex 0),
// γιατί στο user panel υπάρχουν πολλοί players στην ίδια σελίδα και το space θα
// τους πείραζε όλους μαζί.
function onKey(e: KeyboardEvent) {
  // Focus σε κουμπί/slider της μπάρας πρέπει να πάει το space/enter στο ίδιο το
  // στοιχείο — αλλιώς π.χ. focus στο mute κάνει ταυτόχρονα toggle mute (native)
  // ΚΑΙ togglePlay (shortcut).
  if ((e.target as HTMLElement).closest('input, button, select, textarea')) return
  const key = e.key.toLowerCase()
  if (key === ' ' || key === 'k') {
    e.preventDefault()
    togglePlay()
  }
  else if (key === 'm') {
    const el = video.value!
    el.muted = !el.muted
  }
  else if (key === 'f') { toggleFs() }
}

onMounted(() => {
  document.addEventListener('fullscreenchange', updateFs)
  document.addEventListener('webkitfullscreenchange', updateFs)
  // iOS Safari: το webkitEnterFullscreen() πυροδοτεί αυτά πάνω στο <video>, ποτέ
  // document-level webkitfullscreenchange — χωρίς αυτά το εικονίδιο κολλάει.
  video.value?.addEventListener('webkitbeginfullscreen', updateFs)
  video.value?.addEventListener('webkitendfullscreen', updateFs)
  if (props.auto) load()
  else say('πάτα play — όσο παίζει, μετράει ως θεατής')
})

onBeforeUnmount(() => {
  stop()
  document.removeEventListener('fullscreenchange', updateFs)
  document.removeEventListener('webkitfullscreenchange', updateFs)
})

// Αλλαγή stream χωρίς remount (π.χ. πλοήγηση από /admin/streams/a σε /b): το
// παλιό instance θα συνέχιζε να κατεβάζει το προηγούμενο playlist.
watch(() => props.src, () => {
  const wasPlaying = !stopped.value
  stop()
  if (props.auto || wasPlaying) load()
})
</script>

<template>
  <div class="stage">
    <div
      ref="wrap" class="player" tabindex="0"
      @mousemove="nudge" @touchstart.passive="nudge" @keydown="onKey"
    >
      <video
        ref="video" muted playsinline
        @click="nudge" @play="paused = false; syncControls()" @pause="paused = true; syncControls()"
        @playing="onPlaying" @waiting="onWaiting" @timeupdate="updateLive" @volumechange="onVolume"
      />
      <div class="controls" :class="{ show: shown }">
        <button class="ctl" title="Play / Pause (space)" aria-label="Play / Pause" @click="togglePlay">
          <svg v-if="showPlay" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
        </button>
        <button class="ctl" title="Stop" aria-label="Stop" @click="stop">
          <svg width="18" height="18" viewBox="0 0 24 24"><rect fill="currentColor" x="6" y="6" width="12" height="12" /></svg>
        </button>
        <button class="ctl" title="Σίγαση (m)" aria-label="Σίγαση" @click="video && (video.muted = !video.muted)">
          <svg v-if="!muted" width="18" height="18" viewBox="0 0 24 24">
            <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z" />
            <path fill="none" stroke="currentColor" stroke-width="2" d="M16.5 8.5a5 5 0 0 1 0 7" />
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24">
            <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z" />
            <path fill="none" stroke="currentColor" stroke-width="2" d="M15.5 9.5l5 5m0-5l-5 5" />
          </svg>
        </button>
        <!-- Το drag πάνω στο slider δεν παράγει mousemove πάνω στο .player αν το
             ποντίκι μένει ακίνητο στο thumb ενώ αλλάζει η τιμή — κρατάμε τη μπάρα
             ορατή από εδώ. -->
        <input
          class="volume" type="range" min="0" max="1" step="0.05" title="Ένταση"
          :value="muted ? 0 : volume" @pointerdown="nudge" @input="setVolume"
        >
        <select
          v-if="levels.length" v-model="level" class="quality" title="Ποιότητα" aria-label="Ποιότητα"
          @change="applyLevel" @focus="holdControls(true)" @blur="holdControls(false)"
        >
          <option :value="-1">αυτόματο</option>
          <option v-for="l in levels" :key="l.i" :value="l.i">{{ l.label }}</option>
        </select>
        <span class="spacer" />
        <button
          class="live" :class="live" :disabled="live !== 'behind'" title="Live edge"
          @click="goLive"
        >
          <span class="livedot" />LIVE
        </button>
        <button class="ctl" title="Πλήρης οθόνη (f)" aria-label="Πλήρης οθόνη" @click="toggleFs">
          <svg v-if="!fsOn" width="18" height="18" viewBox="0 0 24 24">
            <path fill="none" stroke="currentColor" stroke-width="2" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24">
            <path fill="none" stroke="currentColor" stroke-width="2" d="M9 4v5H4M15 4v5h5M20 20v-5h-5M4 20v-5h5" />
          </svg>
        </button>
      </div>
    </div>
    <div class="status" :class="{ bad }">
      <span class="dot" :class="{ on: !bad && !stopped }" />{{ status }}
    </div>
  </div>
</template>

<style scoped>
/* Ο wrapper είναι το target του fullscreen (όχι το <video>) και το αγκυροβόλιο
   του overlay — δες σημείωση στο toggleFs(). */
/* Χωρίς outline: none — το focus ring το θέλει το πληκτρολόγιο (space/m/f
   δουλεύουν όταν ο player έχει το focus) και οι browsers το δείχνουν ούτως ή
   άλλως μόνο σε :focus-visible. */
.player { position: relative; }
video { width: 100%; aspect-ratio: 16 / 9; background: #000; display: block; }
.player:fullscreen video { border-radius: 0; }

/* Λευκά εικονίδια σκόπιμα εκτός --text-* tokens: η μπάρα κάθεται πάνω σε μαύρο
   βίντεο και σε light theme, όχι πάνω στο --surface-1 του card. */
.controls {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center;
  gap: 4px; padding: 8px 10px; color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, .75), rgba(0, 0, 0, 0) 100%);
  opacity: 0; transition: opacity .2s ease; pointer-events: none;
}
.controls.show { opacity: 1; pointer-events: auto; }
/* :focus-within θα έδειχνε τη μπάρα και σε mouse click πάνω σε κουμπί (το click
   δίνει focus), παγώνοντάς την μόνιμα. Το :focus-visible διακρίνει keyboard από
   mouse focus — το :has() είναι το μόνο σημείο που «βλέπει» focus-visible σε παιδί
   από τον γονέα. Σε browser χωρίς :has() ο κανόνας αγνοείται και το πληκτρολόγιο
   πέφτει πίσω στο nudge(). */
.player:focus-visible .controls,
.player:has(:focus-visible) .controls { opacity: 1; pointer-events: auto; }
.ctl {
  background: none; border: none; color: #fff; padding: 4px; border-radius: 4px;
  display: inline-flex; cursor: pointer;
}
.ctl:hover { color: #fff; background: rgba(255, 255, 255, .15); }
.quality {
  background: rgba(255, 255, 255, .15); border: none; color: #fff; font-size: 12px;
  padding: 3px 4px; border-radius: 4px; cursor: pointer;
}
/* Το ίδιο το dropdown το ζωγραφίζει το λειτουργικό σε λευκό φόντο — χωρίς αυτό
   οι επιλογές βγαίνουν λευκές πάνω σε λευκό. */
.quality option { color: initial; background: #fff; }
.volume { width: 70px; min-width: 0; padding: 0; background: none; border: none; accent-color: #fff; }
.spacer { flex: 1; }
.live {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
  letter-spacing: .02em; background: none; border: none; color: #fff; padding: 4px;
}
.live:disabled { cursor: default; opacity: .6; }
.livedot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, .4); }
.live.on .livedot { background: #2ecc71; }
.live.behind .livedot { background: #fff; }

.status {
  display: flex; align-items: center; gap: 8px; padding: 10px 16px;
  font-size: 13px; color: var(--text-secondary);
}
.status.bad { color: var(--live); }
</style>
