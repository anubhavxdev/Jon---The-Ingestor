/**
 * app.js — JobStream frontend
 *
 * State machine:
 *   idle → loading → loaded | error
 *   User interactions (filter, search, load-more) re-trigger the loaded state.
 *
 * All data is fetched from the local /api/jobs endpoint (same origin).
 * Search is debounced 300ms. Filters use URL params so the state is shareable.
 */

'use strict';

/* ── State ──────────────────────────────────────────────────────────────── */
const state = {
  jobs: [],
  page: 1,
  limit: 20,
  total: 0,
  pages: 0,
  query: '',
  source: 'all',
  remoteOnly: false,
  loading: false,
  lastUpdated: null,
};

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const $grid        = document.getElementById('jobs-grid');
const $statCount   = document.getElementById('stat-count');
const $statSources = document.getElementById('stat-sources');
const $statUpdated = document.getElementById('stat-updated');
const $errorState  = document.getElementById('error-state');
const $errorMsg    = document.getElementById('error-msg');
const $emptyState  = document.getElementById('empty-state');
const $btnLoadMore = document.getElementById('btn-load-more');
const $searchInput = document.getElementById('search-input');
const $chkRemote   = document.getElementById('chk-remote');
const $btnRefresh  = document.getElementById('btn-refresh');
const $btnHealth   = document.getElementById('btn-health');
const $healthPanel = document.getElementById('health-panel');
const $healthContent = document.getElementById('health-content');
const $btnCloseHealth = document.getElementById('btn-close-health');
const $btnRetry    = document.getElementById('btn-retry');
const $btnClearFilters = document.getElementById('btn-clear-filters');

/* ── Source colors ───────────────────────────────────────────────────────── */
const SOURCE_CONFIG = {
  remoteok:  { label: 'RemoteOK',       badgeClass: 'badge-remoteok'  },
  arbeitnow: { label: 'Arbeitnow',      badgeClass: 'badge-arbeitnow' },
  hn_hiring: { label: 'HN Hiring',      badgeClass: 'badge-hn_hiring' },
};

/* ── Utilities ───────────────────────────────────────────────────────────── */
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchJobs({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;

  if (!append) showSkeletons();

  const params = new URLSearchParams();
  if (state.query)     params.set('q', state.query);
  if (state.source !== 'all') params.set('source', state.source);
  if (state.remoteOnly) params.set('remote', 'true');
  params.set('page', state.page);
  params.set('limit', state.limit);

  try {
    const res = await fetch(`/api/jobs?${params}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();

    if (!data.ok) throw new Error(data.error || 'Unknown error');

    state.total = data.total;
    state.pages = data.pages;
    state.lastUpdated = new Date();

    if (append) {
      state.jobs = [...state.jobs, ...data.items];
    } else {
      state.jobs = data.items;
    }

    renderJobs(append);
    updateStats();
    $errorState.classList.add('hidden');

    $btnLoadMore.classList.toggle(
      'hidden',
      state.page >= state.pages || state.jobs.length >= state.total
    );
  } catch (err) {
    console.error('fetchJobs error:', err);
    if (!append) {
      showError(err.message);
    }
  } finally {
    state.loading = false;
  }
}

async function fetchHealth() {
  $healthContent.innerHTML = '<div class="health-loading">Fetching health data…</div>';
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    renderHealth(data);
  } catch (err) {
    $healthContent.innerHTML = `<div class="health-loading" style="color:#ef4444">Error: ${escHtml(err.message)}</div>`;
  }
}

async function triggerRefresh() {
  $btnRefresh.classList.add('loading');
  try {
    await fetch('/api/refresh', { method: 'POST' });
    // Wait a moment then re-fetch
    setTimeout(() => {
      state.page = 1;
      fetchJobs();
    }, 3000);
  } catch {
    // noop
  } finally {
    setTimeout(() => $btnRefresh.classList.remove('loading'), 3500);
  }
}

/* ── Render ──────────────────────────────────────────────────────────────── */
function showSkeletons() {
  $grid.innerHTML = Array(6).fill(0).map(() =>
    `<div class="skeleton-card" aria-hidden="true"></div>`
  ).join('');
  $grid.setAttribute('aria-busy', 'true');
  $emptyState.classList.add('hidden');
  $errorState.classList.add('hidden');
  $btnLoadMore.classList.add('hidden');
}

function renderJobs(append) {
  $grid.removeAttribute('aria-busy');
  const items = state.jobs;

  if (!append) {
    if (items.length === 0) {
      $grid.innerHTML = '';
      $emptyState.classList.remove('hidden');
      return;
    }
    $grid.innerHTML = '';
    $emptyState.classList.add('hidden');
  }

  const fragment = document.createDocumentFragment();
  items.slice(append ? items.length - 20 : 0).forEach((job, i) => {
    const el = createJobCard(job, i);
    fragment.appendChild(el);
  });
  $grid.appendChild(fragment);
}

function createJobCard(job, index) {
  const cfg = SOURCE_CONFIG[job.source] || { label: job.source, badgeClass: '' };
  const tags = (job.tags || []).slice(0, 5);
  const time = relativeTime(job.postedAt);

  const div = document.createElement('article');
  div.className = 'job-card';
  div.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', `${escHtml(job.title)} at ${escHtml(job.company)}`);

  div.innerHTML = `
    <div class="card-top">
      <h3 class="card-title">${escHtml(job.title)}</h3>
      <span class="source-badge ${cfg.badgeClass}">${escHtml(cfg.label)}</span>
    </div>
    <div class="card-company">${escHtml(job.company)}</div>
    <div class="card-meta">
      <span class="card-meta-item">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        ${escHtml(job.location || '—')}
      </span>
      ${job.remote ? '<span class="remote-tag">🌐 Remote</span>' : ''}
    </div>
    ${tags.length > 0 ? `<div class="card-tags">${tags.map(t => `<span class="tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join('')}</div>` : ''}
    <div class="card-footer">
      <span class="card-time">${time}</span>
      <a href="${escHtml(job.url)}" target="_blank" rel="noopener noreferrer" class="card-link" aria-label="Apply for ${escHtml(job.title)}">
        View →
      </a>
    </div>
  `;

  // Tag click → search by tag
  div.querySelectorAll('.tag').forEach((tag) => {
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = tag.dataset.tag;
      $searchInput.value = t;
      state.query = t;
      state.page = 1;
      fetchJobs();
    });
  });

  return div;
}

function updateStats() {
  const sourcesActive = new Set(state.jobs.map((j) => j.source));
  $statCount.textContent = `${state.total.toLocaleString()} jobs`;
  $statSources.textContent = `${sourcesActive.size} source${sourcesActive.size !== 1 ? 's' : ''}`;
  $statUpdated.textContent = state.lastUpdated
    ? `updated ${relativeTime(state.lastUpdated.toISOString())}`
    : '—';
}

function showError(msg) {
  $grid.innerHTML = '';
  $errorMsg.textContent = `Failed to load jobs: ${msg}`;
  $errorState.classList.remove('hidden');
  $emptyState.classList.add('hidden');
  $btnLoadMore.classList.add('hidden');
}

function renderHealth(data) {
  const { circuits, cache, rateLimits, uptimeMs } = data;
  const uptimeMins = Math.floor((uptimeMs || 0) / 60000);

  const sourceHtml = Object.entries(data.sources || {}).map(([id, src]) => {
    const cb = circuits?.[id] || {};
    const rl = rateLimits?.[id] || {};
    const state = cb.state || 'UNINITIALIZED';
    return `
      <div class="health-source">
        <div class="health-source-header">
          <span class="health-source-name">${escHtml(src.label)}</span>
          <span class="circuit-badge circuit-${escHtml(state)}">${escHtml(state)}</span>
        </div>
        <div class="health-meta">
          <div class="health-row">
            <span>Failures</span><span class="val">${cb.failures ?? 0} / ${cb.totalTrips ?? 0} trips</span>
          </div>
          <div class="health-row">
            <span>Rate limit tokens</span><span class="val">${rl.available ?? '—'} avail · ${rl.queued ?? 0} queued</span>
          </div>
          ${state === 'OPEN' && cb.recoversInMs ? `<div class="health-row"><span>Recovers in</span><span class="val">${Math.ceil(cb.recoversInMs/1000)}s</span></div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  $healthContent.innerHTML = `
    <div class="health-source" style="margin-bottom:4px">
      <div class="health-source-header">
        <span class="health-source-name">System</span>
        <span class="circuit-badge circuit-CLOSED">UP</span>
      </div>
      <div class="health-meta">
        <div class="health-row"><span>Uptime</span><span class="val">${uptimeMins}m</span></div>
        <div class="health-row"><span>Cache size</span><span class="val">${cache?.size ?? '—'} entries</span></div>
        <div class="health-row"><span>Hit rate</span><span class="val">${cache?.hitRate ?? '—'}</span></div>
        <div class="health-row"><span>Stale hits</span><span class="val">${cache?.staleHits ?? 0}</span></div>
      </div>
    </div>
    ${sourceHtml}
  `;
}

/* ── Event listeners ─────────────────────────────────────────────────────── */
$searchInput.addEventListener('input', debounce((e) => {
  state.query = e.target.value.trim();
  state.page = 1;
  fetchJobs();
}, 300));

$chkRemote.addEventListener('change', () => {
  state.remoteOnly = $chkRemote.checked;
  state.page = 1;
  fetchJobs();
});

document.querySelectorAll('.source-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.source-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.source = btn.dataset.src;
    state.page = 1;
    fetchJobs();
  });
});

$btnLoadMore.addEventListener('click', () => {
  state.page++;
  fetchJobs({ append: true });
});

$btnRefresh.addEventListener('click', triggerRefresh);

$btnHealth.addEventListener('click', () => {
  const isHidden = $healthPanel.classList.contains('hidden');
  $healthPanel.classList.toggle('hidden', !isHidden);
  $healthPanel.setAttribute('aria-hidden', String(isHidden));
  if (!isHidden) return; // was shown, now hidden
  fetchHealth();
});

$btnCloseHealth.addEventListener('click', () => {
  $healthPanel.classList.add('hidden');
  $healthPanel.setAttribute('aria-hidden', 'true');
});

$btnRetry.addEventListener('click', () => {
  state.page = 1;
  fetchJobs();
});

$btnClearFilters.addEventListener('click', () => {
  $searchInput.value = '';
  $chkRemote.checked = false;
  state.query = '';
  state.remoteOnly = false;
  state.source = 'all';
  state.page = 1;
  document.querySelectorAll('.source-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById('filter-all').classList.add('active');
  fetchJobs();
});

// Close health panel on outside click
document.addEventListener('click', (e) => {
  if (!$healthPanel.classList.contains('hidden') &&
      !$healthPanel.contains(e.target) &&
      e.target !== $btnHealth) {
    $healthPanel.classList.add('hidden');
    $healthPanel.setAttribute('aria-hidden', 'true');
  }
});

/* ── Init ────────────────────────────────────────────────────────────────── */
fetchJobs();
