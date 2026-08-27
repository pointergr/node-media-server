import { Injectable } from '@nestjs/common';

// Το τελευταίο snapshot κάθε server, μόνο στη μνήμη — δεν το αντιγράφουμε στο
// sqlite. Server κάτω σημαίνει ότι δεν υπάρχει τίποτα ζωντανό να δεις, και μετά
// από restart του API το /live είναι άδειο μέχρι το επόμενο tick (≤10s).
const OFFLINE_AFTER_MS = 30_000;

export interface StoredSnapshot {
  host: string;
  snapshot: unknown;
  ts: number;
  online: boolean;
}

@Injectable()
export class SyncService {
  private readonly byHost = new Map<string, { snapshot: unknown; ts: number }>();

  record(host: string, snapshot: unknown) {
    this.byHost.set(host, { snapshot, ts: Date.now() });
  }

  latest(host: string): StoredSnapshot | undefined {
    const entry = this.byHost.get(host);
    if (!entry) return undefined;
    return { host, snapshot: entry.snapshot, ts: entry.ts, online: Date.now() - entry.ts < OFFLINE_AFTER_MS };
  }

  all(): StoredSnapshot[] {
    return [...this.byHost.keys()].map((host) => this.latest(host)!);
  }
}
