// Μεταφορά από το παλιό admin/index.html του stream server. Οι μορφοποιήσεις και
// το chart είναι δοκιμασμένα και χωρίς εξαρτήσεις — μένουν σκέτη DOM λογική αντί
// για components, ώστε η διαφορά με το παλιό να είναι αναγνώσιμη.

// --- σχήμα των απαντήσεων του API ------------------------------------------
export interface StreamRow {
  stream: string
  ip: string
  protocol: string
  since: number
  video: string
  resolution: string
  // Τα σκαλοπάτια που κωδικοποιεί όντως ο ffmpeg αυτή τη στιγμή — άδειο σε κάθε
  // εκπομπή χωρίς ABR, και σε πηγή που είναι ήδη πιο χαμηλή από το ladder του
  // πακέτου (stats.js#snapshot). Παλιός stream server: απόν.
  ladder?: number[]
  audio: string
  viewers: number
  in_bps: number
  out_bps: number
}

export interface SessionRow {
  id: string
  stream: string
  ip: string
  protocol: string
  publisher: boolean
  since: number
  inBytes: number
  outBytes: number
}

export interface Snapshot {
  streams: StreamRow[]
  sessions: SessionRow[]
  server: { uptime: number, rss_mb: number, node: string }
  r2Estimate: boolean
}

// GET /live — ένα entry ανά server· `online: false` όταν το τελευταίο sync είναι
// παλιότερο από 30s (το API δεν σβήνει το snapshot, το μαρκάρει).
export interface LiveEntry {
  host: string
  snapshot: Snapshot
  ts: number
  online: boolean
}

export interface PastRow {
  id: number
  stream: string
  ip: string
  protocol: string
  publisher: number
  start_ts: number
  end_ts: number
  in_bytes: number
  out_bytes: number
}

export interface Series {
  bucket: number
  from: number
  streams: { t: number, stream: string, in_bps: number, out_bps: number, viewers: number }[]
  server: { t: number, cpu_pct: number, mem_mb: number }[]
}

export interface Line {
  name: string
  color: string
  points: [number, number][]
}

// --- μορφοποίηση ------------------------------------------------------------
// Συμπαγές, αλλιώς τα labels του άξονα ξεφεύγουν από το viewBox
export const bps = (v: number) => v >= 1e9
  ? (v / 1e9).toFixed(1) + ' Gbps'
  : v >= 1e8
    ? Math.round(v / 1e6) + ' Mbps'
    : v >= 1e6
      ? (v / 1e6).toFixed(1) + ' Mbps'
      : v >= 1e3 ? Math.round(v / 1e3) + ' kbps' : Math.round(v) + ' bps'

export const bytes = (v: number) => v >= 1e9
  ? (v / 1e9).toFixed(1) + ' GB'
  : v >= 1e6 ? (v / 1e6).toFixed(1) + ' MB' : Math.round(v / 1e3) + ' kB'

export const dur = (s: number) => {
  s = Math.max(0, Math.round(s))
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60)
  return d ? `${d}μ ${h}ω` : h ? `${h}ω ${m}λ` : `${m}λ ${s % 60}δ`
}

// Τα κλειδιά τα ορίζει το apps/stream/stats.js#RANGES (πόσο πίσω, τι bucket) —
// εδώ μόνο η ελληνική ετικέτα τους. Κοινά σε /admin και user panel: άγνωστο
// range δεν βγάζει σφάλμα, ο stream server πέφτει σιωπηλά στο 24ωρο και ο
// χρήστης βλέπει λάθος τίτλο πάνω από σωστό γράφημα.
export const RANGES: Record<string, string> = {
  '1h': '1 ώρα',
  '24h': '24 ώρες',
  '7d': '7 ημέρες',
  '30d': '30 ημέρες',
}

// Το Chart.js με άξονα `linear` και χωρίς όρια μαζεύει τον άξονα x γύρω από τα
// σημεία: μία ώρα εκπομπής ζωγραφίζεται ίδια είτε ζητήθηκε 1 ώρα είτε 30 μέρες,
// και ο επιλογέας διαστήματος φαίνεται χαλασμένος ενώ τα δεδομένα είναι σωστά.
// Ο άξονας δείχνει το ΖΗΤΟΥΜΕΝΟ παράθυρο (το `from` της απάντησης έως τώρα) —
// το ίδιο κάνει και το lineChart του /admin, γι' αυτό εκεί δεν φάνηκε ποτέ.
// Χωρίς `from` (server κάτω, πριν την πρώτη απάντηση) κανένα όριο: min=0
// σημαίνει άξονας από το 1970 και γράφημα οπτικά άδειο.
export const xWindow = (from: number, now = Math.floor(Date.now() / 1000)) =>
  from > 0 ? { min: from, max: now } : {}

export const clock = (ts: number) => new Date(ts * 1000)
  .toLocaleString('el-GR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

// Πορτοκαλί πρώτο: το ένα stream είναι η συνηθισμένη περίπτωση και το μπλε
// μένει έτσι αποκλειστικά για το CPU, που δεν είναι stream.
const SLOTS = ['--s2', '--s1', '--s3']
const streamColors = new Map<string, string>() // το χρώμα ακολουθεί το stream, όχι τη σειρά του

export const colorOf = (name: string) => {
  if (!streamColors.has(name)) {
    streamColors.set(name, `var(${SLOTS[streamColors.size % SLOTS.length]})`)
  }
  return streamColors.get(name)!
}

// --- chart ------------------------------------------------------------------
export function lineChart(
  host: HTMLElement,
  series: Line[],
  fmt: (v: number) => string,
  from: number,
  to: number,
  bucket: number,
) {
  const live = series.filter(s => s.points.length)
  if (!live.length) {
    host.innerHTML = `<div class="empty">Δεν υπάρχουν δεδομένα για αυτό το διάστημα</div>`
    return
  }
  const W = 640, H = 190, PL = 66, PR = 12, PT = 10, PB = 24
  const max = Math.max(1, ...live.flatMap(s => s.points.map(p => p[1])))
  const top = niceMax(max)
  const x = (t: number) => PL + (t - from) / Math.max(1, to - from) * (W - PL - PR)
  const y = (v: number) => PT + (1 - v / top) * (H - PT - PB)

  const grid = [0, .5, 1].map((f) => {
    const v = top * f, yy = y(v).toFixed(1)
    return `<line x1="${PL}" x2="${W - PR}" y1="${yy}" y2="${yy}" stroke="var(--grid)"/>
      <text x="${PL - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle"
        fill="var(--muted)" font-size="11">${fmt(v)}</text>`
  }).join('')

  const ticks = [0, .33, .66, 1].map((f) => {
    const t = from + (to - from) * f
    return `<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}"
      fill="var(--muted)" font-size="11">${clock(t)}</text>`
  }).join('')

  const paths = live.map(s =>
    `<path d="${curve(s.points.map(p => [x(p[0]), y(p[1])]))}" fill="none" stroke="${s.color}"
      stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')

  const legend = live.length > 1
    ? `<div class="legend">` + live.map(s =>
      `<span><i class="swatch" style="background:${s.color}"></i>${s.name}</span>`).join('') + `</div>`
    : ''

  host.innerHTML = legend
    + `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="χρονοσειρά">
      ${grid}${ticks}
      <line x1="${PL}" x2="${W - PR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)"/>
      <g class="cross"></g>${paths}
    </svg><div class="tip"></div>`

  const svg = host.querySelector('svg')!
  const tip = host.querySelector('.tip') as HTMLElement
  const cross = host.querySelector('.cross')!
  svg.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect()
    const t = from + (ev.clientX - box.left) / box.width * W < PL
      ? from
      : from + ((ev.clientX - box.left) / box.width * W - PL) / (W - PL - PR) * (to - from)
    // Σειρά χωρίς δείγμα κοντά στον δείκτη δεν μπαίνει στο tooltip — αλλιώς
    // δείχνει τιμή σε διάστημα που το stream ήταν εκτός.
    const rows = live.map(s => ({
      s, p: s.points.reduce((a, b) => Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a),
    })).filter(r => Math.abs(r.p[0] - t) <= bucket * 1.5)
    if (!rows.length) {
      tip.style.opacity = '0'
      cross.innerHTML = ''
      return
    }
    const at = rows[0]!.p[0]
    cross.innerHTML = `<line x1="${x(at).toFixed(1)}" x2="${x(at).toFixed(1)}" y1="${PT}" y2="${H - PB}"
      stroke="var(--axis)" stroke-dasharray="3 3"/>` + rows.map(r =>
      `<circle cx="${x(r.p[0]).toFixed(1)}" cy="${y(r.p[1]).toFixed(1)}" r="4"
        fill="${r.s.color}" stroke="var(--surface-1)" stroke-width="2"/>`).join('')
    tip.innerHTML = `<b>${clock(at)}</b>` + rows.map(r =>
      `<div class="row"><i class="swatch" style="background:${r.s.color}"></i>${r.s.name}: ${fmt(r.p[1])}</div>`).join('')
    tip.style.opacity = '1'
    tip.style.left = Math.min(box.width - tip.offsetWidth - 4,
      Math.max(0, x(at) / W * box.width + 10)) + 'px'
    // τα <svg> δεν έχουν offsetTop, οπότε το ύψος βγαίνει από τα rects
    tip.style.top = (box.top - host.getBoundingClientRect().top + 8) + 'px'
  })
  svg.addEventListener('pointerleave', () => {
    tip.style.opacity = '0'
    cross.innerHTML = ''
  })
}

// Καμπύλη με control points τα ίδια τα δείγματα και άκρα τα μέσα των τμημάτων:
// κάθε τόξο μένει μέσα στο κυρτό περίβλημα δύο διαδοχικών σημείων, οπότε δεν
// εφευρίσκει ούτε κορυφές ούτε βυθίσματα κάτω από το μηδέν — μια Catmull-Rom θα
// ζωγράφιζε αρνητικό bitrate μετά από αιχμή. Τίμημα: η μεμονωμένη αιχμή
// στρογγυλεύει λίγο.
const xy = (p: number[]) => `${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`

export function curve(pts: number[][]) {
  if (pts.length < 3) return 'M' + pts.map(xy).join(' L')
  let d = `M${xy(pts[0]!)}`
  for (let i = 1; i < pts.length - 1; i++) {
    d += ` Q${xy(pts[i]!)} ${xy([(pts[i]![0]! + pts[i + 1]![0]!) / 2, (pts[i]![1]! + pts[i + 1]![1]!) / 2])}`
  }
  return `${d} L${xy(pts.at(-1)!)}`
}

export function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  return Math.ceil(v / p * 2) / 2 * p
}
