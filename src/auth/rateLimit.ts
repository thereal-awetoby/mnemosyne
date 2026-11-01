/** Fixed-window-ish limiter kept in memory: at most `max` hits per `windowMs` per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** true if this hit is allowed (and counted), false if the key is over its limit. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return true;
  }
}
