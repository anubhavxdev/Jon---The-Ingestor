/**
 * adapters/arbeitnow.js — Arbeitnow ingestion adapter
 *
 * Arbeitnow provides a completely public REST API with no authentication.
 * Response: { data: [...jobs], links: {...}, meta: {...} }
 * Supports optional ?page=N pagination.
 *
 * We fetch pages 1–3 on each refresh to get ~90 listings without
 * being aggressive. Pagination is done sequentially (not fan-out) to
 * respect the source.
 *
 * Detection surface note:
 *   Arbeitnow is a developer-friendly API that actively encourages integration.
 *   The main risk on hostile analogues (Indeed, LinkedIn) would be:
 *   - Lack of browser-like Accept/Accept-Language headers
 *   - Missing TLS fingerprint (JA3 hash mismatch vs real Chrome)
 *   - No Cookie jar / missing CSRF token
 *   - Request pacing that is too uniform (perfectly even 1s gaps = bot signal)
 */

const cache = require('../cache');
const { getBreaker } = require('../circuitBreaker');
const { getBucket } = require('../rateLimiter');
const { normalizeArbeitnow, checkDrift } = require('../normalizer');
const logger = require('../logger');
const { sources } = require('../config');

const SOURCE = sources.arbeitnow;
const CACHE_KEY = 'arbeitnow:listings';
const MAX_PAGES = 3;

function jitter(baseMs) {
  // Add ±20% jitter — uniform timing is a bot fingerprint
  return baseMs + (Math.random() - 0.5) * baseMs * 0.4;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function fetchPage(page, bucket) {
  await bucket.acquire();
  const url = `${SOURCE.url}?page=${page}`;
  logger.debug('arbeitnow.fetch_page', { page, url });

  const res = await fetchWithTimeout(
    url,
    { headers: SOURCE.headers },
    SOURCE.timeoutMs
  );

  if (!res.ok) throw new Error(`HTTP ${res.status} from arbeitnow page ${page}`);
  return res.json();
}

async function fetchArbeitnow() {
  const breaker = getBreaker(SOURCE);
  const bucket = getBucket(SOURCE);

  if (!breaker.allowRequest()) {
    logger.warn('arbeitnow.circuit_open', {});
    const cached = cache.get(CACHE_KEY);
    return cached ? cached.value : [];
  }

  const cached = cache.get(CACHE_KEY);
  if (cached && !cached.stale) {
    logger.debug('arbeitnow.cache_hit', {});
    return cached.value;
  }

  logger.info('arbeitnow.fetch_start', { pages: MAX_PAGES });
  const allJobs = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchPage(page, bucket);

      if (page === 1 && Array.isArray(data.data) && data.data.length > 0) {
        checkDrift('arbeitnow', data.data[0]);
      }

      const jobs = normalizeArbeitnow(data);
      allJobs.push(...jobs);

      // Stop early if we've hit the last page
      if (!data.links?.next) break;

      // Jittered pause between pages — avoids perfectly-uniform timing
      if (page < MAX_PAGES) await sleep(jitter(2000));
    }

    cache.set(CACHE_KEY, allJobs, SOURCE.ttlMs);
    breaker.onSuccess();
    logger.info('arbeitnow.fetched', { count: allJobs.length });
    return allJobs;
  } catch (err) {
    breaker.onFailure(err);
    logger.error('arbeitnow.fetch_error', { err: err.message });
    return cached ? cached.value : [];
  }
}

module.exports = { fetchArbeitnow };
