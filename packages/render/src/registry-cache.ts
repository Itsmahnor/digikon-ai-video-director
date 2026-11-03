import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A fingerprint of a folder of JSON records: every file's relative path, size and modification time, in name order. It changes whenever a record is added,
 * removed or rewritten, which is exactly when the capability registry must be rebuilt. A missing folder fingerprints as "none".
 */
export function directoryStamp(dir: string | null | undefined): string {
  if (!dir) return "none";
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = join(d, n), r = rel ? `${rel}/${n}` : n;
      try {
        const s = statSync(p);
        if (s.isDirectory()) walk(p, r);
        else if (n.endsWith(".json")) parts.push(`${r}:${s.size}:${Math.round(s.mtimeMs)}`);
      } catch { /* a file removed while listing is simply gone */ }
    }
  };
  walk(dir, "");
  return parts.length ? parts.join("|") : "none";
}

/** Keeps the last built value while its key is unchanged and it is younger than `ttlMs` (a bound on how long a change nothing watches, such as an installed browser, can go unseen). */
export class KeyedCache<T> {
  private held: { key: string; at: number; value: T } | null = null;
  hits = 0;
  builds = 0;
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}
  get(key: string, build: () => T): T {
    const t = this.now();
    if (this.held && this.held.key === key && t - this.held.at < this.ttlMs) { this.hits++; return this.held.value; }
    const value = build();
    this.builds++;
    this.held = { key, at: t, value };
    return value;
  }
  clear(): void { this.held = null; }
}
