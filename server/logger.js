/**
 * logger.js — Structured JSON logger
 *
 * Emits newline-delimited JSON to stdout. Each log line carries:
 *   ts        ISO timestamp
 *   level     debug | info | warn | error
 *   msg       human-readable message
 *   ...meta   arbitrary key-value context
 *
 * In a production stack this output pipes directly into Datadog / Loki /
 * CloudWatch without any transformation.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function log(level, msg, meta = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};

module.exports = logger;
