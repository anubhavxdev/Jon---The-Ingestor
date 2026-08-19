/**
 * adapters/remoteok.js — RemoteOK ingestion adapter
 *
 * RemoteOK exposes a public JSON API at https://remoteok.io/api.
 * Attribution is required: link back to the original listing URL.
 * No auth, no key, no rate-limit headers specified in their docs —
 * we self-impose 3 req/min to be polite.
 *
 * Detection surface note:
 *   RemoteOK doesn't actively fingerprint bots on the /api endpoint, but
 *   the HTML endpoint has Cloudflare. On the API endpoint, the main risk is
 *   volumetric: if you hammer it you'll get 429s or a soft block. Our token
 *   bucket limits us to 3 req/min which is well within polite range.
 */

const cache = require('../cache');
const { getBreaker } = require('../circuitBreaker');
const { getBucket } = require('../rateLimiter');
const { normalizeRemoteOK, checkDrift } = require('../normalizer');
const logger = require('../logger');
const { sources } = require('../config');

const SOURCE = sources.remoteok;
const CACHE_KEY = 'remoteok:listings';

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchRemoteOK() {
  const breaker = getBreaker(SOURCE);
  const bucket = getBucket(SOURCE);

  // Circuit open? Fast-fail
  if (!breaker.allowRequest()) {
    logger.warn('remoteok.circuit_open', { source: 'remoteok' });
    const cached = cache.get(CACHE_KEY);
    return cached ? cached.value : [];
  }

  // Check cache first
  const cached = cache.get(CACHE_KEY);
  if (cached && !cached.stale) {
    logger.debug('remoteok.cache_hit', { stale: false });
    return cached.value;
  }
  if (cached && cached.stale) {
    // Serve stale, but we'll try to revalidate below
    logger.debug('remoteok.cache_stale', {});
  }

  // Acquire rate-limit token
  await bucket.acquire();

  logger.info('remoteok.fetch', { url: SOURCE.url });

  try {
    const res = await fetchWithTimeout(
      SOURCE.url,
      { headers: SOURCE.headers },
      SOURCE.timeoutMs
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const raw = await res.json();

    // Schema drift check
    if (Array.isArray(raw) && raw.length > 1) {
      checkDrift('remoteok', raw[1]); // index 0 is meta, 1 is first job
    }

    const jobs = normalizeRemoteOK(raw);
    cache.set(CACHE_KEY, jobs, SOURCE.ttlMs);
    breaker.onSuccess();
    logger.info('remoteok.fetched', { count: jobs.length });
    return jobs;
  } catch (err) {
    breaker.onFailure(err);
    logger.error('remoteok.fetch_error', { err: err.message });
    // Return stale if available
    return cached ? cached.value : [];
  }
}

module.exports = { fetchRemoteOK };
