<script setup lang="ts">
// User panel (Βήμα 5 του PLAN-monorepo.md): ό,τι χρειάζεται ο πελάτης για να
// εκπέμψει και να δει την εκπομπή του. Μοναδική πηγή το `GET /me/streams` — το
// API φιλτράρει με το clientId του token, οπότε εδώ δεν υπάρχει κώδικας που να
// μπορεί να δείξει ξένο stream.
const api = useApi()

interface MyStream {
  path: string
  key: string
  streamKey: string // «όνομα?key=…», έτοιμο για το πεδίο Stream Key του OBS
  limit: number // 0 = χωρίς όριο, αθροιστικά σε όλα τα paths του πελάτη
  viewers: number
  // Ο server δεν έρχεται σήμερα από το /me/streams. Χωρίς αυτόν δεν υπάρχει
  // διεύθυνση ούτε για το HLS ούτε για το RTMP — δείχνουμε οδηγία αντί για
  // μαντεψιά (δες σχόλιο στο template).
  host?: string
}

const streams = ref<MyStream[]>([])
const error = ref('')
const copied = ref('')

// Το playlist ζει στον stream server, όχι στο domain του panel.
const hls = (s: MyStream) => `https://${s.host}/${s.path.replace(/^\//, '')}/index.m3u8`

// Το RTMP ακούει στο `rtmp.<domain>` του ίδιου server (apps/stream/Caddyfile) και
// το application είναι το πρώτο κομμάτι του path — `/live/foo` → `live`.
const rtmp = (s: MyStream) => `rtmp://rtmp.${s.host}/${s.path.split('/')[1]}`

async function copy(text: string, id: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = id
    setTimeout(() => copied.value === id && (copied.value = ''), 2000)
  }
  catch {
    // http origin ή browser χωρίς Clipboard API: το πεδίο είναι επιλέξιμο ούτως
    // ή άλλως, οπότε δεν μένει ο χρήστης χωρίς τρόπο.
    error.value = 'η αντιγραφή απέτυχε — διάλεξε το κείμενο και αντίγραψέ το με Ctrl+C'
  }
}

async function load() {
  try {
    streams.value = await api<MyStream[]>('/me/streams')
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Ο admin δεν έχει clientId, άρα το /me/streams του είναι άδειο — δεν έχει τι να
// δει εδώ.
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  if (useSession()?.role === 'admin') return navigateTo('/admin')
  load()
  timer = setInterval(load, 10000) // μόνο ο μετρητής θεατών αλλάζει· δεν αξίζει πιο πυκνά
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div>
    <header>
      <h1>Τα streams μου</h1>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="hero">
      <div v-for="s in streams" :key="s.path" class="card">
        <div class="head">
          <strong>{{ s.path }}</strong>
          <span class="spacer" />
          <span class="viewers">
            {{ s.viewers }} <template v-if="s.limit">/ {{ s.limit }}</template> θεατές
            <em v-if="!s.limit">(χωρίς όριο)</em>
          </span>
        </div>
        <div class="body">
          <!-- Ο player δεν ξεκινάει μόνος του: όσο παίζει μετράει κι αυτός ως
               θεατής στο όριο του πελάτη. Το «δεν εκπέμπει» το λέει ο ίδιος ο
               player, από το 404 στο playlist — το /me/streams δεν ξέρει αν
               υπάρχει publisher, μόνο πόσοι βλέπουν. -->
          <PlayerStage v-if="s.host" :src="hls(s)" />
          <div v-else class="quiet">
            Ο server της εκπομπής δεν δηλώνεται ακόμα από το API — ζήτησε τη διεύθυνση
            προβολής από τον διαχειριστή.
          </div>

          <dl class="obs">
            <dt>Server</dt>
            <dd v-if="s.host">
              <code>{{ rtmp(s) }}</code>
              <button @click="copy(rtmp(s), s.path + ':server')">
                {{ copied === s.path + ':server' ? 'αντιγράφηκε' : 'αντιγραφή' }}
              </button>
            </dd>
            <!-- Χωρίς τον server δεν υπάρχει διεύθυνση να αντιγραφεί· μια μαντεψιά
                 εδώ σημαίνει ο πελάτης να εκπέμπει σε λάθος μηχάνημα. -->
            <dd v-else class="hint">
              <code>rtmp://rtmp.&lt;domain&gt;/{{ s.path.split('/')[1] }}</code> —
              το <code>&lt;domain&gt;</code> στο δίνει ο διαχειριστής.
            </dd>

            <dt>Stream Key</dt>
            <dd>
              <code>{{ s.streamKey }}</code>
              <button @click="copy(s.streamKey, s.path + ':key')">
                {{ copied === s.path + ':key' ? 'αντιγράφηκε' : 'αντιγραφή' }}
              </button>
            </dd>
          </dl>
        </div>
      </div>
    </div>

    <div v-if="!streams.length && !error" class="card">
      <div class="quiet">Δεν υπάρχει stream στον λογαριασμό σου.</div>
    </div>

    <p v-if="streams.length" class="note">
      Στο OBS: Ρυθμίσεις → Εκπομπή → Υπηρεσία «Custom», και τα δύο πεδία από πάνω. Το
      Stream Key είναι μυστικό — όποιος το έχει μπορεί να εκπέμψει στη θέση σου.
    </p>
  </div>
</template>

<style scoped>
/* Ο player είναι μεγάλος και τα δύο πεδία του OBS στενά: μία στήλη κάτω από την
   άλλη σε κινητό, δίπλα-δίπλα όταν χωράει (το .body της κάρτας το ορίζει ήδη). */
.viewers { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.viewers em { font-style: normal; }
.obs { margin: 0; padding: 16px; align-content: center; }
.obs dt { font-size: 12px; color: var(--muted); }
.obs dd { display: flex; align-items: center; gap: 8px; margin: 4px 0 14px; flex-wrap: wrap; }
.obs code {
  flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap;
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 8px; font-size: 13px;
}
.obs .hint { font-size: 12px; color: var(--muted); }
</style>
