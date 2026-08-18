<script setup lang="ts">
// User panel (Βήμα 5 του PLAN-monorepo.md): ό,τι χρειάζεται ο πελάτης για να
// εκπέμψει και να δει την εκπομπή του. Μοναδική πηγή το `GET /me/streams` — το
// API φιλτράρει με το clientId του token, οπότε εδώ δεν υπάρχει κώδικας που να
// μπορεί να δείξει ξένο stream.
//
// Ρητά imports και όχι auto-import, ίδιος λόγος με το /admin: χρησιμοποιούνται
// και μέσα στο template. Τα γραφήματα εδώ τα κάνει το Chart.js (MiniChart), όχι
// το lineChart του dash.ts — το dash.ts μένει για τους τύπους και τη μορφοποίηση.
import { bps, dur, RANGES, type Series } from '~/utils/dash'

const api = useApi()
const ask = useConfirm()

interface MyStream {
  id: number // του Path — μόνο για την ανανέωση κλειδιού
  path: string
  key: string
  streamKey: string // «όνομα?key=…», έτοιμο για το πεδίο Stream Key του OBS
  // Το όριο είναι του ΠΛΑΝΟΥ στο οποίο ανήκει το stream, όχι του λογαριασμού:
  // δύο πλάνα των 50 δεν κάνουν 100 (δες apps/api/prisma/schema.prisma).
  limit: number
  plan: string
  subscriptionId: number
  // Το φιλικό όνομα του πακέτου — με δύο «basic» είναι το μόνο που τα ξεχωρίζει.
  // null = δεν το έχει ονομάσει κανείς, δες title() παρακάτω.
  subscriptionLabel: string | null
  // Πλάνο σε αναστολή (π.χ. έληξε): το stream δεν εκπέμπει και δεν παίζει. Το
  // δείχνουμε παρ' όλα αυτά, με τον λόγο του — αλλιώς ο πελάτης βλέπει το OBS να
  // κόβεται και το stream να εξαφανίζεται, χωρίς εξήγηση.
  suspended: boolean
  viewers: number
  since: number | null // unix seconds· null = δεν εκπέμπει αυτή τη στιγμή
  in_bps: number
  out_bps: number
  // Με R2 ενεργό η έξοδος είναι εκτίμηση, όχι μέτρηση — ίδιος αστερίσκος με το
  // /admin (τα .ts σερβίρονται από το CDN και δεν περνάνε από τον stream server).
  r2Estimate?: boolean
  // Ο server δεν έρχεται σήμερα από το /me/streams. Χωρίς αυτόν δεν υπάρχει
  // διεύθυνση ούτε για το HLS ούτε για το RTMP — δείχνουμε οδηγία αντί για
  // μαντεψιά (δες σχόλιο στο template).
  host?: string
}

// Οι συνδρομές είναι ξεχωριστή κλήση από τα streams: το /me/streams γυρίζει
// paths, οπότε ένα πακέτο που μόλις αγοράστηκε (κανένα stream ακόμα) δεν θα
// φαινόταν πουθενά — και από εκεί ακριβώς ξεκινάει ο πελάτης.
interface MySub {
  id: number
  plan: string
  label: string | null
  host: string
  maxStreams: number
  maxViewers: number
  streams: number
  suspended: boolean
}

const streams = ref<MyStream[]>([])
const subs = ref<MySub[]>([])
const series = ref<Series>({ bucket: 0, from: 0, streams: [], server: [] })
// Το ιστορικό κρατιέται 30 μέρες στον stream server (stats.js#RETENTION_DAYS),
// οπότε τα ίδια διαστήματα με το /admin — δεν υπάρχει λόγος ο πελάτης να βλέπει
// λιγότερα από τον διαχειριστή για τα δικά του streams.
const range = ref('24h')
const error = ref('')
// Σε **χιλιοστά**, όπως το `since` του snapshot (createTime του nms) — το /admin
// κάνει το ίδιο `(Date.now() - since) / 1000`. Σε δευτερόλεπτα η διαφορά έβγαινε
// αρνητική και το dur() την πάτωνε στο «0λ 0δ».
const now = ref(Date.now())

// Η οθόνη είναι ομαδοποιημένη **ανά συνδρομή** και όχι μία ενιαία λίστα streams:
// το όριο θεατών ανήκει στη συνδρομή (μία εγγραφή ανά συνδρομή στο clients.json,
// δες stats.js#overLimit), οπότε ο πελάτης πρέπει να βλέπει ποια streams το
// μοιράζονται. Με badge πάνω-δεξιά και λίστα από κάτω, δύο πακέτα «basic» έδιναν
// δύο πανομοιότυπα «0 / 50 θεατές» και κανέναν τρόπο να πεις ποιο αφορά τι.
interface Pack {
  id: number
  title: string
  label: string | null
  plan: string
  host?: string
  limit: number
  // Το όριο streams: μετράει paths, όχι ταυτόχρονες εκπομπές — το επιβάλλει το
  // API (clients.service#addPath), εδώ μόνο φαίνεται και κλειδώνει το κουμπί.
  maxStreams: number
  viewers: number
  suspended: boolean
  live: MyStream[]
  idle: MyStream[]
}

// Η λίστα βγαίνει από τις **συνδρομές** και όχι από τα streams: αλλιώς ένα άδειο
// πακέτο δεν θα είχε κάρτα, άρα ούτε κουμπί «νέο stream».
const packs = computed<Pack[]>(() => {
  const m = new Map<number, Pack>(subs.value.map(sub => [sub.id, {
    id: sub.id,
    title: '',
    label: sub.label,
    plan: sub.plan,
    host: sub.host,
    limit: sub.maxViewers,
    maxStreams: sub.maxStreams,
    viewers: 0,
    suspended: sub.suspended,
    live: [],
    idle: [],
  }]))
  for (const s of streams.value) {
    const p = m.get(s.subscriptionId)
    if (!p) continue // stream χωρίς πακέτο δεν υπάρχει· αν συμβεί, το /me/subscriptions είναι η αλήθεια
    p.viewers += s.viewers
    ;(s.since ? p.live : p.idle).push(s)
  }
  // Σταθερή σειρά κατά id (σειρά αγοράς): η θέση είναι μέρος της ταυτότητας για
  // όσα πακέτα δεν έχουν όνομα ακόμα — «Πακέτο 2» δεν πρέπει να αλλάζει θέση σε
  // κάθε φόρτωση.
  const list = [...m.values()].sort((a, b) => a.id - b.id)
  list.forEach((p, i) => { p.title = p.label || `Πακέτο ${i + 1}` })
  return list
})

// Κρατιέται για το «Καμία ενεργή εκπομπή» της κεφαλίδας και για το αν έχει νόημα
// ο διακόπτης διαστημάτων: τα γραφήματα ζουν μόνο στις κάρτες που εκπέμπουν.
const live = computed(() => streams.value.filter(s => s.since))

// Σημεία ανά path, μία φορά ανά φόρτωση: υπολογισμός μέσα στο template θα έφτιαχνε
// νέο array σε κάθε render και το MiniChart θα ξαναζωγράφιζε χωρίς λόγο.
const points = computed(() => {
  const m: Record<string, { viewers: [number, number][], in: [number, number][], out: [number, number][] }> = {}
  for (const s of streams.value) m[s.path] = { viewers: [], in: [], out: [] }
  for (const r of series.value.streams) {
    m[r.stream]?.viewers.push([r.t, r.viewers])
    m[r.stream]?.in.push([r.t, r.in_bps])
    m[r.stream]?.out.push([r.t, r.out_bps])
  }
  return m
})

// Το playlist ζει στον stream server, όχι στο domain του panel.
const hls = (s: MyStream) => `https://${s.host}/${s.path.replace(/^\//, '')}/index.m3u8`

// Το RTMP ακούει στο `rtmp.<domain>` του ίδιου server (apps/stream/Caddyfile) και
// το application είναι το πρώτο κομμάτι του path — `/live/foo` → `live`.
const rtmp = (s: MyStream) => `rtmp://rtmp.${s.host}/${s.path.split('/')[1]}`

async function load() {
  try {
    // Παράλληλα: δύο σειριακά requests κάθε 10s χωρίς λόγο.
    const [mine, packages] = await Promise.all([
      api<MyStream[]>('/me/streams'),
      api<MySub[]>('/me/subscriptions'),
    ])
    streams.value = mine
    subs.value = packages
    now.value = Date.now()
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Νέο κλειδί χωρίς να περιμένει τον διαχειριστή: αν διέρρευσε, μετράει η ώρα.
async function refreshKey(s: MyStream) {
  const ok = await ask({
    title: `Νέο κλειδί για το ${s.path};`,
    description: 'Το παλιό παύει να ισχύει — η εκπομπή που τρέχει κόβεται σε ≤10s και το πρόγραμμα εκπομπής θέλει το νέο κλειδί.',
  })
  if (!ok) return
  try {
    await api(`/me/streams/${s.id}/key`, { method: 'POST' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Νέο stream χωρίς να περιμένει τον διαχειριστή. Το όνομα του path το δίνει το
// API· εδώ δεν ελέγχεται το όριο — το κουμπί κλειδώνει, αλλά το 409 του API
// είναι η πραγματική επιβολή (δύο καρτέλες ανοιχτές, ίδιο πακέτο).
const creating = ref<number | null>(null)

async function createStream(p: Pack) {
  creating.value = p.id
  try {
    await api('/me/streams', { method: 'POST', body: JSON.stringify({ subscriptionId: p.id }) })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    creating.value = null
  }
}

// Διαγραφή stream: μόνο από τη λίστα «δεν εκπέμπουν» — όσο υπάρχει publisher το
// API απαντάει 409 και το κουμπί δεν έχει πού να σταθεί. Το κλειδί φεύγει μαζί,
// γι' αυτό επιβεβαίωση.
async function removeStream(s: MyStream) {
  const ok = await ask({
    title: `Διαγραφή του ${s.path};`,
    description: 'Το stream και το κλειδί του χάνονται οριστικά. Η θέση ελευθερώνεται στο πακέτο.',
  })
  if (!ok) return
  try {
    await api(`/me/streams/${s.id}`, { method: 'DELETE' })
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Το όνομα του πακέτου το δίνει ο ίδιος ο πελάτης// Το όνομα του πακέτου το δίνει ο ίδιος ο πελάτης: εκείνος ξέρει ότι το ένα
// basic είναι η εκκλησία και το άλλο το δημαρχείο. Ένα πεδίο τη φορά — η
// μετονομασία είναι σπάνια, φόρμα με «επεξεργασία όλων» θα ήταν βάρος για το
// 99% των επισκέψεων.
const editing = ref<number | null>(null)
const draft = ref('')

function startEdit(p: Pack) {
  editing.value = p.id
  draft.value = p.label ?? ''
}

async function saveLabel(p: Pack) {
  try {
    await api(`/me/subscriptions/${p.id}`, { method: 'PATCH', body: JSON.stringify({ label: draft.value }) })
    editing.value = null
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

// Ξεχωριστά από το load(): το ιστορικό το φέρνει το API κάνοντας proxy στον
// stream server — δεν αξίζει κάθε 10s. Server κάτω σημαίνει άδεια γραφήματα,
// όχι σφάλμα σε όλη τη σελίδα: το stream key και οι ρυθμίσεις του OBS ισχύουν.
async function loadSeries() {
  series.value = await api<Series>(`/me/series?range=${range.value}`)
    .catch(() => ({ bucket: 0, from: 0, streams: [], server: [] }))
}
watch(range, loadSeries)

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
  <div class="space-y-4">
    <div class="flex items-center gap-3 flex-wrap">
      <UIcon name="i-lucide-radio" class="text-primary size-5" />
      <h1>Τα streams μου</h1>
      <span class="grow" />
      <!-- Οι μετρητές θεατών ζουν στην κεφαλίδα του κάθε πακέτου, δίπλα στα
           streams που μοιράζονται το όριο — δες την ομαδοποίηση παρακάτω. -->

      <!-- Μόνο όταν υπάρχουν γραφήματα να αλλάξουν: τα γραφήματα ζουν στην κάρτα
           της ενεργής εκπομπής. -->
      <div v-if="live.length" class="flex gap-1">
        <UButton
          v-for="(label, r) in RANGES" :key="r"
          :color="r === range ? 'primary' : 'neutral'"
          :variant="r === range ? 'subtle' : 'ghost'"
          size="sm" :title="label" @click="range = r"
        >{{ r }}</UButton>
      </div>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <!-- Μία ενότητα ανά πακέτο. Ο τίτλος και το όριο θεατών στέκονται **πάνω από**
         τα streams τους: το όριο είναι της συνδρομής και μοιράζεται μόνο ανάμεσα
         σε αυτά, κάτι που καμία ετικέτα δίπλα σε ενιαία λίστα δεν μπορεί να πει
         όταν δύο πακέτα λέγονται και τα δύο «basic». -->
    <section v-for="p in packs" :key="p.id" class="pack">
      <div class="pack-head">
        <UIcon name="i-lucide-package" class="text-dimmed size-4" />

        <!-- Το όνομα το γράφει ο πελάτης (PATCH /me/subscriptions/:id): μόνο
             εκείνος ξέρει ποιο πακέτο είναι η εκκλησία και ποιο το δημαρχείο. -->
        <template v-if="editing === p.id">
          <UInput
            v-model="draft" size="sm" autofocus placeholder="π.χ. Εκκλησία Αγ. Νικολάου"
            :maxlength="60" @keyup.enter="saveLabel(p)" @keyup.esc="editing = null"
          />
          <UButton size="xs" color="primary" variant="subtle" icon="i-lucide-check" @click="saveLabel(p)">
            Αποθήκευση
          </UButton>
          <UButton size="xs" color="neutral" variant="ghost" @click="editing = null">Άκυρο</UButton>
        </template>
        <template v-else>
          <h2 :class="{ unnamed: !p.label }">{{ p.title }}</h2>
          <UButton
            icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost"
            :aria-label="p.label ? 'Μετονομασία πακέτου' : 'Ονόμασε το πακέτο'"
            :title="p.label ? 'Μετονομασία' : 'Δώσε όνομα στο πακέτο'"
            @click="startEdit(p)"
          />
        </template>

        <span class="spacer" />
        <UBadge v-if="p.suspended" color="warning" variant="subtle" icon="i-lucide-circle-pause">
          σε αναστολή
        </UBadge>
        <!-- Το πλάνο δίπλα στο όνομα και όχι αντί για αυτό: ο πελάτης θέλει να
             ξέρει και τι πληρώνει, όχι μόνο πώς το λέει ο ίδιος. -->
        <span class="viewers">{{ p.plan }}</span>
        <UBadge color="neutral" variant="subtle" icon="i-lucide-users">
          {{ p.viewers }}<template v-if="p.limit"> / {{ p.limit }}</template> θεατές<template
            v-if="!p.limit"
          > (χωρίς όριο)</template>
        </UBadge>
        <span v-if="p.host" class="viewers">{{ p.host }}</span>
        <!-- Τα streams του πακέτου τα φτιάχνει ο πελάτης, μέχρι το όριο του
             πλάνου του: κλειδωμένο κουμπί αντί για κρυμμένο, ώστε να φαίνεται
             ότι υπάρχει όριο και ποιο είναι. Σε αναστολή δεν προσθέτουμε: το
             πακέτο δεν εκπέμπει ούτως ή άλλως. -->
        <UButton
          size="xs" color="neutral" variant="subtle" icon="i-lucide-plus"
          :loading="creating === p.id"
          :disabled="p.suspended || p.live.length + p.idle.length >= p.maxStreams"
          :title="p.live.length + p.idle.length >= p.maxStreams
            ? `Το πλάνο «${p.plan}» επιτρέπει ${p.maxStreams} streams`
            : 'Νέο stream σε αυτό το πακέτο'"
          @click="createStream(p)"
        >
          Νέο stream ({{ p.live.length + p.idle.length }}/{{ p.maxStreams }})
        </UButton>
      </div>

      <div v-if="p.live.length" class="hero">
      <UCard
        v-for="s in p.live" :key="s.path"
        :ui="{ body: 'p-0 sm:p-0', header: 'px-4 py-3 sm:px-4' }"
      >
        <template #header>
          <div class="head">
            <strong>{{ s.path }}</strong>
            <!-- Η κατάσταση βγαίνει από το `since` του publisher: όσο δεν υπάρχει
                 publisher δεν υπάρχει εκπομπή, ό,τι κι αν δείχνει ο μετρητής.
                 Το `since` είναι σε χιλιοστά (createTime του nms). -->
            <UBadge color="error" variant="solid" icon="i-lucide-radio">
              εκπέμπει {{ dur((now - s.since!) / 1000) }}
            </UBadge>
            <span class="spacer" />
            <span class="viewers">{{ bps(s.in_bps) }} είσοδος</span>
            <span
              class="viewers"
              :title="s.r2Estimate ? 'Εκτίμηση: τα segments σερβίρονται από CDN, δεν μετριούνται στον stream server' : ''"
            >{{ bps(s.out_bps) }} έξοδος{{ s.r2Estimate ? ' *' : '' }}</span>
            <!-- Χωρίς το όριο εδώ: αφορά το άθροισμα των εκπομπών, δες την
                 κεφαλίδα της σελίδας. -->
            <span class="viewers">{{ s.viewers }} θεατές</span>
          </div>
        </template>

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
              <CopyButton :text="rtmp(s)" label="" />
            </dd>
            <!-- Χωρίς τον server δεν υπάρχει διεύθυνση να αντιγραφεί· μια μαντεψιά
                 εδώ σημαίνει ο πελάτης να εκπέμπει σε λάθος μηχάνημα. -->
            <dd v-else class="hint">
              <code>rtmp://rtmp.&lt;domain&gt;/{{ s.path.split('/')[1] }}</code> —
              το <code>&lt;domain&gt;</code> στο δίνει ο διαχειριστής.
            </dd>

            <dt>Stream Key</dt>
            <dd>
              <SecretKey :text="s.streamKey" />
              <CopyButton :text="s.streamKey" label="" />
              <!-- Αν εκτεθεί: νέο κλειδί, ίδιο path — η διεύθυνση προβολής και ό,τι
                   έχει ήδη ενσωματωθεί κάπου δεν αλλάζει. -->
              <UButton
                icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost"
                aria-label="Νέο κλειδί" title="Νέο κλειδί" @click="refreshKey(s)"
              />
            </dd>

            <!-- Το ίδιο playlist που παίζει ο player από πάνω: για embed σε ξένη
                 σελίδα ή για VLC. Χωρίς host δεν υπάρχει διεύθυνση — δες Server. -->
            <template v-if="s.host">
              <dt>Διεύθυνση προβολής (HLS)</dt>
              <dd>
                <code>{{ hls(s) }}</code>
                <CopyButton :text="hls(s)" label="" />
              </dd>
            </template>
          </dl>
        </div>

        <!-- Ιστορικό μόνο αυτού του path (το /me/series φιλτράρει με το token),
             στο διάστημα που διάλεξε ο πελάτης. CPU/μνήμη του μηχανήματος δεν
             δείχνουμε: αφορούν και τους υπόλοιπους πελάτες του ίδιου server. -->
        <div class="charts border-t border-default">
          <div class="chart">
            <h2>Θεατές — {{ RANGES[range] }}</h2>
            <MiniChart :points="points[s.path]?.viewers ?? []" :from="series.from" color="--s1" :fmt="v => String(Math.round(v))" />
          </div>
          <div class="chart">
            <h2>Bitrate εισόδου — {{ RANGES[range] }}</h2>
            <MiniChart :points="points[s.path]?.in ?? []" :from="series.from" color="--s2" :fmt="bps" />
          </div>
          <div class="chart">
            <h2>Bitrate εξόδου — {{ RANGES[range] }}{{ s.r2Estimate ? ' *' : '' }}</h2>
            <MiniChart :points="points[s.path]?.out ?? []" :from="series.from" color="--s3" :fmt="bps" />
          </div>
        </div>
      </UCard>
    </div>

    <!-- Τα paths που δεν εκπέμπουν: χωρίς player, αλλά με το κλειδί τους — από εδώ
         ξεκινάει ο πελάτης την εκπομπή. Η αναστολή δεν επαναλαμβάνεται ανά stream:
         είναι του πακέτου και το λέει η κεφαλίδα του. -->
    <UCard v-if="p.idle.length">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-circle-pause" class="text-dimmed size-4" />
          <h2 class="mb-0">Δεν εκπέμπουν</h2>
        </div>
      </template>
      <div class="space-y-2">
        <div v-for="s in p.idle" :key="s.path" class="flex items-center gap-2 flex-wrap">
          <strong>{{ s.path }}</strong>
          <code v-if="s.host">{{ rtmp(s) }}</code>
          <SecretKey :text="s.streamKey" />
          <CopyButton :text="s.streamKey" label="" />
          <UButton
            icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost"
            aria-label="Νέο κλειδί" title="Νέο κλειδί" @click="refreshKey(s)"
          />
          <UButton
            icon="i-lucide-trash-2" size="xs" color="error" variant="ghost"
            aria-label="Διαγραφή stream" title="Διαγραφή stream" @click="removeStream(s)"
          />
          <!-- Η διεύθυνση προβολής ισχύει και εκτός εκπομπής: από εδώ την παίρνει
               ο πελάτης για το embed, πριν ανοίξει το OBS. -->
          <template v-if="s.host">
            <code>{{ hls(s) }}</code>
            <CopyButton :text="hls(s)" label="" />
          </template>
        </div>
      </div>
    </UCard>
    </section>

    <!-- Λογαριασμός χωρίς κανένα πακέτο: ούτε κεφαλίδα ούτε λίστα έχουν τι να
         δείξουν. Το σφάλμα το λέει ήδη το UAlert από πάνω. -->
    <UCard v-if="!packs.length && !error">
      <div class="quiet">Δεν υπάρχει πακέτο στον λογαριασμό σου.</div>
    </UCard>

    <!-- Οι αναλυτικές οδηγίες ζουν στο /help — εδώ μένει μόνο η υπενθύμιση ότι το
         κλειδί είναι μυστικό, δίπλα στο ίδιο το κλειδί. -->
    <UAlert
      v-if="streams.length" color="neutral" variant="subtle" icon="i-lucide-book-open"
      title="Πώς συνδέεται το πρόγραμμα εκπομπής"
      description="Το Stream Key είναι μυστικό — όποιος το έχει μπορεί να εκπέμψει στη θέση σου."
    >
      <template #actions>
        <UButton to="/help" size="xs" color="neutral" variant="subtle" trailing-icon="i-lucide-arrow-right">
          Οδηγίες
        </UButton>
      </template>
    </UAlert>
  </div>
</template>

<style scoped>
/* Η ενότητα του πακέτου: οι κάρτες του μαζεύονται κάτω από την κεφαλίδα του, με
   λιγότερο κενό μεταξύ τους απ' ό,τι ανάμεσα σε δύο πακέτα — αλλιώς δεν φαίνεται
   πού τελειώνει το ένα και πού αρχίζει το άλλο. */
.pack { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
.pack-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pack-head h2 { margin: 0; font-size: 16px; }
/* Πακέτο χωρίς όνομα: το «Πακέτο 2» είναι θέση, όχι ταυτότητα — φαίνεται σβηστό
   ώστε να τραβάει το μολύβι δίπλα του. */
.pack-head h2.unnamed { color: var(--muted); font-weight: 500; }
.viewers { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.viewers em { font-style: normal; }
/* Δύο γραφήματα δίπλα-δίπλα όταν χωράνε, το ένα κάτω από το άλλο σε κινητό. */
.charts { padding: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.charts h2 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 0 0 8px; }
/* Πιο νωρίς από το γενικό κατώφλι του .body: τα πεδία του OBS θέλουν πλάτος για
   να μη χρειάζονται κύλιση — με δύο κάρτες δίπλα-δίπλα η στήλη δεξιά από το
   βίντεο δεν φτάνει, ενώ τα νούμερα του /admin στην ίδια θέση χωράνε άνετα. */
@container (max-width: 820px) {
  .body { grid-template-columns: minmax(0, 1fr); }
}
.obs { margin: 0; padding: 16px; align-content: center; }
.obs dt { font-size: 12px; color: var(--muted); }
.obs dd { display: flex; align-items: center; gap: 8px; margin: 4px 0 14px; flex-wrap: wrap; }
.obs code, .idle code {
  flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap;
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 8px; font-size: 13px;
}
.obs .hint { font-size: 12px; color: var(--muted); }
code {
  overflow-x: auto; white-space: nowrap;
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 4px 8px; font-size: 12px;
}
</style>
