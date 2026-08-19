/**
 * scheduler.js — Background refresh cron
 *
 * Proactively warms the cache for all sources every 10 minutes.
 * This decouples fetch latency from user-facing requests — users always
 * hit warm cache, and we never block a web request on a slow upstream.
 *
 * Self-ping: On Render free tier, services sleep after 15 min of inactivity.
 * We ping our own health endpoint every 12 min to keep the instance warm
 * during the demo window.
 */

const cron = require('node-cron');
const logger = require('./logger');
const { fetchRemoteOK } = require('./adapters/remoteok');
const { fetchArbeitnow } = require('./adapters/arbeitnow');
const { fetchHNHiring } = require('./adapters/hnHiring');

let selfPingUrl = null;

async function refreshAll() {
  logger.info('scheduler.refresh_start', {});
  const start = Date.now();
  const results = await Promise.allSettled([
    fetchRemoteOK(),
    fetchArbeitnow(),
    fetchHNHiring(),
  ]);
  results.forEach((r, i) => {
    const names = ['remoteok', 'arbeitnow', 'hn_hiring'];
    if (r.status === 'rejected') {
      logger.error('scheduler.source_failed', { source: names[i], err: r.reason?.message });
    } else {
      logger.info('scheduler.source_ok', { source: names[i], count: r.value?.length ?? 0 });
    }
  });
  logger.info('scheduler.refresh_done', { durationMs: Date.now() - start });
}

async function selfPing() {
  if (!selfPingUrl) return;
  try {
    await fetch(selfPingUrl, { signal: AbortSignal.timeout(5000) });
    logger.debug('scheduler.self_ping', { url: selfPingUrl });
  } catch {
    // ignore — if we're down we can't ping anyway
  }
}

function start(port) {
  // Determine self-ping URL
  const appUrl = process.env.RENDER_EXTERNAL_URL;
  if (appUrl) {
    selfPingUrl = `${appUrl}/api/health`;
  } else if (port) {
    selfPingUrl = `http://localhost:${port}/api/health`;
  }

  // Refresh all sources every 10 minutes
  cron.schedule('*/10 * * * *', () => {
    refreshAll().catch((err) =>
      logger.error('scheduler.cron_error', { err: err.message })
    );
  });

  // Self-ping every 12 minutes to keep Render free-tier warm
  cron.schedule('*/12 * * * *', () => selfPing());

  // Kick off an immediate refresh on startup
  setTimeout(() => refreshAll(), 2000);

  logger.info('scheduler.started', {
    refreshInterval: '10min',
    selfPingUrl,
  });
}

module.exports = { start, refreshAll };
