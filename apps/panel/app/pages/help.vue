<script setup lang="ts">
// Οδηγίες, μία σελίδα για όλους τους ρόλους. Σήμερα μόνο το OBS — γι' αυτό
// υπάρχει ξεχωριστή σελίδα αντί για alert στο `/`: εδώ χωράνε και οι επόμενες.
const api = useApi()

// Ο πελάτης βλέπει τις **δικές του** τιμές έτοιμες για αντιγραφή αντί για
// <domain> placeholders· ο admin δεν έχει clientId, άρα άδεια λίστα και πέφτουμε
// στα placeholders. Σφάλμα (server κάτω) το ίδιο: οδηγίες χωρίς τιμές, όχι οθόνη
// με 500.
const mine = ref<{ path: string, streamKey: string, host?: string }[]>([])
onMounted(async () => {
  mine.value = await api<typeof mine.value>('/me/streams').catch(() => [])
})

// Ίδιοι τύποι με το index.vue: RTMP στο `rtmp.<domain>`, application το πρώτο
// κομμάτι του path.
const s = computed(() => mine.value[0])
const server = computed(() => s.value?.host
  ? `rtmp://rtmp.${s.value.host}/${s.value.path.split('/')[1]}`
  : 'rtmp://rtmp.<domain>/live')
const key = computed(() => s.value?.streamKey ?? '<όνομα>?key=<κλειδί>')
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">
      Οδηγίες
    </h1>

    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-monitor-play" class="text-primary size-5" />
          <h2 class="mb-0">Σύνδεση του OBS</h2>
        </div>
      </template>

      <div class="space-y-6">
        <section>
          <h3><code class="path">OBS → Settings → Stream</code></h3>
          <dl>
            <dt>Service</dt>
            <dd><code>Custom...</code></dd>

            <dt>Server</dt>
            <dd>
              <code>{{ server }}</code>
              <CopyButton v-if="s?.host" :text="server" label="" />
            </dd>

            <dt>Stream Key</dt>
            <dd>
              <code>{{ key }}</code>
              <CopyButton v-if="s" :text="key" label="" />
            </dd>
          </dl>
          <p v-if="!s" class="hint">
            Τις δικές σου τιμές τις βρίσκεις στη σελίδα «Τα streams μου», με κουμπί
            αντιγραφής δίπλα στην καθεμία.
          </p>
          <p class="hint">
            Το Stream Key είναι μυστικό — όποιος το έχει μπορεί να εκπέμψει στη θέση σου.
            Αν διαρρεύσει, βγάλε νέο από τη σελίδα «Τα streams μου».
          </p>
        </section>

        <section>
          <h3><code class="path">OBS → Settings → Output → Output Mode: Advanced → Streaming</code></h3>
          <dl>
            <dt>Keyframe Interval</dt>
            <dd>
              <code>2</code>
              <span class="hint">υποχρεωτικό — αλλιώς σπάει το HLS</span>
            </dd>

            <dt>Encoder</dt>
            <dd>
              <code>x264</code> ή <code>NVENC</code>
              <span class="hint">NVENC αν υπάρχει κάρτα NVIDIA — αφήνει ελεύθερο τον επεξεργαστή</span>
            </dd>

            <dt>Rate Control</dt>
            <dd>
              <code>CBR</code>
              <span class="hint">σταθερό bitrate, το ζητάει το RTMP</span>
            </dd>

            <dt>Bitrate</dt>
            <dd>
              <code>2500–6000 Kbps</code>
              <span class="hint">όσο αντέχει η γραμμή upload — 1080p30 θέλει ~4500</span>
            </dd>
          </dl>
        </section>

        <section>
          <h3>Έλεγχος</h3>
          <p class="hint">
            Πάτα «Start Streaming» στο OBS και άνοιξε τη σελίδα «Τα streams μου»: μέσα σε
            λίγα δευτερόλεπτα η εκπομπή εμφανίζεται με preview και θεατές. Αν δεν
            εμφανιστεί, τα συνηθισμένα είναι λάθος Stream Key ή firewall που κόβει τη θύρα
            1935.
          </p>
        </section>
      </div>
    </UCard>

    <!-- Χωριστή κάρτα και όχι ενότητα του OBS: η αναδιανομή δεν ρυθμίζεται στο
         OBS, ρυθμίζεται εδώ. Ο πελάτης που την ψάχνει δεν ψάχνει «σύνδεση OBS». -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-share-2" class="text-primary size-5" />
          <h2 class="mb-0">Αναδιανομή σε YouTube, Facebook και άλλα</h2>
        </div>
      </template>

      <div class="space-y-6">
        <section>
          <h3>Τι κάνει</h3>
          <p class="hint">
            Εκπέμπεις μία φορά σε εμάς, και εμείς προωθούμε την ίδια εκπομπή και στο δικό σου
            κανάλι. Το πρόγραμμα εκπομπής σου στέλνει ένα μόνο σήμα — τη δουλειά την κάνει ο
            server, όχι η γραμμή σου.
          </p>
        </section>

        <section>
          <h3>Πώς συνδέεται το κανάλι σου</h3>
          <ol class="steps">
            <li>Στην πλατφόρμα (YouTube Studio → «Ζωντανή μετάδοση», Facebook → Live Producer,
              Twitch → Settings → Stream) βρες τα δύο πεδία: <b>Stream URL</b> και
              <b>Stream key</b>.</li>
            <li>Στη σελίδα «Τα streams μου», κάτω από το stream σου, πάτα
              <b>Αναδιανομή → Προσθήκη</b>.</li>
            <li>Διάλεξε την πλατφόρμα (ή «Άλλο» για οποιαδήποτε άλλη που δέχεται RTMP) και
              κόλλησε τα δύο πεδία.</li>
          </ol>
          <p class="hint">
            Η αλλαγή ισχύει από την <b>επόμενη</b> εκπομπή: αν εκπέμπεις αυτή τη στιγμή,
            σταμάτα και ξεκίνα ξανά για να πιάσει.
          </p>
        </section>

        <section>
          <h3>Αν το κανάλι δεν παίρνει σήμα</h3>
          <p class="hint">
            Δίπλα στον προορισμό εμφανίζεται «στέλνει» ή «επανασύνδεση». Το «επανασύνδεση»
            συνήθως <b>δεν</b> είναι βλάβη: οι περισσότερες πλατφόρμες κλείνουν τη σύνδεση
            όσο δεν έχεις πατήσει «Go live» στη δική τους σελίδα — μόλις το πατήσεις, η
            σύνδεση πιάνει μόνη της. Αν επιμένει, έλεγξε το Stream key (τα κλειδιά αλλάζουν
            όταν φτιάχνεις νέα μετάδοση σε κάποιες πλατφόρμες).
          </p>
          <p class="hint">
            Η εκπομπή προωθείται <b>όπως ακριβώς την στέλνεις</b>, χωρίς μετατροπή. Αν παίζει
            σε εμάς αλλά όχι στην πλατφόρμα, το αίτιο είναι σχεδόν πάντα οι ρυθμίσεις του
            προγράμματος εκπομπής: keyframe interval 2 δευτερόλεπτα, ήχος AAC, και bitrate
            μέσα στο όριο της πλατφόρμας (το Twitch κόβει πάνω από ~6 Mbps).
          </p>
        </section>
      </div>
    </UCard>
  </div>
</template>

<style scoped>
h2, h3 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
h3 { font-weight: 500; }
h3 .path { white-space: normal; }
dl { margin: 0; }
dt { font-size: 12px; color: var(--muted); }
dd { display: flex; align-items: center; gap: 8px; margin: 4px 0 14px; flex-wrap: wrap; }
code {
  overflow-x: auto; white-space: nowrap;
  background: var(--plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 4px 8px; font-size: 13px;
}
.hint { font-size: 12px; color: var(--muted); }
.steps { margin: 0 0 8px; padding-left: 20px; font-size: 13px; }
.steps li { margin-bottom: 4px; }
</style>
