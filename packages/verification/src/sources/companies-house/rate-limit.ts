/**
 * Token bucket: `capacity` tokens, refilled continuously over `windowMs`. take() waits until a token
 * is available, so we never exceed the limit. Clock and sleep are injectable for tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) * this.capacity) / this.windowMs,
    );
    this.last = t;
  }

  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) * this.windowMs) / this.capacity));
    }
  }

  /** Server told us to back off (HTTP 429): empty the bucket. */
  drain() {
    this.refill();
    this.tokens = 0;
  }
}
