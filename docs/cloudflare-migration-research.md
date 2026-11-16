# LOOM → Cloudflare: migration feasibility research

**Question:** can the whole app + database run on Cloudflare's **free tier only**, and would that fix the "services feel really slow" complaint?

**Short answer: no, and it would not.** The free tier cannot run this app's request shape (10 ms CPU per request), cannot run its scheduled work (10 ms CPU per cron), and cannot run its database traffic (Hyperdrive Free = 100,000 queries/day; a single `/student` page view costs ~37 statements).

**The slowness has a different, cheaper cause that I verified in the repo:** production runs on Vercel with **no `vercel.json`**, so functions execute in `iad1` (Washington DC) — Vercel's documented default — while Postgres is in **`aws-0-ap-south-1`** (Mumbai). Every one of the 28 sequential queries on `/student` pays a transatlantic round trip. A one-line region pin is the fix, not a platform migration.

---

## 1. What the app actually is (verified from files)

| Fact | Evidence |
|---|---|
| Next.js 15.5.28, React 19, **JS/JSX only** | `package.json`, `package-lock.json` |
| Postgres driver = **`postgres` (postgres.js) 3.4.9**, module-level singleton pool `{max:10, idle_timeout:10, prepare:false}` | `lib/db.js` |
| DB is Supabase **ap-south-1 (Mumbai)**, via PgBouncer on `:6543` | `.env.local` / `.env.production.local` host `aws-0-ap-south-1.pooler.supabase.com` |
| Hosting: Vercel (`https://loom-self-omega.vercel.app`), **no `vercel.json`, no region config anywhere** | `ls`, `.env.production.local` |
| 145 route handlers, 108 pages, **855 raw `sql` call sites**, **80 migrations** | `Get-ChildItem app -Filter route.js`, `page.jsx`, `Select-String 'sql\`'` |
| `/student` issues **28 sequential `await sql`** before rendering | `app/(app)/student/page.jsx` |
| Tenant resolution adds 3 queries per request (memoized 60 s per isolate) | `lib/db.js#queryTenant` |
| `getRequestContext()` adds ~6 statements (RLS flag, profile, tenant, memberships+admin, helper heartbeat, consent) | `lib/auth-server.js` |
| Auth: **Auth0 v4** (`@auth0/nextjs-auth0` 4.32.1) front door + **Supabase Auth** fallback, both live in middleware | `lib/auth0.js`, `middleware.js` |
| RLS is real: ~30 `CREATE POLICY` statements, generated dynamically in migrations, applied via `set_config('app.tenant_id', …)` per statement | `load/migrations/031`, `033`, `054`; `lib/db.js#scopedSql` |
| Schema is Postgres-heavy: **280 `DO $$` blocks, 315 indexes, 238 CHECK constraints, 153 `gen_random_uuid`, 132 `ON CONFLICT`, 144 `RETURNING`, 95 array/`ANY`/`unnest` uses, 60 jsonb operators, 51 `ILIKE`**, 4 `LATERAL` joins | counted across `app/`, `lib/`, `load/` |
| Object storage = **Supabase Storage** (service-role, signed URLs, magic-byte validation) | `lib/storage.js` |
| Email = **Resend** over `fetch` | `lib/email-verification.js` |
| `R2_*`, `QSTASH_*`, `UPSTASH_*`, `SENTRY_DSN` are declared in `lib/env.js` but **no code path uses them** (grep hits only `lib/env.js`) | grep |
| Build output: `.next/server` = **786 files / 20.7 MB**, **4.7 MB deflate** | measured locally |
| Cron: one endpoint `GET/POST /api/jobs/run` with `CRON_SECRET`, 7 jobs incl. an N+1 `analytics-rollup` over every student | `app/api/jobs/run/route.js`, `lib/scheduler.js` |
| OG images via `next/og` `ImageResponse` (2 metadata routes + 1 card route) | `app/u/[username]/opengraph-image.jsx`, `app/u/[username]/card/[format]/route.js` |
| 9 components use `next/image`, no custom loader, `sharp` in `overrides` only | grep `from "next/image"` |

---

## 2. Current Cloudflare limits (fetched, Nov 2026)

| Limit | Workers Free | Workers Paid ($5/mo) | Source |
|---|---|---|---|
| Requests | **100,000/day** (Error 1027 after) | 10M/mo + $0.30/M | [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| **CPU per HTTP request** | **10 ms** | 30 s default, 5 min max | [limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) |
| CPU per Cron Trigger | **10 ms** | 30 s (<1 h interval) / 15 min | same |
| Memory | 128 MB | 128 MB | same |
| Subrequests/request | **50** | 10,000 | same |
| Simultaneous open connections | 6 | 6 | same |
| Worker size | **64 MiB uncompressed, no compressed cap** (page updated 13 Nov 2026) | same | same |
| Cron Triggers per account | **5** | 250 | same |
| Hyperdrive | **100,000 queries/day**, 10 configs, ~20 origin connections | unlimited queries, 25 configs, ~100 conns | [Hyperdrive pricing](https://developers.cloudflare.com/workers/platform/pricing/#hyperdrive), [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) |
| D1 | 5 GB total, **500 MB per DB**, 5M rows read/day, **100k rows written/day** | 10 GB/DB, 1 TB, 25B rows read/mo | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/#d1) |
| Durable Objects | SQLite backend only, 5 GB, 100k rows written/day | +KV backend | pricing |
| Images | **5,000 unique transformations/month** (transformations only; storage is paid) | $0.50/1k transforms | [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| Workers Logs | 200k events/day, **3-day retention** | 20M/mo, 7-day | pricing |
| Request body (zone Free) | 100 MB | 100 MB | limits |

⚠️ **Docs disagree on Worker size.** Cloudflare's own limits page says 64 MiB uncompressed / no compressed cap; the OpenNext page still says *"3 MiB Free / 10 MiB Paid (compressed)"* ([OpenNext overview](https://opennext.js.org/cloudflare)). Assume 3 MiB until a `wrangler deploy --dry-run` proves otherwise. **Measured here: `.next/server` deflates to 4.7 MB**, i.e. over the legacy free cap, under the current documented cap.

---

## 3. Compute: which Cloudflare target is actually supported today

| Option | Status for Next 15.5 App Router | Verdict |
|---|---|---|
| **`@opennextjs/cloudflare` (Workers)** | Supported. Supports "all minor and patch versions of Next.js 16 and **the latest minor of Next.js 15**" — this repo is 15.5.28, i.e. the latest 15 minor. Uses Next's **Node.js** runtime, so App Router, route handlers, middleware, ISR, PPR and `after()` are supported ([overview](https://opennext.js.org/cloudflare)). | **The only viable target.** |
| Pages + `@cloudflare/next-on-pages` | Legacy. next-on-pages only supports the **Edge** runtime, which "does not support all Next.js features" (same page). | Dead end — don't. |
| Pages as static host + separate API Worker | Requires splitting 145 route handlers out by hand. | No. |

Concrete things to be blunt about:

- **`pg`/`postgres` over TCP is not selectable "no" anymore — it's "only via Hyperdrive".** Workers now expose TCP through `cloudflare:sockets` + `nodejs_compat`, and Cloudflare documents postgres.js + Hyperdrive together ([postgres.js guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)). But **not to Supabase's pooler with this file's config**:
  > *"Do not use `prepare: false` with Postgres.js… Hyperdrive's transaction pooling mode does not reliably support this behavior. This can cause queries to hang or fail intermittently."*
  `lib/db.js` says `prepare:false` is **mandatory** because Supabase runs PgBouncer in transaction mode. The two constraints are directly contradictory: you must either point Hyperdrive at the **direct** connection (`:5432`, no PgBouncer) and flip to `prepare:true`, or you inherit intermittent hangs.
- **A module-level client is explicitly forbidden.** OpenNext: *"Instead of creating a global client, you should create a new client for each request… reuse the same connection for multiple requests… is not allowed in Cloudflare Workers, and will cause subsequent requests to fail"* ([db how-to](https://opennext.js.org/cloudflare/howtos/db)). `lib/db.js`'s `let client` singleton, `appClient`, and the module-level `tenantCache` Map all need rewriting to `cache()`-scoped clients.
- **`fs`, `child_process`, `readFileSync`**: not usable. I found none in `app/` or `lib/` — good news.
- **`node:crypto` is fully supported** except `argon2`, DSA/DH keygen, ed448/x448 ([docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)). So `lib/crypto.js` (AES-256-GCM token sealing), `lib/github.js` (HMAC + `timingSafeEqual`), `lib/email-verification.js` (`createHash`) all port unchanged. **This is the single most overestimated blocker; it isn't one.**
- **`sharp` is unavailable.** `next/image` needs either an `IMAGES` binding (Cloudflare Images) or `loader: "custom"`, and Cloudflare Images caps at 5,000 unique transformations/month on Free ([image how-to](https://opennext.js.org/cloudflare/howtos/image)). For a site serving avatar/resource imagery that ceiling is reachable in a busy week.
- **`next/og` / `ImageResponse`** (satori + resvg WASM) is the least-certain piece in this app. It is not listed in OpenNext's supported-features list and is a common workerd friction point. Treat it as **needs a spike**, with a static-fallback plan for `/u/*` and `/events/*` unfurl cards.
- **Windows dev caveat:** OpenNext says Windows is "not guaranteed" and recommends WSL or Linux CI ([overview](https://opennext.js.org/cloudflare)). This team develops on Windows with `npm run dev`; `wrangler dev` on Windows would be a new, occasionally-broken workflow.

---

## 4. The database (the crux)

Four candidate paths, all evaluated against 855 call sites of raw SQL:

| Path | Keeps Supabase? | Free-tier viability | Migration cost |
|---|---|---|---|
| **Hyperdrive → Supabase Postgres** | Yes (Hyperdrive is a proxy; the origin server is still Supabase) | **No.** 100k queries/day ÷ ~37 statements per `/student` view ≈ **2,700 page views/day**, then queries start failing for the rest of the UTC day. Free also caps ~20 origin connections. | Low code change (db.js + wrangler), high ceiling risk |
| **Supabase Data API (PostgREST) over HTTP** | Yes | Fails on capability, not quota: 855 call sites are hand-written SQL (`json_build_object`, `LATERAL`, `make_interval`, `::uuid` casts, `sql.json()`, multi-statement transactions). PostgREST cannot express them. | Effectively a full rewrite of the data layer |
| **D1 (SQLite)** | No — and **no auth, no RLS** | Storage OK (5 GB), but **100k rows written/day** and one single-threaded DO per DB | 6–12 weeks. See below. |
| **Durable Objects (SQLite)** | No | 100k rows written/day, 5 GB, DO-scoped | Wrong tool: relational multi-tenant app, not per-entity coordination |

**What a D1 move actually breaks, itemised against this schema:**

| Postgres feature | Count in repo | D1/SQLite outcome |
|---|---|---|
| **Row Level Security** (tenant isolation) | ~30 policies, enforced per statement | **No RLS in SQLite.** All tenancy must become `WHERE tenant_id = ?` in 855 places, with no database backstop. `tests/tenant-isolation.test.js` would test a guarantee that no longer exists. |
| `DO $$ … $$` PL/pgSQL | **280** | No procedural language. Every block is rewritten as DDL or app code. |
| `gen_random_uuid()` defaults | 153 | `hex(randomblob(16))` or app-generated UUIDs. |
| `ON CONFLICT … DO UPDATE` | 132 | Supported (SQLite upsert), but `EXCLUDED`/partial-index forms need review. |
| `RETURNING` | 144 | Supported since SQLite 3.35 — **not** a blocker. |
| Arrays / `= ANY($1)` / `unnest` | 95 | Unsupported; JSON or join tables. `lib/auth-server.js` uses `slug = ANY(${picked})` directly. |
| jsonb operators (`->>`, `json_agg`, `json_build_object`) | 60 | No jsonb. Aggregation moves into JS. |
| `ILIKE` / text search | 51 | `LIKE` + `COLLATE NOCASE` only; no `tsvector`. |
| `make_interval`, `NOW() - interval` | 11 | Rewrite as date arithmetic. |
| `LATERAL` joins | 4 | Unsupported. |
| `timestamptz`, `numeric`, `uuid` types | pervasive | TEXT/INTEGER/REAL; every read becomes a coercion site. |
| `information_schema` probes | 26 | `pragma table_info`. |
| `pg_cron` | 0 (comments only) | Not needed — but D1 has no scheduler anyway. |
| `pgvector` | 0 | Not a factor. |
| **Supabase Auth** | login, register, `/auth/supabase-callback`, E2E login | D1 has no auth. Auth0 could absorb it, but the canonical `user_id` mapping (`lib/user-identities.js`) and E2E programmatic login both assume Supabase Auth exists. |
| **Supabase Storage** | lead assets, MoU docs, finance receipts | Would move to R2 (S3 SDK = new dependency, forbidden by AGENTS.md rule 4 without justification). |

Files that would need line-level rewriting, not config: `lib/db.js`, `lib/auth-server.js` (RLS GUCs, `writeAudit`, consent gate), all of `lib/scheduler.js`, roughly 100 of the 145 route handlers.

---

## 5. Auth

- **Auth0 v4 is fine.** It runs today inside the Edge middleware (`middleware.js` → `auth0.middleware(request)`), which means it is already web-standard: `oauth4webapi` + Web Crypto + cookies. The v4 SDK requires Node 20 LTS or newer for local tooling; on Workers with `nodejs_compat` it executes as-is. `/auth/callback`, `/auth/login`, `/auth/logout`, backchannel logout all keep working. **The only change required is registering new Allowed Callback / Logout / Web Origin URLs in the Auth0 dashboard** — an operator step, not code.
- **`@supabase/ssr` 0.12.7 works on Workers** (it is `fetch` + cookie jar). `lib/supabase/server.js` uses `next/headers` `cookies()`, which OpenNext supports. Refresh-in-middleware logic in `middleware.js` is unaffected.
- **Real risk is not compatibility, it's quota:** `middleware.js` calls `auth0.getSession()` **and** `supabase.auth.getUser()` on essentially every non-public request. Each is an outbound subrequest. Free tier allows 50 subrequests/request — fine — but Auth0 and Supabase Auth are both non-Cloudflare origins, so nothing gets faster by moving compute.
- **Cookie size** is the thing that actually bites in middleware on Workers (header limits), and it is unchanged by a host move.

---

## 6. Cron and background work

Current shape: `app/api/jobs/run` with `CRON_SECRET`; 7 jobs; `analytics-rollup` loops **per student** and issues 5–6 statements each, then loops per tenant with 4–6 more, then per roadmap node, then per mentor. For a few hundred students that is **thousands of statements and minutes of wall time**.

| | Current (Vercel Hobby) | Cloudflare Free |
|---|---|---|
| Trigger | external cron / GH Action hitting a URL (Vercel Cron also exists) | Cron Triggers, **5 per account** |
| CPU budget | 300 s wall, 1 vCPU | **10 ms CPU** per cron invocation |
| Query budget | unlimited | 100k Hyperdrive queries/day shared with page traffic |

That job **cannot** run on Workers Free even once, and would need either batching (1,000 rows at a time across many invocations) or Cloudflare Queues/Workflows (paid). Timeouts note: on Workers, cron wall-clock is 15 min, but the 10 ms CPU cap kills it long before.

---

## 7. Static assets, images, uploads

- Static assets are free and unlimited on Workers ([pricing footnote 3](https://developers.cloudflare.com/workers/platform/pricing/)) and 20,000 files/version on Free — `public/` plus `.next/static` (351 files, 5.5 MB) fits.
- Next's built-in image optimizer does not run; you need the `IMAGES` binding (Cloudflare Images) or a custom loader. Free = **5,000 unique transformations/month**, then `9422` errors on new transforms ([Images pricing](https://developers.cloudflare.com/images/pricing/)). With 9 `next/image` call sites and a social-card culture, plan for `unoptimized` on avatars or a paid Images plan.
- Uploads go to Supabase Storage today; 100 MB request-body cap on the Free zone is well above the 25 MB `MAX_UPLOAD_BYTES` in `lib/media.js`, so upload path is compatible. Moving to R2 would delete a dependency on Supabase Storage but adds an S3 client.

---

## 8. Integrations

| Integration | Works on Workers? | Notes |
|---|---|---|
| Resend (email) | Yes | Plain `fetch` in `lib/email-verification.js` |
| GitHub OAuth + webhooks | Yes | HMAC verification only needs `node:crypto` |
| Supabase Storage | Yes | `supabase-js` is `fetch`-based; signed URLs unchanged |
| Auth0 Management API | Yes | M2M client credentials over `fetch` |
| QStash / Upstash Redis | Declared, unused | Nothing to migrate |
| R2 | Declared, unused | Would become the storage target only if you leave Supabase Storage |
| Sentry | DSN only, no SDK installed | No action |

**Nothing in the integration layer blocks a Workers move.** The blockers are CPU, query quota, and the DB driver.

---

## 9. Lock-in, observability, DX, CI, rollback, domain/SEO

- **Lock-in:** moving to Workers + Hyperdrive means your DB connection string becomes a Cloudflare binding (`env.HYPERDRIVE.connectionString`), your ISR cache becomes R2/KV, your images become Cloudflare Images. That's *more* platform coupling than Vercel+Supabase, not less. D1 is the strongest lock-in of all (SQLite dialect).
- **Observability:** Workers Logs Free = 200k events/day, **3-day retention** ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). Vercel Hobby is **1 hour** ([Vercel limits](https://vercel.com/docs/limits)) — so this is genuinely *better* on Cloudflare, but Tail Workers/Logpush (durable export) is Paid-only.
- **Local dev:** `npm run dev` → `next dev` today; you'd add `opennextjs-cloudflare dev`/`wrangler dev`, a second runtime, and Windows caveats. Every one of the 4 mandatory gates in `AGENTS.md` (lint, 1099 unit tests, build, 417 E2E) has to keep passing in a second build pipeline.
- **CI/E2E:** Playwright against `next start` works today. Against `wrangler dev` with a remote DB binding you get a networked, quota-metered target — and `E2E_PROD=1` runs would eat the 100k/day request budget.
- **Rollback:** Vercel = instant alias rollback. Workers = `wrangler rollback`/versions, equally good. No advantage either way.
- **Domain + SEO:** `lets-loom.xyz` moving to Cloudflare DNS is fine and improves TTFB for static assets, but **the canonical origin changes**, so `NEXT_PUBLIC_APP_URL`, `lib/seo.js` canonicals, `sitemap.js`, every JSON-LD `@id`, OG absolute URLs, and the Auth0 callback list all change together. Multi-tenant makes this worse: `tenant_domains` rows and every chapter's custom domain must be re-pointed, and each needs its own Cloudflare custom-domain binding (100/zone). A botched cutover here costs indexing, not just uptime.

---

## 10. Why it actually feels slow — and what Cloudflare would fix

The repo documents its own measurements in `lib/db.js`:

> *"~316 ms per statement… four extra round-trips at ~79 ms each"* and *"~288 ms [RLS-scoped] versus ~57 ms unscoped"*.

A same-region function-to-database round trip is **1–5 ms**. 79 ms per hop is the signature of a **cross-continent** hop. And that is exactly what the config produces: no `vercel.json` → functions in **iad1 (Virginia)**, database in **ap-south-1 (Mumbai)**. Vercel's own docs confirm `iad1` is the default for new projects and that Hobby allows **one** region ([Vercel regions](https://vercel.com/docs/functions/configuring-functions/region)).

Cost model for one `/student` view today:

| Step | Statements | Cost @79 ms/hop |
|---|---|---|
| middleware: Auth0 session (+sometimes Supabase `getUser`) | 1–2 network calls | 80–160 ms |
| `getRequestContext()` (RLS flag, profile, tenant, memberships, heartbeat write, consent) | ~6 | ~470 ms |
| `resolveRequestTenant()` → `queryTenant` (tenant + domains + flags) | 3 (cached 60 s per isolate) | 0–240 ms |
| page body | 28 | ~2,200 ms |
| **Total, cold** | **~37** | **~3 s** |

Under RLS rollout (`scopedSql`), each scoped statement becomes `BEGIN` + `set_config` + query + `COMMIT` — the file itself measured **288 ms vs 57 ms**. That's the "feels really slow" complaint, quantified.

**What a Cloudflare move would fix:** nothing structural. Workers execute near the user (India → Mumbai is close to the DB), which would cut the hop to single-digit ms — **but so would pinning Vercel to `bom1`**, which is one line and reversible in 60 seconds.

**What Cloudflare would *not* fix:** 28 sequential queries per page. That's an application design decision codified as iron rule 5 in `AGENTS.md` ("page queries stay sequential, never `Promise.all`") — a rule written for a PgBouncer pooler where parallel statements could land on different server connections. It is correct for that pooler, and it is the reason latency multiplies instead of hiding behind concurrency. **Moving hosts does not fix an N-query fan-out.** Only batching (one query returning a JSON blob, or `sql.begin` with several statements) does.

**What D1 *would* fix:** DB latency would collapse to sub-millisecond, and the DB would sit next to compute. That is real. It is also a 6–12 week rewrite that deletes RLS, PL/pgSQL, and Supabase Auth. You would be trading a 3-second page for a 300 ms page at the cost of the entire security model.

---

## 11. Cost comparison

| | Vercel Hobby + Supabase Free (**today**) | Vercel Hobby + Supabase Pro | Cloudflare Free + Supabase Free (via Hyperdrive) | Cloudflare Free + D1 |
|---|---|---|---|---|
| Hosting | $0 | $0 | $0 (100k req/day) | $0 (100k req/day) |
| DB | $0 (500 MB, **pauses after 1 week idle**) | $25/mo (8 GB, no pause) | $0 DB + **100k queries/day cap** | $0 (5 GB, 500 MB/DB, 100k writes/day) |
| Auth | $0 (Auth0 free tier + Supabase) | $0 | $0 | $0 (Auth0 only) |
| Images | $0 (Vercel optimizer) | $0 | 5,000 transforms/mo then broken | 5,000 transforms/mo then broken |
| Cron | $0 | $0 | 5 triggers, 10 ms CPU each | same |
| Realistic monthly | **$0** | **$25** | **$5** (Paid Workers — Free cannot run SSR) | **$5 + rewrite** |

Sources: [Supabase pricing](https://supabase.com/pricing) (Free: 500 MB, pauses after 1 week, 2 projects; Pro from $25, 8 GB, $10 compute credit covers one Micro), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

**Where Cloudflare Free actually breaks for this app, in order of when you'd hit it:**

1. **10 ms CPU** — every dynamic page. Cloudflare's own doc: SSR workloads "typically use 10–20 ms". You are below the floor before React renders anything. Symptom: Error 1102 "Worker exceeded resource limits" on `/student`.
2. **100k Hyperdrive queries/day** — ~2,700 `/student` views, shared with cron. Symptom: total DB outage for the rest of the UTC day.
3. **100k requests/day** — two Playwright runs plus a demo day.
4. **5,000 image transformations/month** — silent OG/avatar breakage.
5. **10 ms CPU per cron** — the rollup never completes.
6. **4.7 MB build vs legacy 3 MiB** — a deploy-time `10027` size error if the conservative limit still applies.

---

## 12. Verdict: three options, ranked

### A — Stay on Vercel, pin the region, fix the query shape ✅ **recommended**

`vercel.json`: `{"regions":["bom1"]}` (Mumbai, same metro as the DB). Hobby supports a single region, so this is free. Expect **~2,000 ms → ~100–300 ms** on `/student` with zero code change.

Then attack the fan-out: batch the 28 `/student` awaits into 4–6 statements (one `sql.begin` or CTE returning JSON), add the missing indexes, and stop paying `BEGIN/set_config/COMMIT` per statement under RLS.

- **Effort:** 30 min for the region pin (measure first, then measure again). 1–3 days for real query consolidation.
- **Risk:** very low, fully reversible.
- **Cost:** $0 (or $25 if the Supabase Free project pausing becomes a problem).

### B — Workers + `@opennextjs/cloudflare` + Hyperdrive + Supabase ⚠️ **only if leaving Vercel is a goal**

Viable *architecturally* — Next 15.5 is supported, middleware/route handlers/ISR are supported, `node:crypto` works — but it requires: per-request DB clients (`lib/db.js` rewrite), dropping `prepare:false` (which means pointing Hyperdrive at `:5432` and abandoning the PgBouncer assumption baked into every comment), image loader changes, an OG-image spike, a Windows/WSL dev workflow, and **Workers Paid ($5)** because 10 ms CPU will not render a React page. And it lands you on 100k queries/day unless you also restructure queries — i.e. **you still have to do all of Option A's work**.

- **Effort:** 1–2 days for a spike that proves or kills it; 2–4 weeks to get 145 routes + middleware + ISR + images green; more for the query-quota problem.
- **Risk:** medium-high. Silent failure modes: intermittent hangs from `prepare:false`, per-request client leakage, ISR cache misses, OG images 500ing in production only.
- **Upside vs Option A:** CDN-everywhere static assets, better log retention (3 days vs 1 hour), and no Vercel dependency. **Not** a latency fix that A doesn't already provide.

### C — Full Cloudflare incl. D1 ❌ **do not do this**

80 migrations, 280 `DO $$` blocks, 855 query sites, ~30 RLS policies, and a security model whose whole premise (`migrations/031`, `lib/auth-server.js` fail-closed tenant resolution, `tests/tenant-isolation.test.js`) is "the database enforces tenancy". SQLite has no RLS, no PL/pgSQL, no arrays, no jsonb, no `LATERAL`. You would delete the backstop that the app's entire multi-tenant design rests on, then re-implement auth (Supabase Auth has no D1 analogue) and rebuild ~100 handlers.

- **Effort:** 6–12 weeks of focused work; realistically longer with a 3-person team and a shipped product.
- **Risk:** critical. Tenant-isolation regressions are silent and permanent, not loud.
- **Payoff:** sub-millisecond DB, at the cost of the security model. Wrong trade.

**Ranking: A ≫ B > C.** Do A. Re-evaluate B only if "we must not use Vercel" becomes an actual requirement rather than a hypothesis about speed.

---

## 13. What to do first — 30-minute, $0 perf audit

1. **Measure the app, not the vibes.** `curl -w "%{time_starttransfer} %{time_total}\n" -o /dev/null -s https://lets-loom.xyz/` and the same for `/login`, `/student` (with a session cookie). Record TTFB before touching anything.
2. **Confirm the function region.** Vercel dashboard → Project → Settings → Functions → Function Regions. If it says `iad1` (it will, unless someone changed it in the dashboard — there's no `vercel.json`), you have found the bug.
3. **Add `vercel.json` with `{"regions":["bom1"]}` and redeploy.** Re-run step 1. Expect a 3–10× TTFB improvement on DB-backed pages. This is the whole fix, and it is one line.
4. **Count queries per page.** `grep -c 'await sql' 'app/(app)/student/page.jsx'` → 28. That is your second-order problem; nothing about it is Cloudflare-specific.
5. **Turn the RLS flag OFF in production while measuring.** `feature_flags.tenant_rls_enforced` currently costs `BEGIN`+`set_config`+`COMMIT` per statement — the repo measured 288 ms vs 57 ms. Either batch a request into one transaction (`withTenant`, which exists and has **no call sites**) or leave RLS dark until the queries are consolidated.
6. **Check the Supabase project isn't paused/throttled.** Free projects pause after 1 week of inactivity and run on shared CPU, 500 MB RAM ([Supabase pricing](https://supabase.com/pricing)).
7. **Check `pool_mode`.** `queryTenant`'s 60 s memo is per-isolate; on serverless with many isolates it barely helps. Consider `unstable_cache`/`revalidateTag` (there is already a `lib/server-cache.js`) so tenant config is cached across instances instead of per process.
8. **Look at the waterfall, not the number.** One `/student` load = 1 middleware fetch to Auth0 + 6 auth/tenant statements + 28 page statements. Batching the 28 into 5 is a bigger win than any host change.
9. **Verify the DB region assumption** in Supabase → Project Settings → Infrastructure. If it turns out to be `ap-south-1` (it is, per `.env.local`), `bom1` is correct. If you later move the DB to `us-east-1`, `iad1` becomes correct instead — the rule is *colocate*, not *Mumbai*.

---

## 14. Concrete migration deltas (if Option B is ever approved)

`lib/db.js` — from module singleton to request-scoped client. Note the `prepare` flip and the loss of the PgBouncer rationale:

```js
import postgres from "postgres";
import { cache } from "react";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { env } from "@/lib/env";

// One client per request. A module-level pool is forbidden on Workers.
export const getSql = cache(() => {
  const conn = env.HYPERDRIVE?.connectionString;
  if (conn) {
    return postgres(conn, {
      max: 5,              // Workers allow 6 concurrent outbound connections
      idle_timeout: 5,
      prepare: true,        // REQUIRED by Hyperdrive; was `false` for PgBouncer
      fetch_types: false,   // avoids an extra round-trip
    });
  }
  return postgres(env.DATABASE_URL, { max: 5, idle_timeout: 5, prepare: true });
});
```

`wrangler.jsonc` sketch:

```jsonc
{
  "name": "loom",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-11-16",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }],
  "images": { "binding": "IMAGES" },
  "triggers": { "crons": ["0 * * * *", "0 2 * * *"] },  // 5 max on Free
  "limits": { "cpu_ms": 30000 },                        // Paid only; ignored on Free
  "observability": { "enabled": true }
}
```

Other required edits: `next.config.mjs` image loader; `lib/db.js#tenantCache` → `unstable_cache`; every `sql.begin()` call site re-checked for `prepare:true` semantics; `middleware.js` unchanged *except* that Auth0's `appBaseUrl` must be set explicitly (`APP_BASE_URL=https://lets-loom.xyz`) since Workers `Host` handling differs; `next/og` routes need a spike.

---

## 15. What I could not verify (honesty section)

- Whether the Vercel project's region was overridden **in the dashboard** (no config file says so; the repo is silent).
- Whether the current production DB actually holds enough rows for the Supabase Free 500 MB ceiling — I did not query production.
- Whether Cloudflare still enforces the **3 MiB compressed** Worker cap in practice (docs conflict; only `wrangler deploy --dry-run` settles it).
- Whether `next/og` `ImageResponse` builds and serves under `@opennextjs/cloudflare` with Next 15.5 — no authoritative statement found either way; this needs a real spike, not a doc read.
- Actual p50/p95 of the DB hop from `iad1`. The 79 ms figure is the repo's own comment, not a measurement I took.

---

## Sources

- Workers limits — https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing (Hyperdrive, D1, DO, KV, Logs) — https://developers.cloudflare.com/workers/platform/pricing/
- Hyperdrive limits — https://developers.cloudflare.com/hyperdrive/platform/limits/
- Hyperdrive + postgres.js (and the `prepare:false` warning) — https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
- D1 limits — https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare Images pricing — https://developers.cloudflare.com/images/pricing/
- Workers `node:crypto` support — https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
- OpenNext Cloudflare overview (supported Next versions, runtimes, Worker size) — https://opennext.js.org/cloudflare
- OpenNext database/ORM guide (no global client) — https://opennext.js.org/cloudflare/howtos/db
- OpenNext image optimization — https://opennext.js.org/cloudflare/howtos/image
- Vercel function regions (`iad1` default, Hobby = single region) — https://vercel.com/docs/functions/configuring-functions/region
- Vercel limits (Hobby: 300 s functions, 1-hour runtime logs) — https://vercel.com/docs/limits
- Supabase pricing (500 MB / pause / Pro $25) — https://supabase.com/pricing
