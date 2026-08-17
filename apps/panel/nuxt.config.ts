// Στατικό SPA: `nuxt generate` → .output/public, το σερβίρει ο Caddy με fallback
// στο index.html. Κανένα Node runtime για το UI (PLAN-monorepo.md, «Αποφάσεις»).
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2026-08-13',
  devtools: { enabled: false },
  modules: ['@nuxt/ui'],
  // Σειρά: πρώτα το Nuxt UI (Tailwind), μετά τα δικά μας. Το dashboard.css
  // κρατάει πια μόνο ό,τι δεν καλύπτει το Nuxt UI — γραφήματα, πίνακες, κάρτες
  // εκπομπής — και δανείζεται τα χρώματά του από τα --ui-* tokens.
  css: ['~/assets/css/main.css', '~/assets/dashboard.css'],

  runtimeConfig: {
    public: {
      // Ο Caddy του κεντρικού host κάνει `uri strip_prefix /api` και προωθεί στο
      // Nest, οπότε από τον browser όλα τα endpoints ζουν κάτω από /api.
      apiBase: '/api',
    },
  },

  // Στο `npm run dev` δεν υπάρχει Caddy μπροστά: το ίδιο /api/* πάει κατευθείαν
  // στο Nest του localhost, χωρίς το πρόθεμα (το h3 το κόβει από το path).
  nitro: {
    devProxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },

  app: {
    head: {
      title: 'Pointer panel',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
})
