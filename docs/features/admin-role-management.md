# Feature: Admin Role Promotion & View Toggle

> **Status:** Draft — pending review before implementation
> **Date:** 2026-07-10
> **Author:** Suman
> **Scope:** Two related admin-experience features: (1) streamlined role promotion
> to admin, and (2) a view-mode toggle that lets admins preview the platform as a
> normal user.

---

## 1. Overview & motivation

Admin users on N409 need two capabilities that the current platform lacks:

**Promote users to admin.** The admin console (`/admin/users`) already supports
editing a user's roles through the full role-checkbox editor. However, there is
no dedicated, streamlined "promote to admin" action. For a common operation —
granting admin access to a trusted team member — the current flow forces the
admin to open the edit drawer, understand the 17-role taxonomy, and manually
toggle the correct checkboxes. A one-click promotion action reduces friction and
the risk of misconfiguration.

**Admin / normal-user view toggle.** Admins see an expanded UI: the Operations
nav group (12 items), the Administration nav group, ops-specific valuation
fields, working data tabs, and report editing. There is no way for an admin to
verify what a client or partner user actually sees. This makes it difficult to
troubleshoot user-reported issues, test onboarding flows, or validate that
sensitive controls are properly hidden. A view toggle solves this by letting
admins temporarily suppress their elevated privileges in the UI without signing
out and back in with a test account.

---

## 2. Current state

### 2.1 Role model

Roles live in a `roles` table (17 seeded keys) joined to users via `user_roles`
(many-to-many). The three groups relevant here:

| Group | Roles | Capabilities |
|---|---|---|
| `USER_ADMIN_ROLES` | `admin`, `god`, `supervisor` | Manage users, roles, partners |
| `OPS_ROLES` | 12 roles (includes all of the above plus `support`, `reviewer`, `data`, etc.) | See/edit all valuations, working data, reports |
| `CLIENT_ROLES` | `valuation_user`, `investor` | Own valuations only |

Defined in `src/services/valuation/src/domain/roles.ts`; mirrored on the
frontend in `src/services/web-frontend/src/lib/rbac.ts`.

### 2.2 Backend role editing

`PATCH /api/v1/users/:id` already accepts a `roles` array and replaces the
user's entire role set. Guards:

- Caller must have a `USER_ADMIN_ROLES` role (enforced by `requireUserAdmin`).
- An admin cannot strip their own admin access (self-lockout prevention at line
  358 of `routes/adminUsers.ts`).
- Partner/member roles require a non-null `partner_id`.
- Every mutation is audit-logged via `recordAdminEvent`.

### 2.3 Frontend role editing

`AdminUsersPage.tsx` renders a checkbox grid of all 17 roles inside an edit
drawer. The admin manually toggles roles and saves. There is no "promote"
shortcut and no concept of a view mode.

### 2.4 UI gating

The sidebar (`AppLayout.tsx`) uses `isOps(user)` and `canManageUsers(user)` to
show/hide nav sections. Route guards in `App.tsx` use `<RequireRole>` with the
same predicates. The RBAC layer is purely cosmetic on the frontend — the API
re-reads roles from the database on every request and enforces the real policy
server-side.

### 2.5 Auth middleware

`plugins/auth.ts` re-fetches the user's roles and `partner_id` from the
database on every authenticated request. Role changes take effect immediately —
no token re-issue is needed.

---

## 3. Proposed changes

### 3.1 Feature A — Promote to admin

#### Backend

**New endpoint:** `POST /api/v1/users/:id/promote`

This is a convenience wrapper around the existing `PATCH /api/v1/users/:id`
role-update logic. It adds the `admin` role to the target user's current role
set without disturbing their other roles.

```
POST /api/v1/users/:id/promote
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "role": "admin"          // only "admin" accepted for now; extensible later
}
```

**Response:** `200 OK` with the updated user object (same shape as
`PATCH /users/:id`).

**Validation:**

- Caller must have a `USER_ADMIN_ROLES` role.
- Target user must exist and not be soft-deleted.
- Target must not already hold the requested role (return `409 Conflict` with a
  clear message).
- Audit-logged as `user_promoted` with `{ role, promoted_by }`.

**Why a new endpoint instead of reusing PATCH?** The PATCH endpoint replaces the
entire role set, which means the caller must know the user's current roles to
avoid accidentally dropping them. A dedicated promote endpoint is additive-only
and safe to call without reading the current state first. This also gives us a
distinct audit event type (`user_promoted` vs. generic `user_updated`).

**Corresponding demote endpoint:** `POST /api/v1/users/:id/demote`

Same shape, removes the specified role. Same guards, plus: an admin cannot
demote themselves (mirrors the existing self-lockout prevention). Audit event:
`user_demoted`.

#### Frontend

Add a **"Promote to admin"** button to the user row actions in
`AdminUsersPage.tsx`. Visibility rules:

- Only shown for users who do **not** already have the `admin` role.
- Only shown to the current user if they have a `USER_ADMIN_ROLES` role.
- Clicking opens a confirmation dialog: *"Promote {name} to admin? They will
  gain access to user management, partner management, and all operations
  tools."*
- On confirm, calls `POST /users/:id/promote` and refreshes the user list.
- If the user already has the role (race condition), show the 409 error
  gracefully.

Add a corresponding **"Remove admin"** action (calls `/demote`) for users who
currently hold the `admin` role, with its own confirmation dialog. This action
is hidden when viewing your own row (self-lockout prevention).

### 3.2 Feature B — Admin / normal-user view toggle

This feature is **entirely client-side**. The API continues to enforce real
RBAC; the toggle only changes what the frontend renders.

#### State management

Add a `viewMode` field to the `AuthContext` (`lib/auth.tsx`):

```typescript
type ViewMode = 'admin' | 'normal';

interface AuthContextValue {
  user: User | null;
  viewMode: ViewMode;          // new
  setViewMode: (m: ViewMode) => void;  // new
  login: (...) => Promise<void>;
  logout: () => void;
}
```

Default: `'admin'`. Stored in React state only (not persisted to
localStorage or the server) — refreshing the page resets to admin view. This
is intentional: the toggle is a temporary preview, not a persistent setting.

#### RBAC predicate wrappers

Create an `effectiveUser` helper that returns a modified user object when
`viewMode === 'normal'`:

```typescript
// lib/rbac.ts
export function effectiveRoles(user: User, viewMode: ViewMode): string[] {
  if (viewMode === 'normal') {
    // Strip all ops and admin roles, keep only client-level roles.
    // If the user has no client roles, default to ['valuation_user'].
    const clientRoles = user.roles.filter(r => CLIENT_ROLES.has(r));
    return clientRoles.length > 0 ? clientRoles : ['valuation_user'];
  }
  return user.roles;
}
```

All existing calls to `isOps(user)`, `canManageUsers(user)`, and
`isPartner(user)` in the UI should use the effective user (with filtered roles)
rather than the raw user. This naturally hides the Operations and Administration
nav sections, ops-only valuation fields, working data tabs, and report editing
controls.

**Critical exception:** The toggle button itself must always use the **real**
user object, not the effective one. Otherwise, switching to normal view would
hide the toggle and strand the admin.

#### UI for the toggle

Place a **toggle pill** in the sidebar, between the user card and the nav
sections. It is only rendered when the real user has an ops/admin role.

```
┌─────────────────────────┐
│  👁  Admin view  ↔  ●○  │    (toggle switch)
└─────────────────────────┘
```

Design:

- **Position:** Top of sidebar, below the wordmark, above the "Workspace" nav
  label. Sticky — always visible without scrolling.
- **Appearance:** A compact pill with an eye icon, the current mode label
  ("Admin view" / "User view"), and a toggle switch.
- **Colour coding:** Admin view uses the default sidebar colours. User view
  adds a subtle accent border (e.g., `brass-400`) and changes the label to
  "User view" so the admin always knows which mode they are in.
- **Mobile:** Same pill appears at the top of the mobile drawer.

#### Behavioural details

- **Navigation:** Switching to normal view while on an admin-only route (e.g.,
  `/admin/users`) should redirect to `/dashboard` via React Router's
  `useNavigate`.
- **API calls:** The toggle does NOT affect API calls. If the admin navigates
  directly to an admin URL while in normal-view mode (e.g., via browser address
  bar), the API will still respond — but the `<RequireRole>` guard will render
  `<AccessDenied>` because it uses the effective user.
- **Notifications:** Notification polling continues using the real user; unread
  counts remain accurate.
- **Session scope:** The toggle resets on page refresh and on logout. It is
  per-tab (React state), so opening a second tab gives a fresh admin view.

---

## 4. Database changes

**None required.** Both features use the existing `roles`, `user_roles`, and
`users` tables. The promote/demote endpoints insert into or delete from
`user_roles`, which already has the correct schema. The view toggle is
client-side only.

The audit log (`admin_events` table) already supports arbitrary event types, so
`user_promoted` and `user_demoted` need no schema change.

---

## 5. API endpoints

### New endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/users/:id/promote` | `USER_ADMIN_ROLES` | Add a role to the user (additive) |
| `POST` | `/api/v1/users/:id/demote` | `USER_ADMIN_ROLES` | Remove a role from the user (subtractive) |

### Request / response

**Promote:**

```
POST /api/v1/users/01HXYZ.../promote
{ "role": "admin" }

→ 200 { "user": { ...updated user... } }
→ 404  user not found / soft-deleted
→ 409  user already has this role
→ 403  caller lacks USER_ADMIN_ROLES
→ 422  invalid role key
```

**Demote:**

```
POST /api/v1/users/01HXYZ.../demote
{ "role": "admin" }

→ 200 { "user": { ...updated user... } }
→ 404  user not found / soft-deleted
→ 409  user does not have this role
→ 403  caller lacks USER_ADMIN_ROLES
→ 422  cannot demote yourself / invalid role key
```

### Existing endpoints (no changes)

`PATCH /api/v1/users/:id` continues to work as before for full role-set
replacement. The promote/demote endpoints are complementary, not replacements.

---

## 6. UI/UX details

### 6.1 Promote action in user list

**Location:** Row actions dropdown in `AdminUsersPage.tsx`, alongside existing
actions (Edit, Deactivate, Send password reset, Revoke sessions).

**Label:** "Promote to admin" (or "Remove admin role" for demotion).

**Confirmation dialog:**

> **Promote to admin**
>
> This will give **{first_name} {last_name}** ({email}) full admin access,
> including:
> - User and partner management
> - All operations tools and valuations
> - System settings (read/write)
>
> **[Cancel]** **[Promote]**

The demotion dialog follows the same pattern with appropriate warnings about
access loss.

### 6.2 View-mode toggle

**Mockup (sidebar, desktop):**

```
┌─ Sidebar ──────────────────┐
│  N409 (wordmark)           │
│                            │
│  ┌──────────────────────┐  │
│  │ 👁 Admin view    [●○] │  │   ← only visible to ops/admin users
│  └──────────────────────┘  │
│                            │
│  WORKSPACE                 │
│  Dashboard                 │
│  Valuations                │
│  ...                       │
│                            │
│  OPERATIONS      ← hidden  │   ← hidden when toggle is set to "User view"
│  ...             ← hidden  │
│                            │
│  ADMINISTRATION  ← hidden  │   ← hidden when toggle is set to "User view"
│  ...             ← hidden  │
│                            │
│  ACCOUNT                   │
│  Billing                   │
│  Settings                  │
└────────────────────────────┘
```

**Toggle states:**

| State | Label | Sidebar sections visible | Route guards |
|---|---|---|---|
| Admin view (default) | "Admin view" | All (Workspace + Operations + Administration + Account) | Use real roles |
| User view | "User view" | Workspace + Account only | Use filtered roles (client-only) |

---

## 7. Security considerations

### 7.1 Promote/demote endpoints

- **Authorization is server-side.** The `requireUserAdmin` guard runs before any
  logic. Non-admin callers get `403`.
- **Self-demotion prevention.** The demote endpoint rejects requests where
  `target_id === caller_id` for admin-tier roles, mirroring the existing PATCH
  guard. This prevents accidental lockout.
- **Audit trail.** Every promote/demote action is logged with the acting admin's
  ID, the target user, the role changed, and a timestamp. The existing
  `admin_events` table and `ActivityLogPage` surface this.
- **Race conditions.** Promoting a user who already has the role returns `409`
  rather than silently succeeding. This makes the action idempotent-safe — a
  double-click won't produce confusing behaviour.
- **Role escalation.** The endpoint only allows promoting to roles that the
  caller themselves could assign via the existing PATCH endpoint. No new
  privilege escalation path is introduced.

### 7.2 View toggle

- **Client-side only.** The toggle never sends a different role set to the API.
  The server always sees the admin's real JWT and real roles. An admin in "user
  view" who somehow reaches an admin API endpoint will still be authorized.
- **No security boundary.** This is a UX convenience, not a security feature.
  It does not sandbox the admin or restrict their actual capabilities.
- **No persistence.** The toggle state lives in React component state. It
  resets on refresh, logout, and tab close. It is never written to localStorage,
  cookies, or the server. This prevents stale view modes.
- **Toggle visibility.** The toggle button itself uses the real (unfiltered)
  user roles, so it remains visible and functional even in "user view" mode.

---

## 8. Test plan

### 8.1 Backend — promote/demote

| # | Case | Method | Expected |
|---|---|---|---|
| 1 | Admin promotes a `valuation_user` to `admin` | POST promote | 200, user now has both roles |
| 2 | Promote a user who already has `admin` | POST promote | 409 Conflict |
| 3 | Non-admin caller attempts promote | POST promote | 403 Forbidden |
| 4 | Promote a soft-deleted user | POST promote | 404 Not Found |
| 5 | Promote with invalid role key | POST promote | 422 |
| 6 | Admin demotes another admin | POST demote | 200, `admin` role removed |
| 7 | Admin attempts self-demotion | POST demote | 422, rejected |
| 8 | Demote a user who lacks the role | POST demote | 409 Conflict |
| 9 | Audit log records `user_promoted` | POST promote | Event in `admin_events` |
| 10 | Audit log records `user_demoted` | POST demote | Event in `admin_events` |
| 11 | Promoted user can immediately access admin routes | GET /users | 200 (auth middleware re-reads roles) |

### 8.2 Frontend — promote action

| # | Case | Expected |
|---|---|---|
| 12 | "Promote to admin" visible for non-admin users | Button shown |
| 13 | "Promote to admin" hidden for users already admin | Button hidden |
| 14 | Confirmation dialog shows user details | Name, email, access summary |
| 15 | Cancel does not call API | No network request |
| 16 | Confirm calls promote endpoint, refreshes list | User shows `admin` role |
| 17 | "Remove admin" hidden on own row | Self-demotion prevented in UI |

### 8.3 Frontend — view toggle

| # | Case | Expected |
|---|---|---|
| 18 | Toggle visible to ops/admin users | Pill rendered in sidebar |
| 19 | Toggle hidden for `valuation_user` | No pill rendered |
| 20 | Switching to "User view" hides Operations nav | Nav section gone |
| 21 | Switching to "User view" hides Administration nav | Nav section gone |
| 22 | Toggle button remains visible in "User view" | Can switch back |
| 23 | Switching while on `/admin/users` redirects to `/dashboard` | No stranded route |
| 24 | Refreshing page resets to "Admin view" | State not persisted |
| 25 | API calls still succeed in "User view" | Server uses real roles |
| 26 | Valuation list shows only client-visible fields in "User view" | Ops fields hidden |
| 27 | Report tab visibility follows `REPORT_VISIBLE_STATES` in "User view" | Matches client experience |
| 28 | Toggle works on mobile drawer | Pill renders, state shared |

### 8.4 Integration

| # | Case | Expected |
|---|---|---|
| 29 | Full flow: promote user → they sign in → see admin UI | End-to-end |
| 30 | Full flow: demote user → they refresh → see client UI | End-to-end |
| 31 | Admin toggles to "User view", opens new tab → new tab is "Admin view" | State is per-tab |

---

## 9. Implementation notes

**Estimated complexity:** Small (S). Both features build directly on existing
infrastructure — the role system, the RBAC predicates, the admin routes, and
the audit log are all in place.

**Suggested file changes:**

| File | Change |
|---|---|
| `src/services/valuation/src/routes/adminUsers.ts` | Add `POST /promote` and `POST /demote` handlers |
| `src/services/web-frontend/src/lib/auth.tsx` | Add `viewMode` / `setViewMode` to `AuthContext` |
| `src/services/web-frontend/src/lib/rbac.ts` | Add `effectiveRoles()` helper |
| `src/services/web-frontend/src/components/AppLayout.tsx` | Wire toggle pill, use effective user for nav gating |
| `src/services/web-frontend/src/components/RequireRole.tsx` | Use effective user |
| `src/services/web-frontend/src/components/ViewModeToggle.tsx` | New component for the toggle pill |
| `src/services/web-frontend/src/pages/AdminUsersPage.tsx` | Add promote/demote row actions |
| `src/services/web-frontend/src/App.tsx` | Pass effective user to route guards |

**No migration needed.** No new tables, columns, or seed data.
