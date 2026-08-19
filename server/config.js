/**
 * config.js — Source registry
 *
 * Each entry defines a named job source with:
 *   url          Base fetch URL
 *   ttlMs        Cache TTL in milliseconds
 *   timeoutMs    Fetch abort timeout
 *   rateLimit    Token bucket: tokensPerInterval / intervalMs
 *   headers      Request headers (User-Agent, Accept, etc.)
 *   cbThreshold  Circuit breaker failure threshold
 *   cbResetMs    Circuit breaker recovery window in ms
 *
 * Pattern note: On real hostile targets you would rotate User-Agent strings
 * from a pool of real browser UAs, vary Accept-Language, and inject
 * realistic Cookie / sec-ch-ua headers. Here we set a honest bot UA since
 * all three sources are public APIs that don't ban crawlers.
 */

const HONEST_UA =
  'JobIngestBot/1.0 (https://github.com/your-repo; contact@example.com)';

const sources = {
  remoteok: {
    id: 'remoteok',
    label: 'RemoteOK',
    color: '#00c853',
    url: 'https://remoteok.io/api',
    ttlMs: 15 * 60 * 1000,       // 15 min
    timeoutMs: 12_000,
    rateLimit: { tokens: 3, intervalMs: 60_000 },  // 3 req/min
    headers: {
      'User-Agent': HONEST_UA,
      'Accept': 'application/json',
    },
    cbThreshold: 3,
    cbResetMs: 5 * 60 * 1000,
  },

  arbeitnow: {
    id: 'arbeitnow',
    label: 'Arbeitnow',
    color: '#2979ff',
    url: 'https://www.arbeitnow.com/api/job-board-api',
    ttlMs: 15 * 60 * 1000,
    timeoutMs: 12_000,
    rateLimit: { tokens: 5, intervalMs: 60_000 },
    headers: {
      'User-Agent': HONEST_UA,
      'Accept': 'application/json',
    },
    cbThreshold: 3,
    cbResetMs: 5 * 60 * 1000,
  },

  hn_hiring: {
    id: 'hn_hiring',
    label: 'HN Who\'s Hiring',
    color: '#ff6d00',
    url: 'https://hn.algolia.com/api/v1',
    ttlMs: 30 * 60 * 1000,       // 30 min — HN posts monthly, no need to hammer
    timeoutMs: 12_000,
    rateLimit: { tokens: 10, intervalMs: 60_000 },
    headers: {
      'User-Agent': HONEST_UA,
      'Accept': 'application/json',
    },
    cbThreshold: 3,
    cbResetMs: 5 * 60 * 1000,
  },
};

module.exports = { sources };
