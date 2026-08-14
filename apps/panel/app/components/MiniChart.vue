<script setup lang="ts">
// Chart.js μόνο εδώ, στο user panel· το /admin ζωγραφίζει ακόμα με το lineChart
// του utils/dash.ts (SVG). Δεν κάνουμε tree-shaking με αυτόματο registration:
// φορτώνουμε ρητά τα κομμάτια που χρησιμοποιούμε, ώστε το bundle να μη σέρνει
// όλα τα chart types για μία γραμμή.
import {
  Chart, Filler, LineController, LineElement, LinearScale, PointElement, Tooltip,
} from 'chart.js'
import { clock } from '~/utils/dash'

Chart.register(LineController, LineElement, PointElement, LinearScale, Filler, Tooltip)

const props = defineProps<{
  points: [number, number][] // [unix seconds, τιμή]
  color: string // όνομα CSS variable, π.χ. '--s2'
  fmt: (v: number) => string
}>()

const canvas = ref<HTMLCanvasElement>()
let chart: Chart | null = null

// Ο canvas δεν καταλαβαίνει `var(--s2)` — θέλει πραγματικό χρώμα. Διαβάζεται σε
// κάθε render γιατί αλλάζει με το θέμα του συστήματος (dark mode).
const resolve = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'

function render() {
  if (!canvas.value) return
  const line = resolve(props.color)
  const data = props.points.map(([t, v]) => ({ x: t, y: v }))

  if (chart) {
    chart.data.datasets[0]!.data = data
    chart.data.datasets[0]!.borderColor = line
    chart.update('none') // χωρίς animation: το refresh είναι ανά 10s, θα «χόρευε» συνεχώς
    return
  }

  chart = new Chart(canvas.value, {
    type: 'line',
    data: { datasets: [{ data, borderColor: line, borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // Ο άξονας x είναι linear με unix seconds, όχι TimeScale: εκείνο θέλει
      // date adapter (δεύτερη εξάρτηση) για να μορφοποιήσει ημερομηνίες, ενώ
      // εδώ αρκεί το clock() που έχουμε ήδη.
      scales: {
        x: {
          type: 'linear',
          grid: { color: resolve('--grid') },
          ticks: { color: resolve('--muted'), maxTicksLimit: 5, callback: v => clock(Number(v)) },
        },
        y: {
          beginAtZero: true,
          grid: { color: resolve('--grid') },
          ticks: { color: resolve('--muted'), maxTicksLimit: 4, callback: v => props.fmt(Number(v)) },
        },
      },
      plugins: {
        legend: { display: false }, // μία γραμμή ανά chart, ο τίτλος της κάρτας το λέει ήδη
        tooltip: {
          callbacks: {
            title: items => clock(Number(items[0]!.parsed.x)),
            label: item => props.fmt(item.parsed.y ?? 0),
          },
        },
      },
    },
  })
}

onMounted(render)
watch(() => props.points, render)
onBeforeUnmount(() => chart?.destroy())
</script>

<template>
  <div class="mini">
    <canvas ref="canvas" />
    <div v-if="!points.length" class="empty">Δεν υπάρχουν δεδομένα ακόμα</div>
  </div>
</template>

<style scoped>
.mini { position: relative; height: 140px; }
.empty {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 12px; color: var(--muted);
}
</style>
