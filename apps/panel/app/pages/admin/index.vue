<script setup lang="ts">
// Ρητά imports και όχι auto-import: οι helpers χρησιμοποιούνται και μέσα στο
// template, όπου μόνο τα bindings του <script setup> είναι σίγουρα ορατά.
import {
  bps, bytes, clock, colorOf, dur, lineChart, RANGES,
  type Line, type LiveEntry, type PastRow, type Series,
} from '~/utils/dash'

// Ισοδυναμία με το παλιό per-server dashboard (apps/stream/admin/index.html,
// σβήστηκε στο Βήμα 4), με μία διαφορά: εδώ βλέπεις όλους τους servers μαζί.
// Ό,τι ζει στο sqlite του κάθε stream server (χρονοσειρές, ιστορικό συνδέσεων)
// και το restart είναι **ανά server** — γι' αυτό υπάρχει επιλογέας παρακάτω,
// ενώ οι ενεργές εκπομπές και συνδέσεις δείχνονται συνολικά.
const api = useApi()
const ask = useConfirm()

const live = ref<LiveEntry[]>([])
const past = ref<PastRow[]>([])
const pastLimit = ref(15) // το API δίνει 100· δείχνουμε λίγες και ξεδιπλώνει ο χρήστης
const range = ref('24h')
const selected = ref('') // host του server που τροφοδοτεί charts/ιστορικό/restart
const restarting = ref(false)
const error = ref('')

const cIn = ref<HTMLElement>()
const cOut = ref<HTMLElement>()
const cViewers = ref<HTMLElement>()
const cCpu = ref<HTMLElement>()

const hosts = computed(() => live.value.map(e => e.host))
const current = computed(() => live.value.find(e => e.host === selected.value))

// Επίπεδη λίστα όλων των εκπομπών: το snapshot κρατάει την ταυτότητα του server
// και το r2Estimate του (το R2 μπορεί να είναι ενεργό μόνο σε μερικούς).
const streams = computed(() => live.value.flatMap(e =>
  (e.snapshot?.streams ?? []).map(s => ({
    ...s,
    host: e.host,
    online: e.online,
    r2Estimate: e.snapshot?.r2Estimate ?? false,
  }))))

const sessions = computed(() => live.value.flatMap(e =>
  (e.snapshot?.sessions ?? []).map(s => ({ ...s, host: e.host }))))

const viewers = computed(() => streams.value.reduce((a, s) => a + s.viewers, 0))
const onlineCount = computed(() => live.value.filter(e => e.online).length)

// Τα αθροίσματα της γραμμής με τα νούμερα. Εδώ και όχι μέσα στο template: ένας
// πίνακας από κυριολεκτικά αντικείμενα στο v-for παίρνει ένωση τύπων ανά στοιχείο,
// οπότε το `unit` δεν υπάρχει σε όλα και ο typecheck σκάει.
const tiles = computed(() => [
  { label: 'Servers', value: String(onlineCount.value), unit: `/ ${live.value.length}` },
  { label: 'Streams', value: String(streams.value.length), unit: '' },
  { label: 'Θεατές', value: String(viewers.value), unit: '' },
  { label: 'Συνδέσεις', value: String(sessions.value.length), unit: '' },
  { label: `Uptime ${selected.value}`, value: current.value ? dur(current.value.snapshot.server.uptime) : '—', unit: '' },
  { label: `Μνήμη ${selected.value}`, value: current.value ? String(current.value.snapshot.server.rss_mb) : '—', unit: 'MB' },
])

// Ο stream server σερβίρει το HLS από το ίδιο hostname με το οποίο δηλώνεται στο
// panel (config.panel.host == το domain του Caddy του) — δες apps/stream/install.
const hlsUrl = (host: string, stream: string) =>
  `https://${host}/${stream.replace(/^\//, '')}/index.m3u8`

// Ο player ζει σε modal και όχι μέσα στη σελίδα: ο διαχειριστής θέλει να δει ότι
// παίζει και να το κλείσει. Με το κλείσιμο το PlayerStage φεύγει από το DOM και
// το onBeforeUnmount του σταματάει τη λήψη — ένα ξεχασμένο ανοιχτό player μετράει
// ως κανονικός θεατής στα ίδια νούμερα που δείχνει από πάνω.
const playing = ref<{ host: string, stream: string } | null>(null)
const playerOpen = computed({
  get: () => !!playing.value,
  set: (v: boolean) => { if (!v) playing.value = null },
})

async function loadLive() {
  try {
    live.value = await api<LiveEntry[]>('/live')
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
    return
  }
  if (!selected.value || !hosts.value.includes(selected.value)) {
    selected.value = hosts.value[0] ?? ''
  }
}

async function loadPast() {
  if (!selected.value) {
    past.value = []
    return
  }
  // Server κάτω σημαίνει 502 από το proxy του API — άδειο ιστορικό, όχι σφάλμα
  // σε όλη τη σελίδα: τα ζωντανά νούμερα των υπόλοιπων servers ισχύουν ακόμα.
  past.value = await api<PastRow[]>(`/servers/${selected.value}/sessions`).catch(() => [])
}

async function loadSeries() {
  const boxes = [cIn.value, cOut.value, cViewers.value, cCpu.value]
  if (!selected.value || boxes.some(b => !b)) return
  let d: Series
  try {
    d = await api<Series>(`/servers/${selected.value}/series?range=${range.value}`)
  }
  catch {
    for (const b of boxes) b!.innerHTML = `<div class="empty">Ο server δεν απαντάει</div>`
    return
  }
  const to = Math.floor(Date.now() / 1000)
  const byStream = (field: 'in_bps' | 'out_bps' | 'viewers') => {
    const m = new Map<string, Line>()
    for (const r of d.streams) {
      if (!m.has(r.stream)) m.set(r.stream, { name: r.stream, color: colorOf(r.stream), points: [] })
      m.get(r.stream)!.points.push([r.t, r[field]])
    }
    return [...m.values()]
  }
  lineChart(cIn.value!, byStream('in_bps'), bps, d.from, to, d.bucket)
  lineChart(cOut.value!, byStream('out_bps'), bps, d.from, to, d.bucket)
  lineChart(cViewers.value!, byStream('viewers'), v => String(Math.round(v)), d.from, to, d.bucket)
  lineChart(cCpu.value!, [{
    name: 'CPU', color: 'var(--s1)', points: d.server.map(r => [r.t, r.cpu_pct] as [number, number]),
  }], v => v.toFixed(0) + '%', d.from, to, d.bucket)
}

async function kill(host: string, id: string) {
  await api(`/servers/${host}/sessions/${id}`, { method: 'DELETE' }).catch(() => {})
  loadLive()
}

async function restart() {
  const host = selected.value
  const hasLive = streams.value.some(s => s.host === host)
  const ok = await ask({
    title: `Restart του ${host};`,
    description: hasLive
      ? 'Ο server έχει ενεργή εκπομπή αυτή τη στιγμή — το restart θα την κόψει.'
      : 'Καμία ενεργή εκπομπή αυτή τη στιγμή.',
    confirmLabel: 'Restart',
  })
  if (!ok) return

  restarting.value = true
  const since = Date.now()
  try {
    await api(`/servers/${host}/restart`, { method: 'POST' })
    // Ο stream server απαντάει 202 και τερματίζει λίγα ms μετά· τον ξανασηκώνει ο
    // supervisor του. Το «σηκώθηκε» δεν φαίνεται από το /live (το API απαντάει
    // πάντα, από τη μνήμη) — φαίνεται από το ts του snapshot: μόλις κάνει το
    // πρώτο sync του boot, γίνεται νεότερο από τη στιγμή που πατήθηκε το κουμπί.
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const entry = (await api<LiveEntry[]>('/live').catch(() => [])).find(e => e.host === host)
      if (entry && entry.ts > since) break
    }
  }
  catch (e) {
    error.value = (e as Error).message
  }
  restarting.value = false
  refresh()
  loadSeries()
}

function refresh() {
  loadLive().then(loadPast)
}

// Ίδιοι ρυθμοί με το παλιό dashboard: τα ζωντανά ανά 5s, οι χρονοσειρές ανά 60s
// (το bucket τους δεν είναι μικρότερο από 10s ούτως ή άλλως).
let timers: ReturnType<typeof setInterval>[] = []
onMounted(() => {
  refresh()
  timers = [setInterval(refresh, 5000), setInterval(loadSeries, 60000)]
})
onBeforeUnmount(() => timers.forEach(clearInterval))

// Ο πρώτος server έρχεται με το πρώτο /live, δηλαδή μετά το mount — το watch
// είναι που τραβάει τα charts την πρώτη φορά.
watch([selected, range], () => {
  loadPast()
  nextTick(loadSeries)
})
</script>

<template>
  <div class="space-y-4">
    <header>
      <span class="dot" :class="{ on: streams.length > 0 }" />
      <h1>Stream servers</h1>
      <span class="spacer" />

      <!-- Επιλογέας server: ό,τι ζει στο sqlite του καθενός (charts, ιστορικό,
           restart) αφορά μόνο τον επιλεγμένο. -->
      <div class="flex gap-1 flex-wrap">
        <UButton
          v-for="e in live" :key="e.host"
          :color="e.host === selected ? 'primary' : 'neutral'"
          :variant="e.host === selected ? 'subtle' : 'ghost'"
          size="sm"
          :title="e.online ? 'σε σύνδεση' : 'χωρίς sync εδώ και >30s'"
          @click="selected = e.host"
        >
          <span class="dot" :class="{ on: e.online }" />{{ e.host }}
        </UButton>
      </div>

      <UButton
        icon="i-lucide-rotate-ccw" color="error" size="sm"
        :loading="restarting" :disabled="!selected" @click="restart"
      >
        {{ restarting ? 'γίνεται restart…' : 'Restart server' }}
      </UButton>

      <div class="flex gap-1">
        <UButton
          v-for="(label, r) in RANGES" :key="r"
          :color="r === range ? 'primary' : 'neutral'"
          :variant="r === range ? 'subtle' : 'ghost'"
          size="sm" :title="label" @click="range = r"
        >{{ r }}</UButton>
      </div>
    </header>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <!-- Μία γραμμή ανά εκπομπή και όχι κάρτα με preview: τα βίντεο έπιαναν όλη
         τη σελίδα με δύο-τρία streams, ενώ αυτό που κοιτάει ο διαχειριστής όλη
         την ώρα είναι τα νούμερα. Ο player είναι ένα κλικ μακριά, σε popup. -->
    <UCard>
      <h2>Ενεργές εκπομπές</h2>
      <div class="scroll">
        <table v-if="streams.length">
          <thead>
            <tr>
              <th />
              <th>Stream</th><th>Server</th><th class="num">Διάρκεια</th><th class="num">Θεατές</th>
              <th class="num">Είσοδος</th><th class="num">Έξοδος</th>
              <th>Ανάλυση</th><th>Αναδιανομή</th><th>Κωδικοποίηση</th><th>IP</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in streams" :key="s.host + s.stream">
              <td>
                <UBadge v-if="s.online" color="error" variant="solid" class="tracking-wider">ON AIR</UBadge>
                <UBadge v-else color="neutral" variant="subtle" title="ο server δεν έχει κάνει sync εδώ και >30s">
                  ΕΚΤΟΣ
                </UBadge>
              </td>
              <td>{{ s.stream }}</td>
              <td>{{ s.host }}</td>
              <td class="num">{{ dur((Date.now() - s.since) / 1000) }}</td>
              <td class="num">{{ s.viewers }}</td>
              <td class="num">{{ bps(s.in_bps) }}</td>
              <!-- Με R2 ενεργό η έξοδος είναι εκτίμηση (bytes segment × θεατές) — τα .ts
                   σερβίρονται από το CDN και δεν αγγίζουν ποτέ αυτόν τον server. -->
              <td
                class="num"
                :title="s.r2Estimate ? 'Εκτίμηση: τα .ts segments σερβίρονται από το R2, όχι μέτρηση πραγματικής κίνησης' : ''"
              >
                {{ bps(s.out_bps) }}{{ s.r2Estimate ? ' *' : '' }}
                <!-- Η υποβάθμιση του R2 είναι αόρατη από παντού αλλού: η εκπομπή
                     παίζει κανονικά (τα segments πέφτουν στο origin — r2.js) και
                     το uplink του server πληρώνει τη διαφορά αθόρυβα. -->
                <UBadge
                  v-if="s.r2?.degraded" color="warning" variant="subtle" size="sm" class="ml-1"
                  :title="`Το R2 δεν προλαβαίνει: τα segments σερβίρονται από το uplink του server (${s.r2.fallen} ως τώρα)`"
                >ΕΚΤΟΣ R2</UBadge>
                <UBadge
                  v-else-if="s.r2?.fallen" color="neutral" variant="subtle" size="sm" class="ml-1"
                  :title="`${s.r2.fallen} segments σερβιρίστηκαν από το origin σε αυτή την εκπομπή — τώρα το R2 προλαβαίνει`"
                >R2: {{ s.r2.fallen }}</UBadge>
              </td>
              <td>
                {{ s.resolution }}
                <UBadge v-if="s.ladder?.length" color="primary" variant="subtle" size="sm" class="ml-1">
                  +{{ s.ladder.join('/') }}
                </UBadge>
              </td>
              <!-- Η αναδιανομή είναι το μόνο κομμάτι της εκπομπής που μπορεί να
                   είναι σπασμένο ενώ όλα τα υπόλοιπα δείχνουν μια χαρά: το RTMP
                   παίζει, το HLS παίζει, και μόνο το YouTube δεν παίρνει σήμα.
                   Γι' αυτό μπαίνει στον πίνακα και όχι μόνο στο panel του πελάτη. -->
              <td>
                <template v-if="s.relays?.length">
                  <UBadge
                    v-for="r in s.relays" :key="r.name"
                    :color="r.state === 'live' ? 'success' : 'warning'"
                    variant="subtle" size="sm" class="mr-1"
                    :title="r.state === 'live' ? 'στέλνει' : 'προσπαθεί να συνδεθεί'"
                  >
                    {{ r.name }}
                  </UBadge>
                </template>
                <span v-else class="host">—</span>
              </td>
              <td>{{ s.video }} · {{ s.audio }}</td>
              <td>{{ s.protocol }} από {{ s.ip }}</td>
              <td>
                <UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-play" @click="playing = s">
                  player
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">Καμία ενεργή εκπομπή</div>
      </div>
    </UCard>

    <!-- Μόνο αθροίσματα εδώ — τα νούμερα ανά stream τα δείχνει η κάρτα. Το uptime
         και η μνήμη είναι ανά διεργασία, οπότε αφορούν τον επιλεγμένο server. -->
    <div class="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      <UCard v-for="t in tiles" :key="t.label">
        <div class="text-xs text-dimmed truncate">{{ t.label }}</div>
        <div class="text-2xl font-semibold leading-tight tabular-nums">
          {{ t.value }} <span v-if="t.unit" class="text-sm font-normal text-muted">{{ t.unit }}</span>
        </div>
      </UCard>
    </div>

    <div class="charts">
      <UCard><h2>Bitrate εισόδου — {{ selected }}</h2><div ref="cIn" class="chart" /></UCard>
      <UCard><h2>Bitrate εξόδου — {{ selected }}</h2><div ref="cOut" class="chart" /></UCard>
      <UCard><h2>Θεατές — {{ selected }}</h2><div ref="cViewers" class="chart" /></UCard>
      <UCard><h2>CPU — {{ selected }}</h2><div ref="cCpu" class="chart" /></UCard>
    </div>

    <UCard>
      <h2>Ενεργές συνδέσεις</h2>
      <div class="scroll">
        <table v-if="sessions.length">
          <thead>
            <tr>
              <th>Server</th><th>Stream</th><th>Τύπος</th><th>Πρωτόκολλο</th><th>IP</th>
              <th class="num">Λήψη</th><th class="num">Αποστολή</th><th class="num">Διάρκεια</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.host + s.id">
              <td>{{ s.host }}</td>
              <td>{{ s.stream }}</td>
              <td>{{ s.publisher ? 'publisher' : 'θεατής' }}</td>
              <td>{{ s.protocol }}</td>
              <td>{{ s.ip }}</td>
              <td class="num">{{ bytes(s.inBytes) }}</td>
              <td class="num">{{ bytes(s.outBytes) }}</td>
              <td class="num">{{ dur((Date.now() - s.since) / 1000) }}</td>
              <td>
                <UButton size="xs" color="error" variant="ghost" icon="i-lucide-x" @click="kill(s.host, s.id)">
                  kill
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">Καμία εγγραφή</div>
      </div>
    </UCard>

    <UCard>
      <h2>Πρόσφατες συνδέσεις — {{ selected }}</h2>
      <div class="scroll">
        <table v-if="past.length">
          <thead>
            <tr>
              <th>Stream</th><th>Τύπος</th><th>Πρωτόκολλο</th><th>IP</th><th>Έναρξη</th>
              <th class="num">Διάρκεια</th><th class="num">Λήψη</th><th class="num">Αποστολή</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in past.slice(0, pastLimit)" :key="r.id">
              <td>{{ r.stream }}</td>
              <td>{{ r.publisher ? 'publisher' : 'θεατής' }}</td>
              <td>{{ r.protocol }}</td>
              <td>{{ r.ip }}</td>
              <td>{{ clock(r.start_ts) }}</td>
              <td class="num">{{ dur(r.end_ts - r.start_ts) }}</td>
              <td class="num">{{ bytes(r.in_bytes) }}</td>
              <td class="num">{{ bytes(r.out_bytes) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">Καμία εγγραφή</div>
      </div>
      <UButton
        v-if="past.length > pastLimit" class="mt-3" size="sm" color="neutral" variant="subtle"
        @click="pastLimit = Infinity"
      >
        περισσότερες συνδέσεις ({{ past.length - pastLimit }})
      </UButton>
    </UCard>

    <!-- Ένα modal για όλες τις γραμμές, όχι ένα ανά stream: ένας player τη φορά
         είναι ούτως ή άλλως το ζητούμενο, και το `v-if` εγγυάται ότι το κλείσιμο
         πράγματι ξηλώνει το <video> (το x του modal δεν είναι Stop). Με `auto`:
         εδώ ο διαχειριστής ήρθε αποκλειστικά για να δει αν παίζει. -->
    <UModal v-model:open="playerOpen" :title="playing?.stream" :description="playing?.host" :ui="{ content: 'sm:max-w-4xl', body: 'p-0 sm:p-0' }">
      <template #body>
        <PlayerStage v-if="playing" :src="hlsUrl(playing.host, playing.stream)" auto />
      </template>
    </UModal>
  </div>
</template>
