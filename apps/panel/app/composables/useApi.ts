// Το JWT ζει στο localStorage: το panel είναι στατικό SPA (κανένα Node runtime,
// άρα καμία httpOnly cookie συνεδρία να το κρατήσει) και ο browser το στέλνει
// μόνος του ως Bearer. Σε 401 φεύγει το token και ο χρήστης πάει στο /login.
const KEY = 'pointer_token'
// Το token του admin όσο βλέπει το panel ως πελάτης. Δεύτερο κλειδί και όχι
// stack: μία φωλιά αρκεί — ο admin δεν μπαίνει ως πελάτης μέσα από πελάτη (το
// /admin/* είναι κλειστό όσο η συνεδρία είναι πελάτη).
const ADMIN_KEY = 'pointer_admin_token'

export interface Session {
  sub: number
  role: 'admin' | 'customer'
  clientId: number | null
  exp: number
}

export const getToken = () => import.meta.client ? localStorage.getItem(KEY) : null
export const setToken = (t: string) => localStorage.setItem(KEY, t)
// Και τα δύο κλειδιά: ένα 401 εν ώρα impersonation αλλιώς αφήνει πίσω το token
// του admin, που θα ξυπνούσε στην επόμενη σύνδεση — με μπάρα «επιστροφή στη
// διαχείριση» μπροστά σε πελάτη.
export const clearToken = () => {
  localStorage.removeItem(KEY)
  localStorage.removeItem(ADMIN_KEY)
}

// Χωρίς `import.meta.client` όπως το setToken/clearToken: το panel είναι
// `ssr: false`, τίποτα από αυτά δεν τρέχει ποτέ σε server.
export const impersonating = () => !!localStorage.getItem(ADMIN_KEY)

// Σκέτο base64url decode του payload — καμία εξάρτηση και καμία επαλήθευση
// υπογραφής: την υπογραφή την ελέγχει το API. Εδώ μας νοιάζει μόνο να μη
// δείχνουμε οθόνες που ο χρήστης δεν έχει δικαίωμα να δει (και να μην κρατάμε
// ληγμένο token, που θα έδινε 401 σε κάθε κλήση).
export function useSession(): Session | null {
  const t = getToken()
  if (!t) return null
  try {
    const payload = JSON.parse(atob(t.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Session
    return payload.exp * 1000 > Date.now() ? payload : null
  }
  catch {
    return null
  }
}

export function useApi() {
  const base = useRuntimeConfig().public.apiBase

  return async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const t = getToken()
    const res = await fetch(base + path, {
      ...opts,
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(t ? { authorization: `Bearer ${t}` } : {}),
        ...opts.headers,
      },
    })
    if (res.status === 401) {
      clearToken()
      await navigateTo('/login')
      throw new Error('η συνεδρία έληξε')
    }
    if (!res.ok) {
      // Το Nest βγάζει {message} — δείξ' το, είναι στα ελληνικά όπου το γράψαμε εμείς.
      const body = await res.json().catch(() => null) as { message?: string } | null
      throw new Error(body?.message || `HTTP ${res.status}`)
    }
    // Κάθε DELETE του API απαντάει 200 με άδειο σώμα (Nest, handler χωρίς return):
    // σκέτο res.json() έσκαγε με «Unexpected end of JSON input», δηλαδή η διαγραφή
    // γινόταν κανονικά αλλά η οθόνη έδειχνε σφάλμα και τη λίστα αναλλοίωτη — το
    // `await load()` της κάθε σελίδας δεν προλάβαινε να τρέξει.
    const body = await res.text()
    return (body ? JSON.parse(body) : null) as T
  }
}

// Ο admin βλέπει το panel ως πελάτης, χωρίς να αποσυνδεθεί. Δεν χρειάστηκε τίποτα
// νέο στο API: το `POST /auth/login-link` (admin-only) φτιάχνει ήδη συνεδρία
// οποιουδήποτε πελάτη για το billing — εδώ την ξοδεύουμε αμέσως εμείς, αντί να
// φύγει σε redirect. Το token του admin μένει μόνο τοπικά, δεν πάει ποτέ πίσω
// στον server.
// Πλήρης φόρτωση και όχι navigateTo: το token ζει στο localStorage, που δεν
// είναι reactive — με client-side navigation το layout κρατούσε το παλιό ρόλο
// (μενού «Πελάτες», σήμα «διαχειριστής») μέχρι το επόμενο refresh.
const reload = (to: string) => { location.href = to }

export async function impersonate(clientId: number) {
  const api = useApi()
  const { url } = await api<{ url: string }>('/auth/login-link', {
    method: 'POST',
    body: JSON.stringify({ clientId }),
  })
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('t')
  const { access_token } = await api<{ access_token: string }>('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  // Πρώτα φυλάμε, μετά αντικαθιστούμε: ανάποδα, ένα σφάλμα ανάμεσα στα δύο
  // αφήνει τον admin έξω από τον δικό του λογαριασμό.
  localStorage.setItem(ADMIN_KEY, localStorage.getItem(KEY)!)
  setToken(access_token)
  reload('/')
}

export function stopImpersonating() {
  const admin = localStorage.getItem(ADMIN_KEY)
  if (!admin) return
  localStorage.removeItem(ADMIN_KEY)
  setToken(admin)
  reload('/admin')
}
