/**
 * normalizer.js — Raw response → canonical JobListing schema
 *
 * Canonical schema:
 * {
 *   id:          string   (source-scoped unique id)
 *   title:       string
 *   company:     string
 *   location:    string
 *   remote:      boolean
 *   tags:        string[]
 *   url:         string
 *   description: string   (truncated to 500 chars)
 *   postedAt:    string   (ISO 8601)
 *   source:      string   (source id)
 *   rawHash:     string   (MD5 of top-level keys — used for schema drift detection)
 * }
 *
 * Schema drift detection:
 *   On the first call for a source, we record the set of top-level keys as a
 *   "fingerprint". On subsequent calls, if the fingerprint changes, we emit a
 *   SCHEMA_DRIFT warning with the diff. The adapter then decides whether to
 *   serve stale cache or attempt best-effort normalization.
 */

const crypto = require('crypto');
const logger = require('./logger');

// Known fingerprints per source
const knownFingerprints = {};

function computeFingerprint(obj) {
  const keys = Object.keys(obj).sort().join(',');
  return crypto.createHash('md5').update(keys).digest('hex');
}

function checkDrift(sourceId, sampleRaw) {
  const fp = computeFingerprint(sampleRaw);
  if (!knownFingerprints[sourceId]) {
    knownFingerprints[sourceId] = fp;
    return { drifted: false, fingerprint: fp };
  }
  if (knownFingerprints[sourceId] !== fp) {
    logger.warn('SCHEMA_DRIFT', {
      source: sourceId,
      previous: knownFingerprints[sourceId],
      current: fp,
      sampleKeys: Object.keys(sampleRaw).sort(),
    });
    knownFingerprints[sourceId] = fp;
    return { drifted: true, fingerprint: fp };
  }
  return { drifted: false, fingerprint: fp };
}

function sanitize(str, maxLen = 500) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, ' ').trim().slice(0, maxLen);
}

// ── RemoteOK ──────────────────────────────────────────────────────────────────
// Raw fields: id, company, position, tags, description, url, date, remote, ...
// NOTE: `date` is an ISO 8601 string (e.g. "2026-08-18T19:57:52+00:00"),
// NOT a Unix timestamp. Passing it directly to new Date() is safe.
function normalizeRemoteOK(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((j) => j && j.id && j.position) // first element is a meta object
    .map((j) => {
      // Parse date safely — could be ISO string or missing
      let postedAt = new Date().toISOString();
      if (j.date) {
        const d = new Date(j.date);
        if (!isNaN(d.getTime())) postedAt = d.toISOString();
      }
      return {
        id: `remoteok_${j.id}`,
        title: sanitize(j.position),
        company: sanitize(j.company),
        location: sanitize(j.location) || 'Remote',
        remote: true, // RemoteOK is remote-only by definition
        tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
        url: j.url || `https://remoteok.io/remote-jobs/${j.id}`,
        description: sanitize(j.description),
        postedAt,
        source: 'remoteok',
        rawHash: computeFingerprint(j),
      };
    });
}

// ── Arbeitnow ────────────────────────────────────────────────────────────────
// Raw fields: slug, title, company_name, location, remote, tags, url, description, created_at
function normalizeArbeitnow(raw) {
  const jobs = raw?.data ?? raw;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => ({
    id: `arbeitnow_${j.slug || j.title?.replace(/\s/g, '-').toLowerCase()}`,
    title: sanitize(j.title),
    company: sanitize(j.company_name),
    location: sanitize(j.location) || (j.remote ? 'Remote' : 'On-site'),
    remote: Boolean(j.remote),
    tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
    url: j.url || '',
    description: sanitize(j.description),
    postedAt: j.created_at
      ? new Date(j.created_at * 1000).toISOString()
      : new Date().toISOString(),
    source: 'arbeitnow',
    rawHash: computeFingerprint(j),
  }));
}

// ── HN Who's Hiring ──────────────────────────────────────────────────────────
// Raw: Algolia items endpoint uses `text` (not `comment_text` which is the
// search endpoint's field name). Comments are HTML-encoded free-text.
function normalizeHNComment(comment) {
  // The items endpoint uses `text`; search endpoint uses `comment_text`
  const rawText = comment.text || comment.comment_text || '';
  const text = rawText.replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // First line is usually "Company | Role | Location | ..."
  const firstLine = text.replace(/<[^>]*>/g, ' ').split(/\n/)[0].trim() || '';
  const parts = firstLine.split('|').map((s) => s.trim().replace(/<[^>]*>/g, '').trim());

  const title = sanitize(parts[1] || firstLine.slice(0, 80) || 'Software Role');
  const company = sanitize(parts[0] || 'Unknown Company');
  const location = sanitize(parts[2] || 'See listing');
  const remote = /remote/i.test(text);

  // Extract tech tags: anything that looks like a known tech keyword
  const techPattern = /\b(Python|JavaScript|TypeScript|React|Node|Go|Rust|Java|Kotlin|Swift|Ruby|Rails|Django|FastAPI|PostgreSQL|MySQL|Redis|AWS|GCP|Azure|Docker|Kubernetes|k8s|GraphQL|REST|gRPC)\b/gi;
  const tags = [...new Set((text.match(techPattern) || []).map((t) => t.toLowerCase()))];

  // Use `id` from items endpoint (not `objectID` from search endpoint)
  const itemId = comment.id || comment.objectID;

  return {
    id: `hn_${itemId}`,
    title,
    company,
    location,
    remote,
    tags: tags.slice(0, 8),
    url: `https://news.ycombinator.com/item?id=${itemId}`,
    description: sanitize(text),
    postedAt: comment.created_at || new Date().toISOString(),
    source: 'hn_hiring',
    rawHash: computeFingerprint(comment),
  };
}

function normalizeHN(comments) {
  if (!Array.isArray(comments)) return [];
  // Items endpoint: filter by `text` presence (not `comment_text`)
  return comments
    .filter((c) => c && (c.text || c.comment_text) && (c.text || c.comment_text).length > 50)
    .map(normalizeHNComment);
}

module.exports = {
  normalizeRemoteOK,
  normalizeArbeitnow,
  normalizeHN,
  checkDrift,
};
