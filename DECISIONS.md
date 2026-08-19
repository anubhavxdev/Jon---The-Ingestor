# DECISIONS.md

## 1. Why this ingestion strategy over the obvious alternative?

**Rejected alternative: direct headless-browser scraping of LinkedIn/Indeed.**

The obvious approach is Playwright + stealth plugin hitting real job search URLs. I rejected it for this demo on two grounds: it immediately crosses the ToS of every real target, and it would take hours to get through Cloudflare/reCAPTCHA before producing a single listing. The brief's scope guardrail is explicit: *run against a public source, not a live LinkedIn account*.

Instead I chose a **public-API adapter pipeline** using RemoteOK, Arbeitnow, and HN Algolia — all three explicitly permit automated access. The payoff: the *architecture* (circuit breaker, token bucket, schema drift detection, stale-while-revalidate cache) is identical to what you'd deploy against a hostile target. The only delta is the legality and difficulty of the source. Every engineering decision in the design document is transferable to a real hostile stack; the demo just runs it against cooperative sources.

The secondary reason: public APIs return structured data. This let me invest build time in the *pipeline* (resilience, caching, observability) rather than in fragile CSS selectors that break every two weeks.

---

## 2. One trade-off made under the time limit

**Persistence: no database.**

All cached data lives in process memory. A Render free-tier restart (which happens on every deploy, and after long sleep periods) wipes the cache. The scheduler re-warms it within ~15 seconds on boot, but there's a cold-start window where users see skeletons before real data arrives.

**With a real week:**
- Add a SQLite (or PostgreSQL on Render's free tier) persistence layer — write normalized jobs on every fetch, read from DB on startup
- This eliminates the cold-start window entirely and enables historical job tracking (deduplication across runs, "new since last visit" badges, trend analytics)
- Estimated: ~4 hours to implement the DB layer + dedup logic + migration script

The decision to skip persistence was deliberate: correctness of the pipeline patterns (circuit breaker, drift detection, SWR cache) matters more for this deliverable than operational durability.

---

## 3. Where AI tools were used and what was personally verified

**AI used for:**
- Initial scaffolding of the LRU cache class and circuit breaker state machine — generated the skeleton, I reviewed the state transitions (CLOSED→OPEN→HALF_OPEN) and added the missing `recoversInMs` calculation to the status output
- The CSS design system — generated the token definitions and card layout; I rewrote the skeleton animation and the glassmorphism `::before` hover overlay after the first pass used `filter: blur()` on the card itself (wrong — blurs content, not background)
- The HN Algolia two-step fetch pattern — AI suggested fetching thread ID then comments separately; I verified the actual Algolia endpoint shape by hitting `https://hn.algolia.com/api/v1/items/:id` directly and confirmed the `children[]` structure
- The DESIGN.md detection surface table — AI listed the signals; I added the JA3/HTTP2 SETTINGS row (missing from the first draft) and the hiQ v. LinkedIn legal note from my own knowledge of the case

**Personally verified and changed:**
- The `jitter()` function in the Arbeitnow adapter — the AI version used `Math.random() * 0.4` (always positive delay increase). I changed it to `(Math.random() - 0.5) * baseMs * 0.4` so jitter is symmetric (sometimes faster, sometimes slower), which is more realistic
- The SWR window boundary — the first draft used `ttlMs * 1.5`; I changed it to `ttlMs * 2` so the stale window is a full TTL worth of time, giving background refresh a realistic chance to complete before expiry
- The `Promise.allSettled` pattern in `scheduler.js` and `server/index.js` — verified that a rejected promise from one adapter doesn't suppress results from the others (which `Promise.all` would do)
- The `AbortController` + `clearTimeout` pattern in every adapter — tested locally that timeouts actually abort the fetch and don't leave dangling promises
