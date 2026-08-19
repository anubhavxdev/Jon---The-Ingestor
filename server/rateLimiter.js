/**
 * rateLimiter.js — Token bucket rate limiter (per source)
 *
 * Each source gets its own bucket. A bucket refills at:
 *   `tokens` tokens every `intervalMs` milliseconds
 *
 * acquire() returns a Promise that resolves when a token is available.
 * It never rejects — it simply waits until a slot opens up. This is
 * intentional: we want the pipeline to slow down, not crash.
 *
 * Design note: On hostile targets you'd pair this with proxy rotation so
 * that each "identity" (IP + session cookie) has its own token bucket.
 * A single IP hitting remoteok at 5 req/s would get banned within minutes;
 * spreading the same load across 50 residential IPs at 0.1 req/s each
 * is invisible.
 */

const logger = require('./logger');

class TokenBucket {
  constructor(sourceId, { tokens, intervalMs }) {
    this.sourceId = sourceId;
    this.capacity = tokens;
    this.available = tokens;
    this.intervalMs = intervalMs;
    this.queue = [];

    // Refill on a fixed schedule
    this._timer = setInterval(() => this._refill(), intervalMs);
    this._timer.unref(); // don't block process exit
  }

  _refill() {
    const prev = this.available;
    this.available = this.capacity;
    // Drain queue
    while (this.queue.length > 0 && this.available > 0) {
      this.available--;
      const resolve = this.queue.shift();
      resolve();
    }
    if (prev === 0 && this.available > 0) {
      logger.debug('rateLimiter.refill', { source: this.sourceId, tokens: this.available });
    }
  }

  acquire() {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    // Enqueue and wait for next refill
    logger.debug('rateLimiter.queued', { source: this.sourceId, queueLen: this.queue.length });
    return new Promise((resolve) => this.queue.push(resolve));
  }

  status() {
    return { available: this.available, queued: this.queue.length };
  }
}

const buckets = {};

function getBucket(sourceConfig) {
  if (!buckets[sourceConfig.id]) {
    buckets[sourceConfig.id] = new TokenBucket(sourceConfig.id, sourceConfig.rateLimit);
  }
  return buckets[sourceConfig.id];
}

function allStatuses() {
  return Object.fromEntries(
    Object.entries(buckets).map(([id, b]) => [id, b.status()])
  );
}

module.exports = { getBucket, allStatuses };
