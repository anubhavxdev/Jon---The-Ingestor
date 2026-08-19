/**
 * cache.js — LRU + TTL in-memory cache
 *
 * A lightweight cache built on a Map (insertion-order preserved in V8).
 * Eviction policy: LRU when maxSize is reached + TTL expiry on read.
 *
 * Stale-While-Revalidate (SWR) semantics:
 *   get() returns { value, stale: false }  → fresh hit
 *   get() returns { value, stale: true  }  → served stale, background refresh triggered
 *   get() returns null                      → miss, must fetch
 *
 * The SWR window is 2× TTL: between TTL and 2×TTL, data is "stale but usable".
 * Beyond 2×TTL the entry is treated as a miss.
 */

const logger = require('./logger');

const MAX_SIZE = 500;   // max entries across all sources

class LRUTTLCache {
  constructor({ maxSize = MAX_SIZE } = {}) {
    this.maxSize = maxSize;
    this.store = new Map(); // key → { value, fetchedAt, ttlMs }
    this._hits = 0;
    this._misses = 0;
    this._staleHits = 0;
  }

  /**
   * @returns {{ value, stale: boolean } | null}
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this._misses++;
      return null;
    }

    const age = Date.now() - entry.fetchedAt;

    if (age <= entry.ttlMs) {
      // Fresh — move to end (most-recently-used)
      this.store.delete(key);
      this.store.set(key, entry);
      this._hits++;
      return { value: entry.value, stale: false };
    }

    if (age <= entry.ttlMs * 2) {
      // Stale but within SWR window — serve it, signal for revalidation
      this._staleHits++;
      return { value: entry.value, stale: true };
    }

    // Expired beyond SWR window — remove
    this.store.delete(key);
    this._misses++;
    return null;
  }

  set(key, value, ttlMs) {
    if (this.store.has(key)) this.store.delete(key); // refresh position
    if (this.store.size >= this.maxSize) {
      // Evict LRU (first entry in insertion-order map)
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
      logger.debug('cache.evict', { key: oldest });
    }
    this.store.set(key, { value, fetchedAt: Date.now(), ttlMs });
  }

  delete(key) {
    this.store.delete(key);
  }

  stats() {
    const total = this._hits + this._misses + this._staleHits;
    return {
      size: this.store.size,
      hits: this._hits,
      staleHits: this._staleHits,
      misses: this._misses,
      hitRate: total > 0 ? ((this._hits + this._staleHits) / total).toFixed(3) : '0.000',
    };
  }
}

// Singleton — shared across all adapters
const cache = new LRUTTLCache();
module.exports = cache;
