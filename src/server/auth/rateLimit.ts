// In-memory sliding-window limiter. State resets on restart, which is acceptable for a single container.
export interface RateLimitResult { allowed: boolean; retryAfterSeconds: number }
interface Bucket { stamps: number[]; windowMs: number }

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  /** Records one attempt under `key` and reports whether it stays within `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number, now: number): RateLimitResult {
    this.sweep(now);
    const bucket = this.buckets.get(key) ?? { stamps: [], windowMs };
    bucket.windowMs = windowMs;
    bucket.stamps = bucket.stamps.filter(stamp => stamp > now - windowMs);
    if (bucket.stamps.length >= limit) {
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.stamps[0]! + windowMs - now) / 1000)) };
    }
    bucket.stamps.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forgets attempts under `key` (e.g. after a successful login). */
  clear(key: string): void { this.buckets.delete(key); }

  /** Drops buckets whose own window has fully elapsed; runs at most once a minute. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.stamps.every(stamp => stamp <= now - bucket.windowMs)) this.buckets.delete(key);
    }
  }
}
