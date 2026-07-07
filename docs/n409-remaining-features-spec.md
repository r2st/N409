# N409 — Remaining Features Specification

> **Status:** Draft for review — nothing in this document is implemented yet unless
> explicitly marked as existing.
> **Date:** 2026-07-07
> **Scope:** the remaining functional gaps between N409 (`main`) and the original
> 409.ai platform, organized P0 → P2. Successor to
> [`remaining-gaps.md`](./remaining-gaps.md) and
> [`feature-gap-analysis.md`](./feature-gap-analysis.md).

## How to read this document

Each feature section has five parts: **what 409.ai does**, **what N409 has today**
(with file references into the current `main`), **what needs to be built**,
**acceptance criteria**, and an **S/M/L complexity estimate**.

**Important calibration note.** The ~55–60% parity figure and parts of the gap
list below come from an analysis snapshot that predates the two most recent
feature waves on `main`:

- `cc9c37a` — bot prompts admin, company profiles, package explorer, help widget
- `fa617e5` — Stripe payments, SMTP delivery, onboarding funnel, signature gating

As a result, several items originally reported as "missing" are now partially or
substantially built. This spec verifies each claim against the code as of
`fa617e5` and scopes only the *true remaining delta*. Where an item is already
essentially done, the section says so and lists the small residual work rather
than re-speccing what exists. Reviewers should treat the "What N409 has today"
sections as the authoritative current state.

### Summary table

| # | Feature | Priority | Current state | Remaining complexity |
|---|---|---|---|---|
| 1 | Admin sidebar navigation | P0 | **Mostly built** — role-gated sidebar exists | S |
| 2 | Payment integration UI | P0 | **Partially built** — one-time checkout wired; no history/receipts/billing portal | M |
| 3 | Password reset flow | P0 | **Missing entirely** | M |
| 4 | Dashboard pivot table | P0 | **Built** — pivot table + donuts + date range live | S |
| 5 | Role-based routing | P1 | Partial — nav gated, routes not guarded | S |
| 6 | Review task workflow UI | P1 | Partial — queue + tasks exist; no approve/reject verbs, no queue-side editing | M |
| 7 | Partner portal management | P1 | Partial — partner list/create only; no admin partner pages | M |
| 8 | AI prompt registry admin | P1 | **Mostly built** — view/edit/test exist; versioning missing | M |
| 9 | User management & invitation | P1 | Partial — admin console exists; no email invitations | M |
| 10 | Help/knowledge base | P2 | Partial — help widget with hard-coded topics | M |
| 11 | Notification preferences | P2 | Missing (notifications themselves exist) | S |
| 12 | Activity audit log viewer | P2 | Partial — per-valuation timeline only; no global viewer | M |
| 13 | Billing/subscription UI | P2 | Missing (payments data exists per valuation) | M |

Roles referenced throughout (defined in
`src/services/valuation/src/domain/roles.ts`, seeded by
`migrations/0002_seed_roles.sql`):

- **Ops roles** (`OPS_ROLES`): `admin`, `god`, `supervisor`, `support`,
  `support_supervisor`, `reviewer`, `main_reviewer`, `contributing_reviewer`,
  `data`, `data_supervisor`, `auto`, `spa` — see/manage all valuations.
- **User-admin roles** (`USER_ADMIN_ROLES`): `admin`, `god`, `supervisor`.
- **Partner roles**: `partner` (org admin), `member` — scoped to `partner_id`.
- **Client roles**: `valuation_user`, `investor` — scoped to owned valuations.

The frontend mirrors these groupings in
`src/services/web-frontend/src/lib/rbac.ts` (`isOps`, `isPartner`,
`canManageUsers`); the API enforces the real policy in
`src/services/valuation/src/auth/rbac.ts`.

---

## P0 — Critical

### 1. Admin sidebar navigation

**What 409.ai does.** Admin/ops users get a distinct navigation surface: Reviews,
Users, Prompts, Partner Valuations, and support tooling are reachable from the
sidebar; clients never see those entries.

**What N409 has today — this is mostly built.** The sidebar in
`src/services/web-frontend/src/components/AppLayout.tsx` is already role-gated
into four sections:

- *Workspace* (everyone): Dashboard, Valuations, New valuation, Search,
  Notifications (with unread badge).
- *Partner portal* (`isPartner` only): `/partner`.
- *Operations* (`isOps` only): **Review tasks** (`/tasks`), Report templates
  (`/templates`), **Bot prompts** (`/admin/prompts`), Support inbox
  (`/admin/support`), Overwrites schema (`/schema/overwrites`).
- *Administration* (`canManageUsers` only): **Users & roles** (`/admin/users`).

So three of the four pages named in the gap analysis (Reviews, Users, Prompts)
are already surfaced. The remaining deltas:

1. **No "Partner valuations" / partner management surface for admins.** The
   backend has `GET/POST /api/v1/partners` (`routes/adminUsers.ts:197,203`) and
   the worklist API supports a `partner` filter, but there is no admin page
   listing partner organizations or drilling into a partner's portfolio.
   (Full page spec is feature 7; this item covers only the nav entry.)
2. **Email outbox has an API but no UI.** `GET /api/v1/admin/email-outbox`
   (`routes/notifications.ts:62`) returns delivery status/attempts for the
   transactional outbox; nothing in the SPA renders it.
3. **No route-level guarding** behind the nav gating — covered by feature 5.

**What needs to be built.**

- Frontend: add a **Partners** nav item to the *Administration* section
  (target `/admin/partners`, page from feature 7) and an **Email outbox** item
  to *Operations* (target `/admin/outbox`).
- Frontend: `EmailOutboxPage` — table of outbox rows (recipient, template,
  status, attempts, last error, timestamps), status filter, manual "retry"
  action if we add one (optional; the outbox worker already retries).
- Backend: none for nav; optional `POST /api/v1/admin/email-outbox/:id/retry`
  if the retry action is wanted.

**Acceptance criteria.**

- An `admin` user sees Partners and Email outbox entries; a `valuation_user`
  and a `partner` user see neither.
- Email outbox page lists queued/sent/failed emails with attempt counts and
  errors; filterable by status.
- Nav additions render correctly in both the desktop sidebar and the mobile
  drawer (both render the same `nav` element in `AppLayout`).

**Complexity: S** (the sidebar mechanics, role helpers, and backend endpoints
already exist).

---

### 2. Payment integration UI

**What 409.ai does.** Clients pay for a valuation online; ops see payment status
on the engagement; the paid flag gates work start. The business also runs
pricing per product and (per the gap analysis request) plan/checkout/billing
portal surfaces.

**What N409 has today.** The Stripe backend from `fa617e5` is complete *for
one-time, per-valuation checkout*, and — contrary to the gap-analysis claim —
it **is already wired into the frontend at two entry points**:

- Backend (`src/services/valuation/src/routes/payments.ts`,
  `src/services/valuation/src/payments/stripe.ts`,
  `migrations/0041_payments_signatures_pipeline.sql`):
  - `POST /api/v1/valuations/:id/payments/checkout` — creates a Stripe-hosted
    Checkout Session (form-encoded REST, no SDK), persists a pending `payments`
    row keyed by session id. List prices per kind
    (`DEFAULT_PRICE_CENTS`: 409A $1,190, FMV $990, ASC 718/820 $1,490, fallback
    $990); ops may override `amount_cents`, clients always pay list.
  - `POST /api/v1/stripe/webhook` — signature-verified
    (`verifyWebhookSignature`, constant-time HMAC, 300s tolerance);
    `checkout.session.completed` marks the payment `succeeded` and flips the
    valuation's `paid_status`/`amount_cents`/`paid_at` idempotently. Webhook is
    the source of truth, never the browser redirect.
  - `GET /api/v1/valuations/:id/payments` — payment history rows (no UI yet).
  - Config: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`
    (`config.ts`). Unconfigured → 503 with a problem type the UI translates
    into "we will invoice you instead".
- Frontend:
  - `components/PaymentSection.tsx` — "Pay now" panel on unpaid valuations,
    rendered on `ValuationDetailPage.tsx:129`; redirects to the Stripe-hosted
    page.
  - `pages/OnboardingPage.tsx` — the funnel has an explicit **Payment step**
    (step 2 of "Your company → Payment → Documents → All set") with a "Pay now
    with card" button and an invoice-fallback path.

**What's actually missing:**

1. **Price transparency before checkout.** Neither the onboarding step nor
   `PaymentSection` shows the amount; the client first sees the price on the
   Stripe page.
2. **Post-redirect feedback.** Checkout redirects back to
   `/valuations/:id?payment=success|cancelled`, but `ValuationDetailPage`
   ignores the query param — no success/cancelled banner, and since the webhook
   is async the badge may still say "unpaid" on landing.
3. **Payment history UI.** `GET …/payments` has no consumer; ops can't see
   attempts, session state, or amounts in the UI.
4. **Receipts.** The webhook doesn't capture Stripe's `receipt_url` /
   charge reference, so there is nothing to link the client to.
5. **Ops controls.** The ops-only `amount_cents` override exists in the API but
   has no UI (e.g. discounting a checkout).
6. **Subscriptions / billing portal.** Nothing exists — no Stripe customer
   objects, no plans, no `billing_portal/sessions` endpoint. The current
   product model is strictly one-time per-valuation payment.

**What needs to be built.**

*Phase A — finish the one-time flow (this is the parity-relevant part):*

- Frontend:
  - Show the list price (from a new lightweight
    `GET /api/v1/valuations/:id/payments/quote` or by shipping
    `DEFAULT_PRICE_CENTS` through the valuation payload) in `PaymentSection`
    and the onboarding payment step.
  - Handle `?payment=success|cancelled` on `ValuationDetailPage`: banner +
    short poll of the valuation until `paid_status` flips (webhook lag), then
    clean the query string.
  - Payments history table (ops-visible; client sees own) on the detail page:
    date, amount, status (`pending/succeeded/failed/expired`), receipt link.
  - Ops-only amount override input on the checkout action.
- Backend:
  - Store `receipt_url` (and charge id) from the webhook payload on the
    `payments` row; add columns via migration.
  - Optional `quote` endpoint returning `{amount_cents, currency}` for a
    valuation.

*Phase B — subscriptions & billing portal (only if the business model needs
it; recommend deferring to feature 13 / P2):*

- Data model: `stripe_customer_id` on `users` (or `partners`), a `plans` seed,
  `subscriptions` table.
- Endpoints: create-subscription checkout (mode `subscription`),
  `POST /api/v1/billing/portal` returning a Stripe billing-portal session URL,
  webhook handling for `customer.subscription.*` and `invoice.*` events.
- Frontend: plan picker, "Manage billing" button (portal redirect).

**Acceptance criteria (Phase A).**

- A client sees the exact amount before clicking "Pay now" in both entry
  points.
- After a completed Stripe checkout, the client lands on the valuation with a
  success banner and the paid badge updates without a manual refresh.
- A cancelled checkout shows a non-error "payment cancelled" notice and the
  Pay now button remains.
- Ops see the payments history (including expired/failed sessions) on any
  valuation; clients see their own payments and can open the Stripe receipt.
- With `STRIPE_SECRET_KEY` unset, both entry points degrade to the existing
  invoice-fallback messaging (no regression).
- Webhook replay does not double-mark payments (existing idempotency
  preserved — regression test).

**Complexity: M** (Phase A; Phase B alone would be L).

---

### 3. Password reset flow

**What 409.ai does.** Standard credentials recovery: "Forgot password?" on the
login page → email with a time-limited link → reset page → sign in with the new
password. Logged-in users can also change their password.

**What N409 has today — nothing.** Verified against
`src/services/valuation/src/routes/auth.ts`: the auth surface is exactly
`register`, `login`, `providers`, `google`, `google/callback`, `me`. There is no
reset/forgot endpoint, no token table in any migration, no "Forgot password?"
link on `LoginPage.tsx`, and no change-password form on `SettingsPage.tsx`
(it only displays whether the account is "Email & password" or "Google SSO").

The delivery rail it needs **does** exist: the transactional email outbox with
a real SMTP transport (`EMAIL_MODE=smtp`, `src/services/valuation/src/email/smtp.ts`,
outbox tables in `0030_m4_polish.sql`) landed in `fa617e5`.

**What needs to be built.**

- Data model (new migration):

  ```sql
  CREATE TABLE password_reset_tokens (
    id          ulid PRIMARY KEY,
    user_id     ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_sha256 text NOT NULL UNIQUE,   -- raw token only ever lives in the email link
    expires_at  timestamptz NOT NULL,    -- now() + 1 hour
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  ```

- Backend (`routes/auth.ts`):
  - `POST /api/v1/auth/forgot-password` `{email}` — always answers `202`
    regardless of whether the account exists (mirror the existing
    no-enumeration stance in `login`). For real password accounts
    (`password_digest` set, not deleted, not SSO-only): invalidate outstanding
    tokens, mint a 32-byte random token, store its sha256, enqueue a reset
    email through the existing outbox with link
    `{PUBLIC_BASE_URL}/reset-password#token=…`. Rate-limit per email/IP
    (e.g. 3/hour).
  - `POST /api/v1/auth/reset-password` `{token, password}` — validate sha256
    match, unexpired, unused; enforce the existing 10-char minimum; set the new
    digest, stamp `used_at`, and (recommended) treat this as a session-
    invalidation event.
  - `POST /api/v1/auth/change-password` `{current_password, new_password}` —
    authenticated; verify current, set new. Rejected for SSO-only accounts.
  - New email template alongside the existing workflow templates in
    `domain/emailWorkflows.ts`.
- Frontend:
  - `ForgotPasswordPage` (`/forgot-password`): email form → always "If an
    account exists, we've sent a link."
  - `ResetPasswordPage` (`/reset-password`): reads the token from the URL
    fragment (fragments don't hit server logs — same trick as
    `GoogleCompletePage`), new-password + confirm fields, then redirect to
    login.
  - "Forgot password?" link on `LoginPage`.
  - "Change password" card on `SettingsPage` (hidden for Google-SSO accounts).

**Acceptance criteria.**

- Requesting a reset for an existing or non-existent email returns an
  identical response (no account enumeration).
- The emailed link sets a new password exactly once; reused, expired (>1h), or
  tampered tokens fail with a clear error and a path back to
  `/forgot-password`.
- Requesting a new token invalidates prior outstanding tokens.
- SSO-only accounts (`sso_provider='google'`, no digest) never receive reset
  emails; the settings page hides change-password for them.
- With `EMAIL_MODE=log`, the flow is testable end-to-end from the logged
  message (dev ergonomics).
- Password minimum length (10) enforced everywhere it can be set.

**Complexity: M**.

---

### 4. Dashboard pivot table

**What 409.ai does.** The ops dashboard centers on a product-breakdown pivot —
valuations by product (rows) × pipeline stage (columns) with totals — plus pie
charts and a date-range filter, so the team sees WIP by product at a glance.

**What N409 has today — this is built.** Contrary to the gap-analysis claim,
`DashboardPage.tsx` already renders, for any date range:

- A **Product pivot table** (`aria-label="Product pivot"`,
  `DashboardPage.tsx:121–161`): one row per product kind (`KindBadge`),
  columns Open / In review / Drafted / Published / Closed
  (`PIVOT_GROUPS`), per-row totals and a per-column totals footer.
- Two donut charts (by product, by source) from the same
  `GET /api/v1/stats/dashboard` response (`routes/operations.ts:43`), which
  computes the pivot server-side over `ValuationFilterQuery`.
- A from/to date-range picker driving the whole analytics block, plus stat
  cards and a waiting-on-client callout.

**What's actually missing** (small, quality-of-life deltas):

1. **Drill-through** — pivot cells are static numbers; 409.ai lets you click
   into the underlying list. The worklist (`/valuations`) already supports
   `kind`, state-group, and date filters via query params, so cells can link.
2. The pivot renders for **all** users; clients see a pivot of their own 1–2
   valuations, which is noise. It should be ops-only (or partner-scoped for
   partners).
3. Optional extras if ops want them: paid/unpaid column, per-reviewer workload
   table (the `by_state` breakdown already comes back in the payload and is
   unused).

**What needs to be built.**

- Wrap each non-zero pivot cell in a `Link` to
  `/valuations?kind=…&group=…&created_from=…&created_to=…` (confirm the
  worklist reads a `group` param; add it if it currently only takes `state`).
- Gate the analytics block on `isOps(user)` (partners: keep, since their data
  is already server-scoped; clients: hide).
- Optional: render the unused `by_state` breakdown as a second table.

**Acceptance criteria.**

- Clicking a pivot cell opens the worklist pre-filtered to exactly the cell's
  cohort, and the row count matches the cell value.
- Client users no longer see the analytics section; ops and partners do.
- Date-range changes keep drill-through links consistent with the table.

**Complexity: S**.

---

## P1 — Important

### 5. Role-based routing

**What 409.ai does.** Admins, partners, and clients effectively get different
apps: different navigation, different landing pages, and no ability to load
screens outside their role.

**What N409 has today.** Three of the four layers already exist:

- **Server-side enforcement** (the layer that matters for security) is done:
  every route checks the principal's scope (`auth/rbac.ts`; ops-only routes
  throw 403, out-of-scope reads 404).
- **Sidebar gating** by `isOps` / `isPartner` / `canManageUsers` (feature 1).
- **Scoped data** — the same `/valuations` list is server-filtered per role,
  and ops-only workspace tabs are hidden for clients.
- One ad-hoc client guard: `PartnerPortalPage` redirects non-partners to
  `/dashboard`.

**The gap:** routing itself is role-blind. `App.tsx` registers every page for
every authenticated user, so a client who navigates to `/admin/users`,
`/tasks`, or `/admin/prompts` gets the page shell plus raw 403 errors from the
API — ugly, and it leaks the existence of admin surfaces. There's also no
role-aware landing (everyone lands on `/dashboard`).

**What needs to be built.**

- Frontend only (no API changes):
  - A `RequireRole` wrapper component beside `RequireAuth`
    (`components/RequireAuth.tsx`): takes a predicate
    (`isOps` / `canManageUsers` / `isPartner`) and renders a `Navigate` to
    `/dashboard` (or a small "no access" screen) when it fails.
  - Wrap the route groups in `App.tsx`:
    - ops: `/tasks`, `/templates`, `/admin/prompts`, `/admin/support`,
      `/schema/overwrites`, `/valuations/:id/sensitivity`, plus new
      `/admin/outbox`;
    - user-admin: `/admin/users`, plus new `/admin/partners`;
    - partner: `/partner` (replaces the in-page redirect).
  - Role-aware landing: after login, partners land on `/partner`, everyone
    else on `/dashboard` (keep it simple; ops-specific home is out of scope).
  - Remove the now-redundant guard inside `PartnerPortalPage`.

**Acceptance criteria.**

- A `valuation_user` navigating to any ops/admin URL is redirected without
  seeing the page shell or console 403s.
- An ops user without `USER_ADMIN_ROLES` (e.g. `reviewer`) can open `/tasks`
  but is redirected from `/admin/users`.
- Partner login lands on `/partner`; deep links still work after login.
- Server-side behavior unchanged (this is UX, not security — the API already
  enforces).

**Complexity: S**.

---

### 6. Review task workflow UI

**What 409.ai does.** A review pipeline over thousands of typed tasks: reviewers
get a queue, tasks are assigned with SLAs, and valuations are approved
(advanced) or rejected (sent back) from review with the decision recorded.

**What N409 has today.** The machinery is built; the *verbs* aren't surfaced:

- Backend: typed review tasks — 10 kinds (`data_review`, `cap_table`,
  `financials`, `comparables`, `methodology`, `draft_review`, …
  `domain/pipeline.ts`), statuses `open/in_progress/blocked/done/cancelled`,
  assignee, SLA hours, due dates; global list with `assignee=me`, `status`,
  `overdue` filters (`routes/tasks.ts`, all ops-only). Workflow engine with
  transition-legality checks: `advance`, `restart`, `reassign`, plus bulk
  `set_state`/`advance`/`restart`/`assign_reviewer` (`routes/workflow.ts`).
  Signature gating before publish (`routes/signatures.ts`, migration `0041`:
  a `main` signature is required to enter `published`).
- Frontend: `TasksPage` — the global queue with scope tabs (Assigned to me /
  All / Overdue) and a status filter; `TasksPanel` on the valuation workspace
  for per-valuation task CRUD; `WorkflowActions` (advance/restart/reassign) on
  the detail page; `SignaturePanel` for sign-off.

**The gaps:**

1. **No approve/reject vocabulary.** Reviewers must know that "approve" ==
   `workflow/advance` and "reject" == `workflow/restart` (or a state set) and
   perform them from the detail page. 409.ai presents explicit
   approve/request-changes decisions from the review context, with the
   decision + comment recorded.
2. **The queue is read-only.** From `TasksPage` you can't reassign, change
   status, or complete a task — you must open the valuation and use
   `TasksPanel`.
3. **No review-queue view of valuations** (as opposed to tasks): "everything
   in `in_review`/`second_review` states waiting on me as
   `assigned_reviewer_id`" is only reachable via worklist filters.

**What needs to be built.**

- Backend (thin):
  - `POST /api/v1/valuations/:id/review/decision` `{decision: 'approve' |
    'request_changes', comment?}` — wraps the existing workflow calls
    (approve → advance; request_changes → restart-to-earlier-state), writes an
    ops `note` comment when provided, records a `review_decision` event in
    `valuation_events`. Alternative: keep the API as-is and compose the two
    calls client-side — acceptable, but then the decision isn't atomic with
    the comment and the event log shows only a state change. Recommend the
    endpoint.
- Frontend:
  - **Review queue tab** on `TasksPage` (or a `/reviews` page): valuations in
    review states, filterable "assigned to me", with inline
    Approve / Request changes buttons (comment modal on request-changes) and
    signature-status chips (blocked-from-publish indicator).
  - Inline task actions in the existing queue rows: status dropdown, assignee
    picker (reuse the `users/options` endpoint), complete/cancel.
  - Overdue emphasis already exists via `dueLabel`; add SLA countdown chip.

**Acceptance criteria.**

- A reviewer can, without leaving the queue: pick up a task, reassign it,
  complete it; and approve or send back a valuation in review with a comment.
- Request-changes moves the valuation to the correct earlier state (per the
  workflow legality matrix) and the comment appears in the ops notes thread.
- Both decisions appear in the valuation's event timeline with the acting
  reviewer.
- Publish remains blocked until a `main` signature exists (no regression on
  signature gating).
- All of it stays ops-only (clients/partners get 403/404 as today).

**Complexity: M**.

---

### 7. Partner portal management

**What 409.ai does.** Partners (accounting firms, law firms, platforms) run
hundreds of valuations through a channel. Admins create/manage partner
organizations and their users; partner users see exactly their organization's
valuations.

**What N409 has today.**

- The **partner-side** is done: `PartnerPortalPage` (portfolio stats, recent
  engagements, API token mint/revoke — `routes/apiTokens.ts`), server-side
  scoping of every read to `partner_id`, partner API tokens
  (`n409_pat_…`) usable against the same REST API.
- The **admin-side** is embedded and minimal: `GET/POST /api/v1/partners`
  (list for pickers + create, `routes/adminUsers.ts:197,203`); the admin users
  console assigns users to partners; the worklist supports a `partner`
  filter. There is **no** partner PATCH/archive endpoint, no partner detail
  view, and no page listing partners with their volumes.

**What needs to be built.**

- Backend:
  - `PATCH /api/v1/partners/:id` — rename, edit metadata; `archived_at`
    soft-archive column (migration) so a channel can be closed without
    breaking historical rows. Archived partners: existing users/valuations
    keep working read-only conventions TBD in review — minimum: they no longer
    appear in pickers.
  - `GET /api/v1/partners/:id` — detail with rollups: user count, valuation
    counts by state group, last activity. (Counts derivable from existing
    tables; one aggregate query.)
- Frontend:
  - `/admin/partners` page (nav from feature 1, guard from feature 5): table
    of partners (name, users, active valuations, created), create form
    (relocated from wherever admins currently create partners inline),
    rename/archive actions.
  - Partner detail drawer/page: the rollups, the partner's users (link into
    `/admin/users?partner=…` — add that query-param filter to the users list,
    which the backend `ListQuery` may need to grow), and a "view valuations"
    link to `/valuations?partner=…` (filter already exists).

**Acceptance criteria.**

- Admin can create, rename, and archive a partner; archived partners vanish
  from the user-editor picker and the worklist filter dropdown but historical
  valuations still render their partner name.
- Partner detail shows accurate user/valuation counts that match the filtered
  worklist.
- A `partner`-role user still sees only their own organization (no admin
  endpoints leak — they're behind `USER_ADMIN_ROLES`/ops checks).
- Creating a user with role `partner`/`member` requires selecting a partner
  (today the console allows partner roles with no `partner_id`, which yields a
  user scoped to nothing — validate it).

**Complexity: M**.

---

### 8. AI prompt registry admin

**What 409.ai does.** ~27 DB-backed prompts drive the AI pipelines, each bound
to a model/provider, with admin CRUD and versioning so prompt changes are
auditable and revertible.

**What N409 has today — mostly built** (`cc9c37a`). One editable registry row
per pipeline (`ai_prompts`, migration `0040`, seeded for `missing_data`,
`extract`, `comparables`, plus `summarize` in `0042`): editable `system_prompt`
and `model` pin (NULL = the AI service's default OpenRouter fallback chain);
`updated_by`/`updated_at` stamped. Routes (`routes/prompts.ts`, ops-only):
list, get, patch, model options proxied from the AI service, and a **dry-run
test endpoint** that sends the stored system prompt + sample input to the LLM
without persisting anything. `BotPromptsPage` in the sidebar covers view/edit/
test. The user-message half of each prompt intentionally stays code-defined
(it interpolates the document corpus).

**The gap: versioning.** `PATCH` overwrites in place; there is no history, no
diff, no revert — an admin who breaks the extraction prompt has no way back
except memory. Secondary gaps: only the last editor is recorded (single
`updated_by`), and `ai_jobs` don't record which prompt *version* a run used.

**What needs to be built.**

- Data model (migration):

  ```sql
  CREATE TABLE ai_prompt_versions (
    id            ulid PRIMARY KEY,
    prompt_id     ulid NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
    version       integer NOT NULL,            -- 1..n per prompt
    system_prompt text NOT NULL,
    model         text,
    created_by    ulid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (prompt_id, version)
  );
  ```

  Backfill version 1 from current rows; every successful `PATCH` inserts the
  *new* content as the next version (the live row stays the source of truth
  the AI service reads). Add `prompt_version` to `ai_jobs` provenance.
- Backend: `GET /api/v1/admin/prompts/:id/versions`,
  `POST /api/v1/admin/prompts/:id/revert` `{version}` (which itself creates a
  new version — history is append-only).
- Frontend (`BotPromptsPage`): version history list per prompt (who/when),
  side-by-side or unified diff of `system_prompt` between versions (a simple
  line diff is fine), revert button with confirmation.

**Acceptance criteria.**

- Editing a prompt produces a new numbered version; the full history lists
  editor and timestamp for each.
- Revert restores an old version's content as a *new* version (no history
  rewriting) and the AI service picks it up on the next run.
- New AI jobs record the prompt version they ran with; the jobs view shows it.
- Dry-run test keeps working against the currently-saved content.

**Complexity: M**.

---

### 9. User management & invitation

**What 409.ai does.** Admins invite users by email: the invitee receives a link,
sets their own password, and lands with pre-assigned roles/partner. Admins
manage roles and deactivate accounts.

**What N409 has today.** The admin console covers most of it
(`routes/adminUsers.ts`, `AdminUsersPage`, both from M3): list with search,
create, edit (email/name/phone/verified/partner/roles with all 17 role keys),
soft-delete (deactivation — login already rejects `deleted_at` accounts),
self-lockout protection (can't strip your own admin role or delete yourself),
and CSV export.

**The gap: invitations.** `POST /api/v1/users` requires the *admin* to type a
password for the new user (`CreateBody` mandates `password`, min 10 chars) —
i.e. admins know users' initial credentials and must deliver them out of band.
There is also no "reactivate" for soft-deleted users (the list shows
`deleted_at` but the only actions are edit/delete).

**What needs to be built.**

- Data model (migration): `user_invitations` — id, email (unique among
  pending), roles array, `partner_id`, `invited_by`, `token_sha256` unique,
  `expires_at` (7 days), `accepted_at`, `revoked_at`, timestamps.
- Backend:
  - `POST /api/v1/users/invite` `{email, roles, partner_id?}` (user-admin
    only) — creates the pending invitation, enqueues an invite email (existing
    outbox/SMTP) with `{PUBLIC_BASE_URL}/accept-invite#token=…`. Conflict if
    an active user or pending invite already has the email.
  - `GET /api/v1/users/invitations` + `POST …/invitations/:id/resend` (new
    token, new expiry) + `DELETE …/invitations/:id` (revoke).
  - Public `POST /api/v1/auth/accept-invite` `{token, password, first_name?,
    last_name?}` — validates token (unexpired, unaccepted, unrevoked), creates
    the user with the invitation's roles/partner and `verified=true`, marks
    accepted, returns a session token (same shape as register).
  - `POST /api/v1/users/:id/restore` — clear `deleted_at` (reactivate).
  - Keep direct create-with-password as an escape hatch, or drop it — decide
    in review; recommend keeping it behind the same form ("Create with
    password" secondary action).
- Frontend:
  - `AdminUsersPage`: "Invite user" as the primary action (email + roles +
    partner); a "Pending invitations" section with status/expiry and
    resend/revoke; "Restore" action on deactivated rows.
  - Public `AcceptInvitePage` (`/accept-invite`): shows the email, collects
    name + password, logs the user straight in.

**Acceptance criteria.**

- Inviting an email sends exactly one link; accepting it creates an account
  with the pre-assigned roles/partner and signs the user in; the token is
  single-use and expires after 7 days.
- Revoked/expired invitations can't be accepted; resend invalidates the prior
  link.
- Inviting an existing user's email fails with a clear conflict.
- Deactivated users can't log in (existing behavior) and can be restored from
  the console.
- Works end-to-end with `EMAIL_MODE=log` for dev (link readable from logs).

**Complexity: M** (shares token/email plumbing with feature 3 — build them
together).

---

## P2 — Polish

### 10. Help / knowledge base section

**What 409.ai does.** In-app help: a knowledge base of articles about the
valuation process plus an Intercom-style support entry point.

**What N409 has today.** `cc9c37a` shipped the support half: `HelpWidget`
(floating widget on every authenticated page, `AppLayout.tsx:276`) with
**seven hard-coded help topics** (`HELP_TOPICS` in
`components/HelpWidget.tsx`: getting started, documents, params, calculations,
reports, states, access) with keyword search, plus a contact form persisting to
`support_messages` (migration `0040`) and an ops **Support inbox** page
(`/admin/support`, open/resolved workflow).

**The gap:** the knowledge base is seven frontend constants — no admin CRUD, no
full-page reading experience, no categories, invisible to ops without a
deploy.

**What needs to be built.**

- Data model (migration): `help_articles` — id, slug unique, title, category,
  keywords, `body_html` (sanitized server-side like report content), sort
  order, `published` flag, author, timestamps. Seed from the seven
  existing topics.
- Backend: public (authenticated) `GET /api/v1/help/articles` +
  `GET …/articles/:slug`; ops-only CRUD under `/api/v1/admin/help/articles`.
- Frontend:
  - `/help` section: category-grouped article list, search (server `q` or
    client-side over the fetched list — volume is small), article view.
  - `HelpWidget` reads topics from the API (keep the constants as fallback if
    the fetch fails); "View all articles →" link to `/help`.
  - Admin editor on a new ops page or a tab of the support inbox (reuse
    `RichTextEditor`).

**Acceptance criteria.**

- Ops can create/edit/unpublish articles without a deploy; changes appear in
  the widget and `/help` immediately.
- Unpublished articles are invisible to non-ops.
- Article HTML is sanitized (same policy as report content).
- Existing widget behavior (search, contact form → support inbox) unchanged.

**Complexity: M**.

---

### 11. Notification preferences

**What 409.ai does.** Users choose, per event type, whether they get email
and/or in-app notifications.

**What N409 has today.** Both channels exist and fire unconditionally from the
state-change hooks (`hooks/stateChange.ts`, `domain/emailWorkflows.ts`):
in-app `notifications` (migration `0030`, bell badge, list page, read/read-all)
and transactional emails (outbox + SMTP). There is **no preferences model** —
nothing in any migration, no settings UI.

**What needs to be built.**

- Data model (migration): `notification_preferences`
  (`user_id`, `event_type`, `in_app boolean`, `email boolean`,
  PK `(user_id, event_type)`). Absent row = both channels on (default-on, so
  the table stays sparse). Event types = the existing notification `type`
  values / email workflow triggers (started, review, draft-ready, published,
  cancelled, comment/chat, task-assigned — enumerate from
  `emailWorkflows.ts` during implementation and freeze as a shared const).
- Backend: `GET/PUT /api/v1/me/notification-preferences`; consult preferences
  in the two dispatch points (in-app insert in the state-change hook; email
  enqueue in the workflow layer). Transactional must-sends (password reset,
  invitations from features 3/9) bypass preferences by design.
- Frontend: a "Notifications" card on `SettingsPage` — matrix of event types ×
  (In-app, Email) toggles, saved on change.

**Acceptance criteria.**

- Turning off email for an event type stops outbox rows for that type/user;
  in-app continues (and vice versa); other users unaffected.
- New users get all notifications with zero rows in the table.
- Password reset / invite emails are always delivered regardless of settings.
- The settings card round-trips correctly (defaults shown as on).

**Complexity: S** (bordering M only if the event-type taxonomy needs cleanup).

---

### 12. Activity audit log viewer

**What 409.ai does.** Admins can answer "who did what, when" across the platform
from a filterable activity log.

**What N409 has today.** The recording spine is strong but valuation-scoped:
append-only `valuation_events` on every mutation, immutability enforced by DB
triggers (migration `0001`), rendered per-valuation at
`GET /api/v1/valuations/:id/events` + the timeline in the workspace. What's
missing: (a) a **global, cross-valuation listing** with filters, (b) an admin
UI for it, and (c) events for **non-valuation admin actions** — user/role
changes, partner changes, prompt edits, template changes are not evented at
all today.

**What needs to be built.**

- Backend:
  - `GET /api/v1/admin/events` (ops-only): pages over `valuation_events` with
    filters — `valuation_id`, `actor_id`, `actor_type`
    (human/system), `event_type`, `source`, created from/to; joined actor
    display name and valuation company/number for rendering. Needs an index on
    `(created_at DESC)` and likely `(actor_id, created_at DESC)` (migration).
  - **Admin-action eventing**: add an `admin_events` table (same shape,
    `subject_type`/`subject_id` instead of `valuation_id`) and write rows from
    the admin users, partners, prompts, and templates routes. Fold into the
    same listing endpoint via UNION or a second endpoint — reviewer's choice;
    recommend one endpoint with a `scope=valuations|admin|all` param.
- Frontend: `/admin/activity` page (ops nav): filter bar (actor picker, type,
  date range, free-text valuation), reverse-chronological table (when, actor,
  event, subject with link, payload summary), "load more" pagination.

**Acceptance criteria.**

- Every valuation mutation visible on a valuation's timeline is also findable
  in the global viewer with identical content.
- Role changes, user deactivations, partner edits, and prompt edits appear as
  audit rows naming the acting admin.
- Filters combine (e.g. one actor + date range + event type) and paginate
  stably.
- Ops-only; immutability preserved (no update/delete paths).

**Complexity: M**.

---

### 13. Billing / subscription management UI

**What 409.ai does.** Account-level billing visibility: what was paid, invoices/
receipts, and (in the subscription framing of the gap analysis) plan details
and usage.

**What N409 has today.** Per-valuation payment data only: the `payments` table
and `GET /api/v1/valuations/:id/payments` (feature 2), `paid_status`/
`amount_cents`/`paid_at` on valuations, and a `paid` filter on the worklist.
No account-level view, no receipts (not captured — see feature 2 Phase A), no
plans/subscriptions/invoices anywhere in the schema.

**What needs to be built.** Scope this as the *account-level rollup of the
existing one-time payment model*; full subscriptions remain feature 2 Phase B
and should be a separate business decision.

- Backend:
  - `GET /api/v1/me/billing` — all payments across the caller's accessible
    valuations (client: own; partner: org; ops: optionally a
    `user_id`/`partner_id` param), with valuation number/company, amount,
    status, receipt link; plus totals.
  - Depends on feature 2 Phase A capturing `receipt_url`.
  - Ops revenue summary can reuse `stats/dashboard` patterns later — out of
    scope here.
- Frontend:
  - `/billing` page (all roles, self-scoped): payment history table, totals,
    receipt links, and per-row link to the valuation; "unpaid engagements"
    call-to-action reusing `PaymentSection`'s checkout.
  - Nav entry under *Account* next to Settings.
  - If/when Phase B ships: plan card + "Manage billing" portal button slot
    into this page.

**Acceptance criteria.**

- A client sees every payment they've made with amount, date, status, and a
  working Stripe receipt link; totals match the rows.
- A partner sees org-wide payments; a client of another org sees nothing
  cross-tenant (server-side scoping tests).
- Unpaid valuations surface a working pay-now path from the billing page.
- Page renders sensibly with zero payments (empty state).

**Complexity: M** (S if feature 2 Phase A has landed first).

---

## Cross-cutting notes & suggested build order

**Shared plumbing.** Features 3 and 9 share the token-email pattern (sha256-
stored single-use tokens + outbox emails + fragment-carried tokens in the SPA)
— build them in one pass. Features 1, 5, 7 all touch the same nav/guard/admin-
page seam. Feature 13 depends on feature 2 Phase A (receipts).

**Suggested order** (each step independently shippable):

1. **Feature 3 + 9** — password reset & invitations (the only P0 with zero
   existing coverage, plus its natural twin).
2. **Feature 2 Phase A** — finish the payment UX (price display, redirect
   handling, history, receipts).
3. **Feature 5 + 1** — route guards + the two missing nav pages (outbox,
   partners stub).
4. **Feature 4** — pivot drill-through (small).
5. **Feature 6** — review decisions + queue actions.
6. **Feature 7** — partner admin pages.
7. **Feature 8** — prompt versioning.
8. **P2 in order 11 → 12 → 10 → 13** (preferences is smallest; audit viewer
   has the most ops value).

**Out of scope for this spec** (tracked in `remaining-gaps.md`): engine
fidelity items (RFR sensitivity axes, roll-forward math), report editor depth,
XLSX→DOCX ingestion extensions, object storage, Google Ads round-trip, and the
unassigned-email triage queue.
