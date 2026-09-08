/**
 * TokenBucket — High-Performance In-Memory Token Bucket Rate Limiter
 * 
 * Provides allocation-free rate limiting per connection with burst capacity
 * and sliding window violation tracking for persistent abuse detection.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second
  private tokens: number;
  private lastRefillTime: number; // milliseconds
  private violationCount: number = 0;
  private lastViolationTime: number = 0;

  /**
   * @param capacity Maximum burst capacity (tokens)
   * @param refillRate Number of tokens replenished per second
   */
  constructor(capacity: number = 50, refillRate: number = 100) {
    this.capacity = Math.max(1, capacity);
    this.refillRate = Math.max(0.1, refillRate);
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Attempts to consume tokens. Replenishes available tokens based on elapsed time.
   * Returns true if sufficient tokens were available and consumed; false otherwise.
   */
  public tryConsume(cost: number = 1): boolean {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }

    return false;
  }

  /**
   * Records a rate-limit violation. Tracks violations within a sliding 10-second window.
   * Returns true if the connection is persistently abusive (>= threshold violations in 10s).
   * 
   * @param threshold Max allowed violations in window before flagging persistent abuse (default 10)
   * @param windowMs Sliding window duration in milliseconds (default 10,000ms)
   */
  public recordViolation(threshold: number = 10, windowMs: number = 10000): boolean {
    const now = Date.now();
    if (now - this.lastViolationTime > windowMs) {
      this.violationCount = 1;
    } else {
      this.violationCount++;
    }
    this.lastViolationTime = now;

    return this.violationCount >= threshold;
  }

  /**
   * Returns the current token balance after calculating replenishment.
   */
  public getTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Resets tokens back to maximum capacity and clears violation counters.
   */
  public reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
    this.violationCount = 0;
    this.lastViolationTime = 0;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillTime) / 1000;

    if (elapsedSec > 0) {
      const replenished = elapsedSec * this.refillRate;
      this.tokens = Math.min(this.capacity, this.tokens + replenished);
      this.lastRefillTime = now;
    }
  }
}
