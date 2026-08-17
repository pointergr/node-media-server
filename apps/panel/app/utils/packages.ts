// Οι αγορές ενός πελάτη, όπως τις στέλνει και τις δέχεται το API
// (apps/api/README.md#clients). Ο server είναι της **αγοράς**, όχι του πελάτη:
// το πακέτο μπορεί να δείχνει αλλού σήμερα απ' ό,τι τη μέρα που αγοράστηκε.
export interface PackageLine { packageId: number, serverId: number, qty: number }
export interface PackageRow { id: number, name: string, maxViewers: number, maxStreams: number, serverId: number }

// Τα όρια είναι ανά server — ο ίδιος κανόνας με το API
// (clients.service.ts#maxViewersOf). Εδώ μόνο για να βλέπει ο διαχειριστής τι
// αγοράζει· η επιβολή γίνεται εκεί.
export function totalsByServer(lines: PackageLine[], catalog: PackageRow[]) {
  const totals: Record<number, { viewers: number, streams: number }> = {}
  for (const line of lines) {
    const pkg = catalog.find(p => p.id === line.packageId)
    if (!pkg || !line.qty) continue
    const t = totals[line.serverId] ??= { viewers: 0, streams: 0 }
    t.viewers += line.qty * pkg.maxViewers
    t.streams += line.qty * pkg.maxStreams
  }
  return totals
}

// Οι γραμμές που δείχνει το κουτί των πακέτων: οι υπάρχουσες αγορές (με τον
// server τους) και από πάνω ο κατάλογος με τον **σημερινό** server του κάθε
// πακέτου, ποσότητα 0. Έτσι ο πελάτης που έχει «basic στον stream1» βλέπει
// ξεχωριστή γραμμή «basic στον stream2» όταν το πακέτο αλλάξει μηχάνημα — και
// η επόμενη αγορά του πάει εκεί, χωρίς να μετακομίσει η παλιά.
export function packageLines(owned: PackageLine[], catalog: PackageRow[]): PackageLine[] {
  const lines = owned.map(o => ({ ...o }))
  for (const p of catalog) {
    if (!lines.some(l => l.packageId === p.id && l.serverId === p.serverId)) {
      lines.push({ packageId: p.id, serverId: p.serverId, qty: 0 })
    }
  }
  return lines
}
