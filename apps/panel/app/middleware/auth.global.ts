// Global: κάθε σελίδα εκτός του /login θέλει token, και το /admin/** μόνο admin.
// Δεν είναι μέτρο ασφαλείας — τα δικαιώματα τα επιβάλλει το API σε κάθε κλήση.
// Εδώ αποφεύγουμε μόνο τις άδειες οθόνες γεμάτες 401/403.
export default defineNuxtRouteMiddleware((to) => {
  if (to.path === '/login') return

  const session = useSession()
  if (!session) return navigateTo('/login')
  if (to.path.startsWith('/admin') && session.role !== 'admin') return navigateTo('/')
})
