/**
 * Requests per minute of an API key (its `rate_limit`): a token bucket per key, in memory. A key
 * may make up to its limit at once, then one request per (60 / limit) seconds.
 */
export class KeyRateLimiter {
  private readonly buckets = new Map<number, { tokens: number; at: number }>();

  /** Take one request; when none is left, the seconds until the next one. */
  take(keyId: number, perMinute: number, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    const b = this.buckets.get(keyId);
    const tokens = b ? Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute) : perMinute;
    if (tokens < 1) {
      this.buckets.set(keyId, { tokens, at: now });
      return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - tokens) * 60) / perMinute)) };
    }
    this.buckets.set(keyId, { tokens: tokens - 1, at: now });
    // Keys that were not used for a while start full again: no need to keep them.
    if (this.buckets.size > 10_000) {
      for (const [id, v] of this.buckets) if (now - v.at > 60_000) this.buckets.delete(id);
    }
    return { ok: true };
  }
}
