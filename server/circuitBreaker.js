/**
 * circuitBreaker.js — Per-source circuit breaker state machine
 *
 * States:
 *   CLOSED    → requests pass through normally
 *   OPEN      → requests rejected immediately (fast-fail)
 *   HALF_OPEN → one probe request allowed; success → CLOSED, failure → OPEN
 *
 * Transition rules:
 *   CLOSED   → OPEN      after `threshold` consecutive failures
 *   OPEN     → HALF_OPEN after `resetMs` milliseconds
 *   HALF_OPEN → CLOSED   on success
 *   HALF_OPEN → OPEN     on failure (restart timer)
 *
 * Design note: In a multi-process deployment you'd store circuit state in
 * Redis so all pods share the same view. Here we use process-local state
 * since the demo runs as a single Render instance.
 */

const logger = require('./logger');

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  constructor(sourceId, { threshold = 3, resetMs = 5 * 60_000 } = {}) {
    this.sourceId = sourceId;
    this.threshold = threshold;
    this.resetMs = resetMs;

    this.state = STATE.CLOSED;
    this.failures = 0;
    this.openedAt = null;
    this.totalTrips = 0;
  }

  /** Returns true if the request should be allowed through */
  allowRequest() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.OPEN) {
      if (Date.now() - this.openedAt >= this.resetMs) {
        this._transition(STATE.HALF_OPEN, 'recovery window elapsed');
        return true; // allow the probe
      }
      return false;
    }
    // HALF_OPEN: only one probe at a time (we don't track in-flight here,
    // but for single-instance demos this is fine)
    return true;
  }

  onSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      this._transition(STATE.CLOSED, 'probe succeeded');
    }
    this.failures = 0;
  }

  onFailure(err) {
    this.failures++;
    if (this.state === STATE.HALF_OPEN || this.failures >= this.threshold) {
      this._transition(STATE.OPEN, `${this.failures} consecutive failures`);
      this.openedAt = Date.now();
      this.totalTrips++;
    }
    logger.warn('circuit.failure', {
      source: this.sourceId,
      failures: this.failures,
      state: this.state,
      err: err?.message,
    });
  }

  _transition(next, reason) {
    logger.info('circuit.transition', {
      source: this.sourceId,
      from: this.state,
      to: next,
      reason,
    });
    this.state = next;
    if (next === STATE.CLOSED) this.failures = 0;
  }

  status() {
    const remainingMs =
      this.state === STATE.OPEN
        ? Math.max(0, this.resetMs - (Date.now() - this.openedAt))
        : 0;
    return {
      state: this.state,
      failures: this.failures,
      totalTrips: this.totalTrips,
      recoversInMs: remainingMs,
    };
  }
}

// Breaker registry — keyed by source id
const breakers = {};

function getBreaker(sourceConfig) {
  if (!breakers[sourceConfig.id]) {
    breakers[sourceConfig.id] = new CircuitBreaker(sourceConfig.id, {
      threshold: sourceConfig.cbThreshold,
      resetMs: sourceConfig.cbResetMs,
    });
  }
  return breakers[sourceConfig.id];
}

function allStatuses() {
  return Object.fromEntries(
    Object.entries(breakers).map(([id, cb]) => [id, cb.status()])
  );
}

module.exports = { getBreaker, allStatuses };
