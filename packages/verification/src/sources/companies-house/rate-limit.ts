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

/**
 * Header-driven limiter (approved change): Companies House tells us, on every response, how many
 * calls are left in the window and when it resets. We follow that:
 *  - before a call, if the remaining quota is at or below `reserve`, pause until the reset time;
 *  - on HTTP 429, pause until the reset time (not exponential backoff), then carry on.
 * If a response carries no headers, the token bucket (a conservative ceiling) still applies.
 * ASSUMED header names (verify at cutover): X-Ratelimit-Limit, X-Ratelimit-Remain,
 * X-Ratelimit-Reset (epoch seconds), X-Ratelimit-Window.
 */
export class HeaderRateLimiter {
  remaining: number | null = null;
  resetAtMs: number | null = null;
  pauses = 0;
  pausedMs = 0;

  constructor(
    private readonly bucket: TokenBucket,
    private readonly opts: { reserve: number; fallbackWindowMs: number },
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async pauseUntilReset() {
    const until =
      this.resetAtMs && this.resetAtMs > this.now()
        ? this.resetAtMs
        : this.now() + this.opts.fallbackWindowMs;
    const wait = until - this.now() + 1000; // +1s so we land after the reset
    this.pauses++;
    this.pausedMs += wait;
    await this.sleep(wait);
    this.remaining = null;
    this.resetAtMs = null;
  }

  async beforeRequest() {
    if (this.remaining !== null && this.remaining <= this.opts.reserve)
      await this.pauseUntilReset();
    await this.bucket.take();
  }

  /** Read the quota headers from any response. */
  observe(headers: Headers) {
    const remain = Number(headers.get("x-ratelimit-remain"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (headers.has("x-ratelimit-remain") && Number.isFinite(remain)) this.remaining = remain;
    if (headers.has("x-ratelimit-reset") && Number.isFinite(reset) && reset > 0)
      this.resetAtMs = reset * 1000;
  }

  async on429() {
    this.bucket.drain();
    await this.pauseUntilReset();
  }
}
