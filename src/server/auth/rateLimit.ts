// In-memory sliding-window limiter. State resets on restart, which is acceptable for a single container.
export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number }

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  /** Records one attempt under `key` and reports whether it stays within `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number, now: number): RateLimitResult {
    this.sweep(now, windowMs);
    const stamps = (this.hits.get(key) ?? []).filter(stamp => stamp > now - windowMs);
    if (stamps.length >= limit) {
      this.hits.set(key, stamps);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((stamps[0]! + windowMs - now) / 1000)) };
    }
    stamps.push(now);
    this.hits.set(key, stamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forgets attempts under `key` (e.g. after a successful login). */
  clear(key: string): void { this.hits.delete(key); }

  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, stamps] of this.hits) {
      const live = stamps.filter(stamp => stamp > now - windowMs);
      if (live.length === 0) this.hits.delete(key); else this.hits.set(key, live);
    }
  }
}
