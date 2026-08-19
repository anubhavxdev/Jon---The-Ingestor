/**
 * adapters/hnHiring.js — HN "Who's Hiring" ingestion adapter
 *
 * Strategy:
 *   1. Search Algolia HN API for the latest "Ask HN: Who is hiring?" thread
 *      authored by `whoishiring`
 *   2. Fetch all comments (job posts) from that thread's item endpoint
 *   3. Normalize free-text comments into canonical JobListing objects
 *
 * HN job listings are raw text, not structured data. The normalizer does
 * best-effort extraction of company/role/location from the first line
 * and tech tags from the body via regex.
 *
 * This adapter deliberately targets the Algolia search layer (not the
 * Firebase real-time API) because Algolia returns pre-indexed, searchable
 * data in one shot rather than requiring recursive child fetching.
 */

const cache = require('../cache');
const { getBreaker } = require('../circuitBreaker');
const { getBucket } = require('../rateLimiter');
const { normalizeHN } = require('../normalizer');
const logger = require('../logger');
const { sources } = require('../config');

const SOURCE = sources.hn_hiring;
const CACHE_KEY = 'hn_hiring:listings';
const THREAD_CACHE_KEY = 'hn_hiring:thread_id';

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

async function getLatestHiringThreadId(bucket) {
  // Check cache first (thread ID is stable for an entire month)
  const cached = cache.get(THREAD_CACHE_KEY);
  if (cached && !cached.stale) return cached.value;

  await bucket.acquire();
  const searchUrl =
    `${SOURCE.url}/search_by_date?query=Ask+HN:+Who+is+hiring%3F&tags=story,author_whoishiring&hitsPerPage=1`;

  logger.debug('hn_hiring.search_thread', { url: searchUrl });

  const res = await fetchWithTimeout(searchUrl, { headers: SOURCE.headers }, SOURCE.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} searching HN thread`);

  const data = await res.json();
  const hit = data.hits?.[0];
  if (!hit?.objectID) throw new Error('No HN hiring thread found in Algolia');

  const threadId = hit.objectID;
  // Cache thread ID for 6 hours — it changes monthly, polling hourly is fine
  cache.set(THREAD_CACHE_KEY, threadId, 6 * 60 * 60 * 1000);
  logger.info('hn_hiring.thread_found', { threadId, title: hit.title });
  return threadId;
}

async function fetchHNHiring() {
  const breaker = getBreaker(SOURCE);
  const bucket = getBucket(SOURCE);

  if (!breaker.allowRequest()) {
    logger.warn('hn_hiring.circuit_open', {});
    const cached = cache.get(CACHE_KEY);
    return cached ? cached.value : [];
  }

  const cached = cache.get(CACHE_KEY);
  if (cached && !cached.stale) {
    logger.debug('hn_hiring.cache_hit', {});
    return cached.value;
  }

  logger.info('hn_hiring.fetch_start', {});

  try {
    const threadId = await getLatestHiringThreadId(bucket);

    await bucket.acquire();
    const itemUrl = `${SOURCE.url}/items/${threadId}`;
    logger.debug('hn_hiring.fetch_thread', { url: itemUrl });

    const res = await fetchWithTimeout(itemUrl, { headers: SOURCE.headers }, SOURCE.timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching HN thread ${threadId}`);

    const thread = await res.json();

    // The thread.children array contains the top-level job listing comments
    const comments = thread.children || [];
    const jobs = normalizeHN(comments);

    cache.set(CACHE_KEY, jobs, SOURCE.ttlMs);
    breaker.onSuccess();
    logger.info('hn_hiring.fetched', { count: jobs.length, threadId });
    return jobs;
  } catch (err) {
    breaker.onFailure(err);
    logger.error('hn_hiring.fetch_error', { err: err.message });
    return cached ? cached.value : [];
  }
}

module.exports = { fetchHNHiring };
