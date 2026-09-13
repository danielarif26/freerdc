export type Clock = () => number;

export class TokenBucket {
  private capacity: number;
  private refillRate: number; // tokens per second
  private tokens: number;
  private lastRefill: number;
  private clock: Clock;

  constructor(
    capacity: number,
    refillRate: number,
    options?: { clock?: Clock; initialTokens?: number }
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive finite number");
    }
    if (!Number.isFinite(refillRate) || refillRate < 0) {
      throw new RangeError("refillRate must be a non-negative finite number");
    }
    const initialTokens = options?.initialTokens ?? capacity;
    if (!Number.isFinite(initialTokens) || initialTokens < 0 || initialTokens > capacity) {
      throw new RangeError("initialTokens must be finite and between 0 and capacity");
    }
    this.clock = options?.clock ?? Date.now;
    const now = this.clock();
    if (!Number.isFinite(now)) throw new RangeError("clock must return a finite number");
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = initialTokens;
    this.lastRefill = now;
  }

  tryRemove(n: number = 1): boolean {
    if (!Number.isFinite(n) || n <= 0) {
      throw new RangeError("n must be a positive finite number");
    }
    const now = this.clock();
    if (!Number.isFinite(now)) throw new RangeError("clock must return a finite number");
    this.refill(now);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  private refill(now: number): void {
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    const elapsedSec = elapsedMs / 1000;
    const toAdd = elapsedSec * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + toAdd);
    this.lastRefill = now;
  }
}
