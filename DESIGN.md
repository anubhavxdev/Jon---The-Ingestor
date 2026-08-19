# DESIGN.md — Job Ingest Pipeline

## 1. Detection Surface

> What specifically gives an automated client away — and which of those this design accounts for.

### 1.1 Fingerprint Taxonomy

```
┌──────────────────────────────────────────────────────────────────────┐
│                      DETECTION SURFACE MAP                           │
├─────────────────────┬────────────────────────────────────────────────┤
│  LAYER              │  SIGNAL                                        │
├─────────────────────┼────────────────────────────────────────────────┤
│  TLS / Network      │  JA3 fingerprint (cipher suite order)          │
│                     │  HTTP/2 SETTINGS frame order & values          │
│                     │  TCP window size, TTL anomalies                │
│                     │  ASN / datacenter IP range (AWS, DO, Render)   │
├─────────────────────┼────────────────────────────────────────────────┤
│  HTTP Headers       │  Missing or bot-pattern User-Agent             │
│                     │  Absent: Accept-Language, Accept-Encoding      │
│                     │  sec-ch-ua, sec-fetch-* headers (browser-only) │
│                     │  Missing Cookie jar / stale CSRF token         │
│                     │  Referer absent on deep-link requests          │
├─────────────────────┼────────────────────────────────────────────────┤
│  Timing / Behavior  │  Perfectly uniform inter-request intervals     │
│                     │  Zero human-think-time between pages           │
│                     │  No mouse/scroll events on JS-rendered pages   │
│                     │  Viewport = headless default (1280×720)        │
├─────────────────────┼────────────────────────────────────────────────┤
│  Browser / JS       │  navigator.webdriver === true                  │
│                     │  Missing Chrome plugins / extension objects     │
│                     │  window.chrome absent in Chromium              │
│                     │  headless UA string ("HeadlessChrome")         │
│                     │  canvas/WebGL fingerprint mismatch             │
│                     │  No AudioContext baseline noise                │
├─────────────────────┼────────────────────────────────────────────────┤
│  Volumetric         │  High req/sec from single IP                   │
│                     │  No IP rotation across sessions                │
│                     │  Same IP hitting /login + /jobs + /api         │
└─────────────────────┴────────────────────────────────────────────────┘
```

### 1.2 What This Design Accounts For

| Signal | Mitigation in This System |
|---|---|
| Bot User-Agent | Honest bot UA on public APIs; would be real Chrome UA on hostile targets |
| Uniform timing | Jittered inter-page delay (±20%) in Arbeitnow adapter |
| Volumetric | Token bucket rate limiter (3–10 req/min per source) |
| Schema breaks | MD5 fingerprint + SCHEMA_DRIFT warning before serving garbage |
| Source failure | Circuit breaker (3 failures → 5-min open) |
| Datacenter IP | On public APIs: irrelevant. On hostile: residential proxy rotation required |

### 1.3 What This Design Does NOT Account For (and why)

The demo runs against public APIs where TLS fingerprinting, navigator.webdriver, and CAPTCHA walls are not used. For LinkedIn/Indeed:

- **JA3 spoofing** would require a custom TLS stack (e.g., `curl-impersonate`, Go's `utls` library) to mimic Chrome's cipher suite order.
- **Playwright-stealth** would be needed to patch `navigator.webdriver`, fake plugins, randomize canvas noise.
- **Residential proxy rotation** is required to avoid datacenter-IP blocks — commercial providers (Brightdata, Oxylabs) charge ~$10/GB.
- **CAPTCHA solving** (2captcha, Anti-Captcha) is an additional paid dependency.

These are covered conceptually in Section 2. We intentionally do not implement them for the demo.

---

## 2. Ingestion Strategy

### 2.1 Architecture Overview

```
 ┌─────────────────────────────────────────────────────────┐
 │                    Scheduled Refresh                     │
 │   node-cron @ */10 * * * *  (background, every 10 min) │
 └────────────────────┬────────────────────────────────────┘
                      │ fan-out (Promise.allSettled)
          ┌───────────┼───────────┐
          ▼           ▼           ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │RemoteOK  │ │Arbeitnow │ │HN Hiring │   ← Adapters
    │Adapter   │ │Adapter   │ │Adapter   │
    └─────┬────┘ └─────┬────┘ └─────┬────┘
          │             │             │
    ┌─────▼─────────────▼─────────────▼─────┐
    │          Rate Limiter (per source)     │   ← Token bucket
    │   acquires token before every request  │
    └──────────────────┬─────────────────────┘
                       │
    ┌──────────────────▼─────────────────────┐
    │       Circuit Breaker (per source)      │   ← 3-strike → 5-min open
    │   CLOSED → OPEN → HALF_OPEN → CLOSED   │
    └──────────────────┬─────────────────────┘
                       │
    ┌──────────────────▼─────────────────────┐
    │       fetch() with AbortController     │   ← 12s timeout
    └──────────────────┬─────────────────────┘
                       │
    ┌──────────────────▼─────────────────────┐
    │         Schema Drift Detector           │   ← MD5 key fingerprint
    │  SCHEMA_DRIFT logged if shape changes  │
    └──────────────────┬─────────────────────┘
                       │
    ┌──────────────────▼─────────────────────┐
    │            Normalizer                   │   ← raw → canonical JobListing
    └──────────────────┬─────────────────────┘
                       │
    ┌──────────────────▼─────────────────────┐
    │         LRU + TTL Cache                 │   ← stale-while-revalidate
    │   TTL: 15–30 min   SWR: 2×TTL          │
    └──────────────────┬─────────────────────┘
                       │
    ┌──────────────────▼─────────────────────┐
    │       User-facing Express API           │   ← /api/jobs, /api/health
    └─────────────────────────────────────────┘
```

### 2.2 Rotation & Pacing

**Rate limits (self-imposed, more conservative than source limits):**
- RemoteOK: 3 req/min (public API; their actual limit is higher)
- Arbeitnow: 5 req/min across 3 pages with jittered 2s inter-page delay
- HN Algolia: 10 req/min (free search API, very permissive)

**Jitter:** Inter-page delays are ±20% randomized. Perfectly uniform 2.000s / 2.000s / 2.000s timing is a recognized bot signal; 1.87s / 2.14s / 1.96s is not.

**For hostile targets (what you'd actually deploy against LinkedIn):**
- Residential proxy pool with per-session IP assignment
- Per-identity token bucket (each "user" = one residential IP + cookie jar)
- Warm-up period: 2–3 low-volume requests before the primary fetch
- Randomized viewport dimensions, mouse movement traces via Playwright
- Realistic session flow: homepage → search → job listing (not direct API call)

### 2.3 Fallback Strategy

```
Primary approach fails (IP banned, CAPTCHA wall, 403)?
  │
  ├─► Circuit opens → serve stale cache for up to 30 min
  │
  ├─► Try secondary source (e.g., RemoteOK has the same job)
  │
  ├─► Switch proxy identity (rotate to new residential IP)
  │
  ├─► Back off exponentially (5 min → 15 min → 1 hour)
  │
  └─► Alert operations (Slack webhook / PagerDuty)
       ↳ Human reviews whether the source changed its defenses
```

**What you'd do with a real week:**
- Implement proxy rotation using Brightdata or Oxylabs residential IPs
- Add Playwright-stealth for JS-rendered sources
- Build a per-source health dashboard with Grafana
- Add retry with exponential backoff (currently just circuit-break and serve stale)
- Persist to PostgreSQL so restarts don't lose data

---

## 3. Resilience

### 3.1 Failure Mode Matrix

```
┌────────────────────────────┬──────────────────────────────────────────────┐
│  Failure                   │  Recovery Mechanism                          │
├────────────────────────────┼──────────────────────────────────────────────┤
│  Source returns 429        │  Circuit breaker opens; stale cache served   │
│  Source times out (>12s)   │  AbortController fires; circuit records fail │
│  Source returns empty []   │  Normalizer returns []; no cache overwrite   │
│  Markup changes overnight  │  SCHEMA_DRIFT log emitted; stale served      │
│  Process restart           │  Scheduler re-warms cache within 2s         │
│  One source breaks         │  Other sources continue (Promise.allSettled) │
│  All sources break         │  Empty result + error state in UI            │
│  Render free-tier sleeps   │  Self-ping cron keeps instance warm          │
└────────────────────────────┴──────────────────────────────────────────────┘
```

### 3.2 Schema Drift Detection

On every normalized response, we compute `MD5(sorted_top_level_keys)`. If this changes between runs, a `SCHEMA_DRIFT` warning is logged with:
- Previous fingerprint
- New fingerprint  
- Actual key set received

The adapter then serves the last cached response rather than propagating potentially-broken normalized data. A human can inspect the log, update the normalizer, and redeploy — without a silent pipeline failure showing garbage to users.

### 3.3 Stale-While-Revalidate Cache

```
Time 0       TTL (15min)      2×TTL (30min)
│────────────────│────────────────│──────────────▶
│   FRESH        │    STALE       │   EXPIRED    │
│   serve fast   │ serve + refetch│   must fetch │
```

Between TTL and 2×TTL, we return stale data to the user immediately while triggering a background refresh. The user never waits on a slow upstream.

### 3.4 Observability

`GET /api/health` returns:
```json
{
  "ok": true,
  "uptimeMs": 123456,
  "cache": { "size": 3, "hits": 142, "staleHits": 12, "misses": 8, "hitRate": "0.951" },
  "circuits": {
    "remoteok":  { "state": "CLOSED", "failures": 0, "totalTrips": 0 },
    "arbeitnow": { "state": "CLOSED", "failures": 0, "totalTrips": 0 },
    "hn_hiring": { "state": "CLOSED", "failures": 0, "totalTrips": 0 }
  }
}
```

This is the contract you'd wire to a Prometheus scraper or Datadog integration.

---

## 4. Where We'd Stop

### 4.1 The Ethical Boundary

This system is designed around a clear principle: **if a platform provides a public API or public data feed, using it programmatically is legitimate**. All three sources in this demo explicitly permit automated access:

- **RemoteOK**: Public API with attribution requirement (linked in UI)
- **Arbeitnow**: Developer-documented public API, free tier
- **HN Algolia**: Free public search API, no ToS restrictions on automation

### 4.2 What We Deliberately Did NOT Build

For LinkedIn, Indeed, Naukri, and Wellfound:

| Action | Reason Avoided |
|---|---|
| Account-based scraping | Breaches LinkedIn ToS §8.2 and the CFAA (US law) |
| Bypassing login walls | Authentication circumvention; legal risk under CFAA |
| CAPTCHA solving services | Designed to defeat a security measure = terms violation |
| Fake browser fingerprints on their servers | Deceptive and adversarial |

The hiQ v. LinkedIn case (9th Cir. 2022) established that scraping publicly-visible data is *likely* not a CFAA violation — but that ruling is narrow, jurisdiction-dependent, and still being litigated. We operate well inside the safe zone.

### 4.3 The Technical Line

The full production scraping stack (residential proxies + Playwright-stealth + CAPTCHA solve) is documented above as **design knowledge** — understanding detection surfaces is necessary to build defensible systems. Implementing it against real LinkedIn accounts on someone else's behalf crosses the line between architecture and adversarial access.

**Personal line:** Build systems that fetch data platforms choose to share. Document how hostile targets work. Don't deploy credential-based or CAPTCHA-bypassing scrapers against live production accounts.

---

## 5. Deployment Guide

### Local Development
```bash
cd "Jon Ingest Tool"
npm install
npm start
# Open http://localhost:3000
```

### Render Deployment
1. Push this repo to GitHub
2. Connect repo on render.com → New Web Service
3. Build command: `npm install`
4. Start command: `node server/index.js`
5. Instance type: Free
6. The `render.yaml` file handles everything else automatically

### Health Check
```bash
curl https://your-app.onrender.com/api/health | jq .
```
