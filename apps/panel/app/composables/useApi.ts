// Το JWT ζει στο localStorage: το panel είναι στατικό SPA (κανένα Node runtime,
// άρα καμία httpOnly cookie συνεδρία να το κρατήσει) και ο browser το στέλνει
// μόνος του ως Bearer. Σε 401 φεύγει το token και ο χρήστης πάει στο /login.
const KEY = 'pointer_token'

export interface Session {
  sub: number
  role: 'admin' | 'customer'
  clientId: number | null
  exp: number
}

export const getToken = () => import.meta.client ? localStorage.getItem(KEY) : null
export const setToken = (t: string) => localStorage.setItem(KEY, t)
export const clearToken = () => localStorage.removeItem(KEY)

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
