# N409 — Final Status Report

> **Date:** 2026-07-07 · **Branch:** `main` @ `28d1a93` · **Deployment verified:** Hetzner 204.168.241.124, build of 2026-07-07 18:12 UTC, services restarted 18:18 UTC.
>
> Definitive status of the N409 rebuild of the 409.ai valuation platform: what is
> built, what is deployed and healthy, whether admin deserves its own website,
> and every gap that remains against 409.ai — plus where N409 can pull ahead.
> Successor to [`remaining-gaps.md`](./remaining-gaps.md) (2026-07-06) and
> [`n409-remaining-features-spec.md`](./n409-remaining-features-spec.md), both of
> which are now fully or almost fully addressed.

---

## 1. Executive summary

- **All 30 feature commits are on `main`**: milestones M0–M4 (32 features), the
  P0 integration wave (Stripe, SMTP, onboarding funnel, signature gating), the
  engine-fidelity wave (true OPM backsolve, waterfall allocation, per-approach
  recompute), and all 13 numbered features of the remaining-features spec
  (P0 #1–4, P1 #5–9, P2 #10–13). Nothing from the spec is outstanding.
- **The unit test suite passes clean** — `npm run test:unit` (build + all
  workspaces) exits 0; the web-frontend workspace alone reports 26 files /
  105 tests passed.
- **Production is healthy and current.** All five systemd units are
  `active (running)`, every port (3000–3004) answers HTTP 200, every `/ready`
  probe passes (Postgres ok, OpenRouter key configured with 3 models, engine
  `py-1.0.0`). The deployed build includes the newest migration
  (`0048_help_articles.sql`) and the newest routes (`adminEvents`, `help`), so
  **prod = HEAD**. Disk 15 % used, ~2.5 GB RAM available.
- **One real operational gap:** Stripe, SMTP, and Google OIDC are
  **code-complete but not configured in production** — `/opt/N409/.env` has no
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `EMAIL_MODE`/`SMTP_*`, or
  `GOOGLE_*` values. Checkout returns "not configured", emails go to the
  log transport, and Google SSO is hidden. Enabling them is a config change,
  not a code change (keys already exist in `keys/`).
- **Admin recommendation: keep it integrated.** Twelve admin surfaces behind
  route-level guards and server-enforced RBAC do not justify a second website;
  the wins are nav grouping and code-splitting, not a separate deployment
  (full reasoning in §3).
- **Feature parity with 409.ai is effectively reached.** The remaining deltas
  are a dozen small polish items (§4.3) — none blocks the end-to-end business
  flow of request → pay → upload → extract → compute → review → sign → publish.

---

## 2. Current status

### 2.1 Commit history (all of `main`, newest first)

| Commit | Feature |
|---|---|
| `28d1a93` | Account-level billing page (P2 #13) |
| `7af9dee` | DB-backed knowledge base + admin editor (P2 #10) |
| `a71b82e` | Partner org management — archive, detail, branding (P1 #7) |
| `91c21de` | Global activity log viewer + admin-action eventing (P2 #12) |
| `cee47dc` | Per-event notification channel preferences (P2 #11) |
| `b95da2a` | Review queue + approve/request-changes workflow UI (P1 #6) |
| `849b735` | Reactivate deactivated users (#9 residual) |
| `8608579` | Prompt version history + revert (P1 #8) |
| `57a5eb9` | Role-based route guarding + role-aware landing (P1 #5) |
| `782285c` | Dashboard pivot drill-through + per-state detail + ops-only analytics (P0 #4) |
| `a926373` | Partners console + email outbox UI + admin nav (P0 #1) |
| `81a32a8` | Password reset flow + user invitations (P0 #3, #9) |
| `6e0fdc9` | Price transparency, payment redirect pages, history UI, receipts (P0 #2) |
| `fa617e5` | P0 integrations — Stripe payments, SMTP delivery, onboarding funnel, signature gating |
| `9e28705` | Cap-table anonymization, attachment summaries, XLSX extraction |
| `cc9c37a` | Bot prompts, company profiles, package explorer, help widget |
| `1f1e57a` | True OPM backsolve, waterfall allocation, per-approach recompute |
| `36c3e56`–`fbf7525` | Milestone merges: M1+M2 (pipeline, output & delivery), M3 (operations), M4 (polish) |
| `3b27fe6` | React SPA — login, dashboard, valuation workflow, RBAC-aware UI |
| `5333e38` | Milestone 0 — foundations |
| `fc6c18d` | Phase 0–1 — discovery crawl + design doc set |

### 2.2 System inventory

**Architecture:** 5 services + shared package, single Hetzner host, systemd,
rsync-based deploy to `/opt/N409`.

| Port | Unit | Service | Role |
|---|---|---|---|
| 3000 | `n409-web` | `services/web` (Node/Fastify) | Serves the built React SPA, proxy shell |
| 3001 | `n409-valuation` | `services/valuation` (Node/Fastify + Postgres) | Core API — all business logic |
| 3002 | `n409-ai` | `services/ai` (FastAPI) | AI pipelines via OpenRouter |
| 3003 | `n409-engine-wrapper` | `services/engine-wrapper` (FastAPI) | Valuation calc engine |
| 3004 | `n409-report` | `services/report` (Node) | Stateless HTML→PDF rendering |

**Core API surface:** ~113 REST endpoints across 30 route modules
(`src/services/valuation/src/routes/`): auth (11, incl. Google OIDC, password
reset, invitations), valuations CRUD + events, workflow
(advance/restart/reassign/bulk), documents, AI job orchestration + extract
auto-apply, calculations, workbook, overwrites (+ schema), params, reports
(versions, revert, render, PDF), report templates, funding rounds +
transactions, comments/chat/notes + inbound email, tasks + reviews, search,
exports, sensitivity, signatures, payments (Stripe checkout + webhook +
receipts + billing), notifications + preferences + email outbox, prompts
registry (versions, revert, test), help articles, support messages, admin
users/partners/API tokens, admin events. AI service: `/ai/v1/models`,
`/ai/v1/test`, `/ai/v1/pipelines/{pipeline}`. Engine: `/engine/v1/compute`.
Report: `/render/v1/pdf`.

**Web SPA:** 44 routes — 6 public auth pages, 10 client pages (dashboard,
valuations list/new, onboarding, payment redirects, search, notifications,
help, billing, settings), an 11-tab valuation workspace (details, company,
documents, params, AI, tasks, calculations, workbook, overwrites, report,
package), 12 admin/ops pages (§3.1), and a partner portal.

**Database:** 33 tables (users/roles/user_roles, partners, valuations,
valuation_params/events/comments/signatures/transactions, funding_rounds,
documents, ai_jobs/ai_prompts/ai_prompt_versions, calculations,
workbook_cells, overwrites, reports/report_versions/report_templates,
review_tasks, payments, api_tokens, notifications/notification_preferences,
email_outbox, support_messages, help_articles, admin_events,
password_reset_tokens, user_invitations, company_profiles), 19 migrations
through `0048`.

**Valuation engine** (`engine-wrapper/app/engine/`): weighted 4-approach model
(income DCF, market multiples, asset value, OPM), **true OPM backsolve** via
Newton–Raphson/bisection root-finding against the last round PPS,
**multi-class waterfall allocation** (`allocate_waterfall`, breakpoints and
per-class per-share), Black-Scholes, Chaffee + Finnerty DLOM, implied
volatility, per-subsystem recompute (`prior_approaches` reuse).

**AI pipelines** (`services/ai/app/pipelines.py`): `missing_data`, `extract`
(field-whitelisted, quote + confidence provenance, auto-apply endpoint),
`comparables`, `summarize`; **cap-table anonymization on by default**; PDF +
XLSX + text extraction; OpenRouter with 3-model ordered fallback; DB-backed
prompt registry with versioning, revert, and live test.

**Integrations:** Stripe (checkout session, webhook as paid-status source of
truth, receipts), SMTP transport behind the outbox (`EMAIL_MODE=smtp|log|off`),
Google OIDC SSO, OpenRouter. Attribution capture (`source`, `gclid`).

### 2.3 Deployment health (verified live 2026-07-07)

| Check | Result |
|---|---|
| systemd units | 5/5 `active (running)` |
| HTTP root, ports 3000–3004 | 200 × 5 |
| `/ready` web (3000) | ready |
| `/ready` valuation (3001) | ready, `postgres: ok` |
| `/ready` ai (3002) | ready, OpenRouter key configured, 3 models |
| `/ready` engine (3003) | ready, `engine: py-1.0.0` |
| `/ready` report (3004) | ready |
| Deployed build freshness | dist files 2026-07-07 18:12 UTC; migrations through `0048` present → **matches HEAD** |
| Disk / memory | 5.1 G/38 G used (15 %); ~2.5 G RAM available of 3.8 G |

**⚠️ Production env gap:** `/opt/N409/.env` defines only `DATABASE_URL`,
`DOCUMENTS_DIR`, `JWT_*`, `OPENROUTER_API_KEY`, `REDIS_URL`, `OTEL_*`,
`LOG_LEVEL`, `NODE_ENV`. Missing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`EMAIL_MODE=smtp` + `SMTP_*`, `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`. Until
set, payments return a "not configured" problem, transactional email is
log-only, and Google SSO stays hidden. Credentials for Stripe/SendGrid/Google
already live in `keys/` — this is a 10-minute config task plus a Stripe
webhook registration.

---

## 3. Admin: separate website or integrated section?

### 3.1 What exists today

Twelve admin/ops surfaces, all inside the single SPA behind nested guard
routes (`App.tsx:94–110`):

| Route | Page | Guard |
|---|---|---|
| `/tasks` | Review tasks queue (approve / request changes) | `isOps` |
| `/templates` | Report template management | `isOps` |
| `/schema/overwrites` | Overwrites schema explorer | `isOps` |
| `/admin/prompts` | AI prompt registry (edit, version, revert, test) | `isOps` |
| `/admin/support` | Support inbox | `isOps` |
| `/admin/outbox` | Email outbox / delivery status | `isOps` |
| `/admin/activity` | Global activity log | `isOps` |
| `/admin/help` | Knowledge-base article editor | `isOps` |
| `/valuations/:id/sensitivity` | Sensitivity stress grids | `isOps` |
| `/admin/users` | Users & roles (invite, deactivate, restore, CSV export) | `canManageUsers` |
| `/admin/partners`, `/admin/partners/:id` | Partner org console (archive, branding, detail) | `canManageUsers` |

**RBAC model:** 17 seeded roles in three groups — 12 ops roles (`admin`, `god`,
`supervisor`, `support*`, `reviewer*`, `data*`, `auto`, `spa`), 2 partner
roles, 2 client roles; `admin`/`god`/`supervisor` form the user-admin tier
(`lib/rbac.ts`, mirroring the server's `auth/rbac.ts`). Enforcement is
layered: the **API is the real policy** (scope-aware reads, field-level PATCH
permissions, 404-not-403 for out-of-scope ids); the client guard
(`RequireRole`) only prevents rendering admin shells that would 403. The nav
(`AppLayout.tsx:191–236`) is role-partitioned: clients see 8 items, partners
get a portal link, ops users see an additional 8-item operations block and
user-admins 2 more.

### 3.2 Assessment

- **Volume:** 12 admin pages vs ~10 client pages — a genuine ops console, but
  not a sprawling one. The ops nav is ~17 items in one flat list: *approaching*
  cluttered, not yet a problem.
- **Coupling is an asset here.** Ops work is valuation-centric: reviewers jump
  from the review queue into the same valuation workspace (workbook,
  overwrites, report, signatures) clients see. A separate admin site would
  either duplicate the entire workspace or bounce users between two apps
  mid-review — the single most common ops flow would get worse.
- **Security posture doesn't improve materially with a split.** RBAC is
  enforced server-side per request; a separate origin adds cookie/CORS surface
  and a second session model while the API attack surface stays identical.
- **Cost of a split at current scale** (solo maintainer, one host, 5 units):
  a 6th deploy unit, duplicated auth/layout/design-system code or an extracted
  shared package, drift risk, and double the frontend release work.

### 3.3 Recommendation

**Keep admin integrated. Do not build a separate admin website.** The
threshold for a split — divergent user bases with no shared screens, separate
release cadence, compliance isolation, or an admin team that must not receive
the client bundle — isn't met, and the strongest ops flow depends on sharing
the valuation workspace. Instead, spend a fraction of that effort on:

1. **Nav grouping** — collapse the ops block into two labeled, collapsible
   sections ("Operations", "Administration") in `AppLayout`; this fixes the
   only real symptom (a long flat list).
2. **Code-split the admin pages** (`React.lazy` per guard block) so client
   sessions never download admin code — captures the main technical benefit of
   a separate site at ~zero cost.
3. **Optional later:** serve the same SPA at `admin.…` with an ops-only landing
   if ops staff want a bookmarkable "admin home". Because RBAC is
   server-enforced, this is purely cosmetic and can wait.

Revisit only if (a) a dedicated ops team grows past ~5 people with workflows
that stop touching the client workspace, or (b) compliance demands bundle/origin
isolation.

---

## 4. Final gap analysis vs 409.ai

### 4.1 What N409 now has (complete feature list)

**Lifecycle & domain** — 13 product kinds; 14-state lifecycle with
`waiting_on_client` overlay; append-only event spine (DB-trigger immutability);
workflow advance/restart/reassign; bulk actions; clone + roll-forward flag;
state-change hooks firing email + in-app notifications.

**Auth & access** — email/password + Google OIDC; JWT sessions; password
reset; user invitations + accept flow; 17 roles; scope-aware RBAC with
field-level permissions; route-level guards; role-aware landing; partner API
tokens (hashed, revocable); user admin console with CSV export, deactivate +
restore; partner org console with archive, detail, branding.

**Pipeline** — document upload (11 kinds, sha256, soft delete); AI
missing-data / extraction (whitelisted, quoted, confidence-scored, one-click
apply-to-params) / comparables / attachment summarization; cap-table
anonymization; XLSX + PDF + text ingestion; DB-backed prompt registry with
history, revert, and test bench; typed review tasks (10 kinds, SLA); review
queue with approve / request-changes.

**Engine** — 4 weighted approaches; true Newton–Raphson OPM backsolve;
multi-class waterfall allocation with breakpoints; Chaffee + Finnerty DLOM;
DLOC; implied volatility; per-approach recompute; sensitivity grids incl.
risk-free-rate axes; every run persisted.

**Output & delivery** — 68-field overwrites system + self-documenting schema
explorer; recomputed workbook; WYSIWYG report editor with sanitization,
immutable versions, revert; PDF rendering; versioned report templates
(draft/active/archived); signature capture with publish gating.

**Commerce** — Stripe checkout, webhook-driven paid status, receipts, price
transparency, payment history, account billing page; client onboarding funnel
(request → pay → upload → track).

**Operations** — comments/chat/sticky-notes/email threads; inbound-email →
valuation resolution; advanced filters + tabbed scopes with live counts;
dashboard pivot with drill-through and per-state detail; global search; CSV +
PDF export; support inbox + in-app help widget; DB-backed knowledge base +
admin editor; notifications with per-event channel preferences; email outbox
viewer; global activity log; funding rounds + transaction history; company
profile editor; package explorer; QSBS, multi-currency, attribution capture,
delivery-day SLAs.

### 4.2 Spec-item scorecard

Every numbered item from `n409-remaining-features-spec.md` — **13/13 shipped**
(P0 #1–4: admin nav, payments UI, password reset, dashboard pivot; P1 #5–9:
role routing, review workflow UI, partner management, prompt registry admin,
user invitations incl. reactivation; P2 #10–13: help/KB, notification
preferences, activity log, billing page). From `remaining-gaps.md` §6, all
four P0 recommendations and 4 of 5 P1 recommendations shipped (see residuals
below for the exceptions).

### 4.3 Remaining gaps — everything, however small

**Operational (fix first, config not code):**

1. **Stripe / SMTP / Google OIDC not enabled in prod** (§2.3). The single
   highest-leverage item on this list.
2. **No inbound mail relay deployed** — `POST /inbox/email` awaits a relay
   (e.g. SendGrid inbound parse) pointing at it.

**Feature residuals vs 409.ai:**

3. **Unassigned-email triage queue** — an inbound email that matches no
   valuation is rejected 422 (`routes/comments.ts:193`) instead of landing in
   a manual-routing queue (409.ai §3.4).
4. **Read/unread markers** — `admin_read_at` / `user_read_at` columns exist
   but nothing writes them; no per-row unread indicator or "Unread" scope.
5. **Clone depth** — clone copies engagement + params only
   (`repos/valuations.ts:384`); documents, funding rounds, and workbook are
   not carried over; no roll-forward engine math (R `FRODO` equivalent).
6. **Report template bodies not merged** — templates are versioned and managed
   but new reports still use the single built-in 409a layout
   (`domain/report.ts`); `template_version` isn't bumped on regeneration; no
   bespoke non-409a layouts.
7. **Requester search** — worklist `q` matches company name + workflow id
   only (`repos/valuations.ts:229`); 409.ai also matches requester email and
   name.
8. **Sensitivity "implied" views** — RFR axes shipped, but grids show price
   variations only, not the implied-value variant.
9. **Report editor depth** — no tables, images, or links in the
   contentEditable editor; adequate for edits, thin for authoring.
10. **Worklist row polish** — no payment/partner/reapplication badges or
    quick actions (Company Overview / Uploads / Summary) on rows.
11. **Google Ads round-trip** — `gclid` captured and charted, no conversion
    upload back to Ads.
12. **Premium AI providers** — OpenRouter free-tier models only; the prompt
    registry already binds models per pipeline, so adding
    Anthropic-direct/Bedrock is a routing adapter away.
13. **Object storage** — documents on local disk, PDFs as `bytea`; fine for
    one host, blocks horizontal scaling (infrastructure posture, not a user
    -visible gap).

None of these blocks the end-to-end business flow; items 3–5 are the only
ones an ops team would notice weekly.

### 4.4 Beyond parity — where N409 can beat 409.ai

Already ahead today:

- **Transparent math** — the workbook, self-documenting overwrites schema
  explorer, and per-run persisted calculations expose the model in a way
  409.ai's opaque R engine does not.
- **Extraction provenance** — every AI-extracted value carries a source
  document, supporting quote, and confidence score, with a human apply step.
- **Modern engine ergonomics** — per-approach recompute avoids full-model
  re-runs; prompt registry has versioning + a live test bench.
- **Privacy by default** — cap-table anonymization before any LLM call.
- **Own design system** — coherent, responsive, dependency-light.

Proposed competitive advantages (ranked by effort-to-impact):

1. **Audit-defense bundle** (small) — one-click export of the full evidence
   package: signed report PDF, calculation history, event timeline,
   signatures, document manifest with hashes. The append-only event spine and
   version tables make this nearly free, and it directly addresses the buyer's
   real fear (an IRS/auditor challenge). 409.ai has nothing client-visible
   here.
2. **Client-facing scenario sandbox** (medium) — expose a read-only slice of
   the sensitivity engine ("what if we raise at $X next year?") to clients.
   409.ai keeps sensitivity ops-only; founders would use this constantly.
3. **Auto-pipeline on upload** (small) — on document upload, automatically run
   extraction → propose params → draft calculation, so ops opens a valuation
   that is already 80 % populated. All the pieces exist; this is orchestration.
4. **Cap-table platform import** (medium) — direct Carta/Pulley export
   ingestion (XLSX parsing already exists) to eliminate the biggest data-entry
   step.
5. **Live status timeline + SLA countdown for clients** (small) — the
   lifecycle states, `delivery_days`, and notifications already exist; render
   them as a tracking page. Converts opaque waiting into perceived speed.
6. **Partner white-label + outbound webhooks** (medium) — branding fields and
   API tokens exist; add report-logo/custom-domain theming and event webhooks
   to make N409 embeddable by accounting firms — a channel 409.ai underserves.
7. **Data-room Q&A** (medium) — chat over the uploaded document corpus
   (already extracted and anonymized) for ops and clients.
8. **Public instant-quote calculator** (small) — price transparency data is
   already in the product; a public widget feeds the onboarding funnel.

---

## 5. Recommended next steps, in order

1. **Flip on production integrations** — set Stripe, SMTP, Google OIDC vars in
   `/opt/N409/.env`, register the Stripe webhook, restart units (§2.3). Turns
   three finished features live.
2. **Deploy an inbound mail relay** + build the unassigned-email triage queue
   (gap 2–3) — completes the email loop.
3. **Ship the audit-defense bundle and auto-pipeline on upload** (§4.4 #1, #3)
   — highest differentiation per unit of work.
4. **Small-parity sweep** — read/unread markers + Unread scope, requester
   search, worklist badges, deeper clone (gaps 4, 5, 7, 10).
5. **Admin nav grouping + code-splitting** (§3.3) — instead of a separate
   admin site.
6. **When revenue justifies it** — premium AI provider adapter, object
   storage, template body merging, richer report editor.
