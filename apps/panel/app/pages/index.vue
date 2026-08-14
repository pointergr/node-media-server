<script setup lang="ts">
// User panel (Βήμα 5 του PLAN-monorepo.md): ό,τι χρειάζεται ο πελάτης για να
// εκπέμψει και να δει την εκπομπή του. Μοναδική πηγή το `GET /me/streams` — το
// API φιλτράρει με το clientId του token, οπότε εδώ δεν υπάρχει κώδικας που να
// μπορεί να δείξει ξένο stream.
//
// Ρητά imports και όχι auto-import, ίδιος λόγος με το /admin: χρησιμοποιούνται
// και μέσα στο template. Τα γραφήματα εδώ τα κάνει το Chart.js (MiniChart), όχι
// το lineChart του dash.ts — το dash.ts μένει για τους τύπους και τη μορφοποίηση.
import { bps, dur, type Series } from '~/utils/dash'

const api = useApi()

interface MyStream {
  path: string
  key: string
  streamKey: string // «όνομα?key=…», έτοιμο για το πεδίο Stream Key του OBS
  limit: number // 0 = χωρίς όριο, αθροιστικά σε όλα τα paths του πελάτη
  viewers: number
  since: number | null // unix seconds· null = δεν εκπέμπει αυτή τη στιγμή
  in_bps: number
  // Ο server δεν έρχεται σήμερα από το /me/streams. Χωρίς αυτόν δεν υπάρχει
  // διεύθυνση ούτε για το HLS ούτε για το RTMP — δείχνουμε οδηγία αντί για
  // μαντεψιά (δες σχόλιο στο template).
  host?: string
}

const streams = ref<MyStream[]>([])
const series = ref<Series>({ bucket: 0, from: 0, streams: [], server: [] })
const error = ref('')
const copied = ref('')
// Σε **χιλιοστά**, όπως το `since` του snapshot (createTime του nms) — το /admin
// κάνει το ίδιο `(Date.now() - since) / 1000`. Σε δευτερόλεπτα η διαφορά έβγαινε
// αρνητική και το dur() την πάτωνε στο «0λ 0δ».
const now = ref(Date.now())

// Κάρτα μόνο για ό,τι εκπέμπει τώρα· τα υπόλοιπα paths πάνε στη λίστα από κάτω —
// χωρίς αυτήν, πελάτης εκτός εκπομπής δεν θα είχε πουθενά να δει το κλειδί του.
const live = computed(() => streams.value.filter(s => s.since))
const idle = computed(() => streams.value.filter(s => !s.since))

// Σημεία ανά path, μία φορά ανά φόρτωση: υπολογισμός μέσα στο template θα έφτιαχνε
// νέο array σε κάθε render και το MiniChart θα ξαναζωγράφιζε χωρίς λόγο.
const points = computed(() => {
  const m: Record<string, { viewers: [number, number][], in: [number, number][] }> = {}
  for (const s of streams.value) m[s.path] = { viewers: [], in: [] }
  for (const r of series.value.streams) {
    m[r.stream]?.viewers.push([r.t, r.viewers])
    m[r.stream]?.in.push([r.t, r.in_bps])
  }
  return m
})

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
    now.value = Date.now()
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Ξεχωριστά από το load(): το ιστορικό 24ώρου το φέρνει το API κάνοντας proxy
// στον stream server — δεν αξίζει κάθε 10s. Server κάτω σημαίνει άδεια γραφήματα,
// όχι σφάλμα σε όλη τη σελίδα: το stream key και οι ρυθμίσεις του OBS ισχύουν.
async function loadSeries() {
  series.value = await api<Series>('/me/series?range=24h')
    .catch(() => ({ bucket: 0, from: 0, streams: [], server: [] }))
}

// Ο admin δεν έχει clientId, άρα το /me/streams του είναι άδειο — δεν έχει τι να
// δει εδώ.
let timer: ReturnType<typeof setInterval>
let seriesTimer: ReturnType<typeof setInterval>
onMounted(() => {
  if (useSession()?.role === 'admin') return navigateTo('/admin')
  load()
  loadSeries()
  timer = setInterval(load, 10000) // μόνο ο μετρητής θεατών αλλάζει· δεν αξίζει πιο πυκνά
  seriesTimer = setInterval(loadSeries, 60000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  clearInterval(seriesTimer)
})
</script>

<template>
  <div>
    <header>
      <h1>Τα streams μου</h1>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="hero">
      <div v-for="s in live" :key="s.path" class="card">
        <div class="head">
          <strong>{{ s.path }}</strong>
          <!-- Η κατάσταση βγαίνει από το `since` του publisher: όσο δεν υπάρχει
               publisher δεν υπάρχει εκπομπή, ό,τι κι αν δείχνει ο μετρητής.
               Το `since` είναι σε χιλιοστά (createTime του nms). -->
          <span class="badge on">εκπέμπει {{ dur((now - s.since!) / 1000) }}</span>
          <span class="spacer" />
          <span class="viewers">{{ bps(s.in_bps) }} είσοδος</span>
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

        <!-- 24ωρο ιστορικό μόνο αυτού του path (το /me/series φιλτράρει με το
             token). CPU/μνήμη του μηχανήματος δεν δείχνουμε: αφορούν και τους
             υπόλοιπους πελάτες του ίδιου server. -->
        <div class="charts">
          <div class="chart">
            <h2>Θεατές — 24 ώρες</h2>
            <MiniChart :points="points[s.path]?.viewers ?? []" color="--s1" :fmt="v => String(Math.round(v))" />
          </div>
          <div class="chart">
            <h2>Bitrate εισόδου — 24 ώρες</h2>
            <MiniChart :points="points[s.path]?.in ?? []" color="--s2" :fmt="bps" />
          </div>
        </div>
      </div>
    </div>

    <div v-if="!live.length && !error" class="card">
      <div class="quiet">
        {{ streams.length ? 'Καμία ενεργή εκπομπή.' : 'Δεν υπάρχει stream στον λογαριασμό σου.' }}
      </div>
    </div>

    <!-- Τα paths που δεν εκπέμπουν: χωρίς κάρτα και χωρίς player, αλλά με το
         κλειδί τους — από εδώ ξεκινάει ο πελάτης την εκπομπή. -->
    <div v-if="idle.length" class="card idle">
      <h2>Δεν εκπέμπουν</h2>
      <div v-for="s in idle" :key="s.path" class="row">
        <strong>{{ s.path }}</strong>
        <code v-if="s.host">{{ rtmp(s) }}</code>
        <code>{{ s.streamKey }}</code>
        <button @click="copy(s.streamKey, s.path + ':key')">
          {{ copied === s.path + ':key' ? 'αντιγράφηκε' : 'αντιγραφή' }}
        </button>
      </div>
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
.badge {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--border); font-variant-numeric: tabular-nums;
}
.badge.on { background: var(--live); border-color: transparent; color: #fff; }
.badge.off { color: var(--muted); }
/* Δύο γραφήματα δίπλα-δίπλα όταν χωράνε, το ένα κάτω από το άλλο σε κινητό. */
.charts {
  display: grid; gap: 16px; padding: 16px; border-top: 1px solid var(--border);
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}
.charts h2 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 0 0 8px; }
.idle { padding: 16px; }
.idle h2 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 0 0 10px; }
.idle .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.idle .row:last-child { margin-bottom: 0; }
.idle code {
  overflow-x: auto; white-space: nowrap;
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 4px 8px; font-size: 12px;
}
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
