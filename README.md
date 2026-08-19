# JobStream 🔥

> pulling live job listings without catching a ban. no cap.

[![Status](https://img.shields.io/uptimerobot/status/FU6PyEqAZ8?label=pipeline&style=for-the-badge&color=00c853)](https://stats.uptimerobot.com/FU6PyEqAZ8)
[![Uptime](https://img.shields.io/uptimerobot/ratio/FU6PyEqAZ8?style=for-the-badge&color=7c3aed)](https://stats.uptimerobot.com/FU6PyEqAZ8)

---

## what even is this

ok so LinkedIn and Indeed will literally **not** give you their data without paying or getting your IP nuked within 5 minutes. this project is about understanding *how* that works and building a pipeline that doesn't fumble.

the live demo pulls from **3 real sources**, right now, no auth, no scraping drama:

| source | vibe | jobs |
|---|---|---|
| 🟢 RemoteOK | public API bestie | ~100 |
| 🔵 Arbeitnow | paginated, very chill | ~450 |
| 🟠 HN Who's Hiring | monthly thread, chaotic good | ~240 |

**790+ live jobs. all circuits green. zero bans.** it's giving pipeline architecture.

---

## the tech stack (lowkey impressive)

```
Node.js 18+ (native fetch, no dep bloat)
Express (routes + health endpoint)
node-cron (background refresh, keeps render free tier awake fr)
Vanilla CSS (glassmorphism, dark mode, no tailwind needed bestie)
```

zero databases. zero paid APIs. zero nonsense.

---

## how the anti-detection stuff actually works

this is the part that actually matters. here's what gets you banned on real sites and what we do about it:

### 🕵️ detection surface (what gives bots away)

```
TLS layer      →  JA3 fingerprint mismatch (your cipher suites ≠ Chrome's)
HTTP headers   →  missing sec-ch-ua, wrong Accept-Language, no Cookie jar
timing         →  perfectly uniform 2.000s / 2.000s / 2.000s gaps = bot coded
browser JS     →  navigator.webdriver === true, no Chrome plugins object
volumetric     →  100 req/min from one datacenter IP = instant death
```

### 🛡️ what we actually built

**circuit breaker** (the goat of resilience patterns)
```
CLOSED → normal, requests flow
OPEN   → 3 failures hit? we stop hitting the source for 5 min. not crashing out
HALF_OPEN → one probe after recovery, if it works we're back
```

**token bucket rate limiter**
- remoteok: 3 req/min
- arbeitnow: 5 req/min + ±20% jitter between pages (uniform timing = red flag fr)
- hn algolia: 10 req/min (they're built different, very permissive)

**stale-while-revalidate cache**
```
0────────────────TTL (15min)────────────────2×TTL (30min)
│    FRESH       │    STALE (serve + refetch in bg)    │ EXPIRED │
```
users always get data instantly. slow upstreams are a background problem.

**schema drift detection**
every fetch computes an MD5 of the response's top-level keys. if RemoteOK
ships a breaking change at 3am, you get a `SCHEMA_DRIFT` warning in logs
and stale cache instead of silently serving garbage. slay.

---

## run it locally (literally 2 commands)

```bash
npm install
npm start
# open http://localhost:3000
```

that's it. no env vars. no API keys. no setup hell. fr.

---

## deploy to render (free tier, 3 steps)

```bash
# 1. push to github
git init && git add . && git commit -m "ship it"
git remote add origin https://github.com/YOUR_USERNAME/job-ingest-tool.git
git push -u origin main

# 2. go to render.com → New → Web Service → connect repo
# build:  npm install
# start:  node server/index.js
# plan:   Free

# 3. done. render.yaml handles the rest.
```

your live URL: `https://job-ingest-tool.onrender.com`

> [!NOTE]
> Render free tier sleeps after 15 min of inactivity. the scheduler self-pings
> every 12 min to keep it warm during the demo window. big brain move.

---

## api (clean, documented, no gatekeeping)

```bash
# all jobs — filterable, paginated
GET /api/jobs?q=react&remote=true&page=1&limit=20

# single source
GET /api/jobs/remoteok
GET /api/jobs/arbeitnow
GET /api/jobs/hn_hiring

# pipeline health — circuit states, cache hit rate, uptime
GET /api/health

# manually trigger a refresh (no auth in demo, would be gated in prod)
POST /api/refresh
```

---

## project structure (organized, not chaotic)

```
job-ingest-tool/
├── server/
│   ├── index.js           ← express app + routes
│   ├── config.js          ← source registry (timeouts, rate limits, headers)
│   ├── cache.js           ← LRU + TTL, stale-while-revalidate
│   ├── circuitBreaker.js  ← CLOSED/OPEN/HALF_OPEN state machine
│   ├── rateLimiter.js     ← token bucket per source
│   ├── normalizer.js      ← raw → canonical schema + drift detection
│   ├── scheduler.js       ← background cron + self-ping
│   └── adapters/
│       ├── remoteok.js
│       ├── arbeitnow.js
│       └── hnHiring.js    ← two-step algolia fetch (thread id → comments)
├── public/
│   ├── index.html         ← SPA frontend
│   ├── styles.css         ← dark mode glassmorphism (it's giving premium)
│   └── app.js             ← filter, search, health panel, load more
├── DESIGN.md              ← full design doc (detection surface, strategy, resilience, ethics)
├── DECISIONS.md           ← 3 questions, 1 page, no fluff
├── render.yaml            ← deploy config
└── package.json
```

---

## where the ethical line is (important, not skipping this)

this project uses **only public APIs** that explicitly allow automated access.

| ✅ what we do | ❌ what we don't do |
|---|---|
| public API with attribution | account-based scraping |
| polite rate limiting | bypassing login walls |
| honest bot User-Agent | fake browser fingerprints |
| ToS-compliant sources | CAPTCHA solving services |

for the full breakdown of what a real hostile scraping stack looks like (residential proxies, Playwright-stealth, JA3 spoofing) and where the legal/ethical line sits — read [`DESIGN.md`](./DESIGN.md) section 4.

> [!IMPORTANT]
> the hiQ v. LinkedIn ruling (9th Cir. 2022) says scraping publicly-visible
> data is probably not a CFAA violation. "probably" and "jurisdiction-dependent"
> are doing a lot of heavy lifting there. we stay well inside the safe zone.

---

## what i'd do with a real week

- [ ] persist jobs to SQLite so restarts don't wipe cache
- [ ] add deduplication (same job appears on multiple sources)
- [ ] exponential backoff on failures (currently just circuit-break and serve stale)
- [ ] Playwright-stealth adapter for JS-rendered sources (sandboxed, no real accounts)
- [ ] Grafana dashboard on top of `/api/health`
- [ ] proxy rotation layer (documented in design, not implemented)

---

## bugs found during testing (transparency mode on)

both caught by actually running it, not vibes-checking:

1. **RemoteOK date field** — API returns ISO 8601 string (`"2026-08-18T19:57:52+00:00"`), not a Unix epoch. code was doing `date * 1000`. fixed.
2. **HN field name** — Algolia's items endpoint uses `text`, the search endpoint uses `comment_text`. 240 listings were dropping to 0 because the filter was checking the wrong field. fixed.

---

---

## pipeline status (live)

🟢 **[stats.uptimerobot.com/FU6PyEqAZ8](https://stats.uptimerobot.com/FU6PyEqAZ8)** — real-time uptime for the ingestion pipeline

monitors `/api/health` every 5 min. if something's cooked, it'll show here before anyone notices.

---

*built with actual engineering judgment, not just vibes. read the design doc.*
