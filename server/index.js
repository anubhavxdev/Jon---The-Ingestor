/**
 * index.js — Express application entry point
 *
 * Routes:
 *   GET /                        → serves frontend SPA
 *   GET /api/jobs                → aggregated job listings (all sources, filterable)
 *   GET /api/jobs/:source        → listings from a single source
 *   GET /api/health              → per-source circuit state, cache stats, uptime
 *   POST /api/refresh            → manually trigger a background refresh
 *
 * Query params for /api/jobs:
 *   ?source=remoteok,arbeitnow  → filter by source (comma-separated)
 *   ?q=react                    → keyword search (title + tags + company)
 *   ?remote=true                → filter remote-only
 *   ?page=1&limit=20            → pagination
 */

const express = require('express');
const path = require('path');
const logger = require('./logger');
const cache = require('./cache');
const { allStatuses: cbStatuses } = require('./circuitBreaker');
const { allStatuses: rlStatuses } = require('./rateLimiter');
const { fetchRemoteOK } = require('./adapters/remoteok');
const { fetchArbeitnow } = require('./adapters/arbeitnow');
const { fetchHNHiring } = require('./adapters/hnHiring');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Request logger middleware ────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http.request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────
async function getAllJobs() {
  const [rok, arb, hn] = await Promise.allSettled([
    fetchRemoteOK(),
    fetchArbeitnow(),
    fetchHNHiring(),
  ]);
  return [
    ...(rok.status === 'fulfilled' ? rok.value : []),
    ...(arb.status === 'fulfilled' ? arb.value : []),
    ...(hn.status  === 'fulfilled' ? hn.value  : []),
  ];
}

function applyFilters(jobs, query) {
  let result = jobs;

  // Source filter
  if (query.source) {
    const sources = query.source.split(',').map((s) => s.trim().toLowerCase());
    result = result.filter((j) => sources.includes(j.source));
  }

  // Remote filter
  if (query.remote === 'true') {
    result = result.filter((j) => j.remote);
  }

  // Keyword search
  if (query.q) {
    const kw = query.q.toLowerCase();
    result = result.filter(
      (j) =>
        j.title.toLowerCase().includes(kw) ||
        j.company.toLowerCase().includes(kw) ||
        j.tags.some((t) => t.toLowerCase().includes(kw)) ||
        j.description.toLowerCase().includes(kw)
    );
  }

  // Pagination
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(100, parseInt(query.limit) || 20);
  const total = result.length;
  const start = (page - 1) * limit;
  const items = result.slice(start, start + limit);

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// All jobs — aggregated, filtered, paginated
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await getAllJobs();
    const result = applyFilters(jobs, req.query);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('route.jobs', { err: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Single-source jobs
app.get('/api/jobs/:source', async (req, res) => {
  const fetchers = {
    remoteok:  fetchRemoteOK,
    arbeitnow: fetchArbeitnow,
    hn_hiring: fetchHNHiring,
  };
  const fetcher = fetchers[req.params.source];
  if (!fetcher) return res.status(404).json({ ok: false, error: 'Unknown source' });
  try {
    const jobs = await fetcher();
    const result = applyFilters(jobs, req.query);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health — wirable to Render health check + external monitors
app.get('/api/health', (req, res) => {
  const circuits = cbStatuses();
  const rateLimits = rlStatuses();
  const cacheStats = cache.stats();
  const uptimeMs = Date.now() - START_TIME;

  res.json({
    ok: true,
    uptimeMs,
    uptime: `${Math.floor(uptimeMs / 60000)}m`,
    cache: cacheStats,
    circuits,
    rateLimits,
    sources: {
      remoteok:  { label: 'RemoteOK',        circuit: circuits.remoteok  || 'UNINITIALIZED' },
      arbeitnow: { label: 'Arbeitnow',        circuit: circuits.arbeitnow || 'UNINITIALIZED' },
      hn_hiring: { label: "HN Who's Hiring",  circuit: circuits.hn_hiring || 'UNINITIALIZED' },
    },
  });
});

// Manual refresh trigger (useful for demo, would be auth-gated in prod)
app.post('/api/refresh', async (req, res) => {
  logger.info('route.manual_refresh', {});
  scheduler.refreshAll().catch((err) =>
    logger.error('route.refresh_error', { err: err.message })
  );
  res.json({ ok: true, message: 'Refresh triggered in background' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('unhandled_error', { err: err.message, stack: err.stack });
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  scheduler.start(PORT);
});

module.exports = app;
