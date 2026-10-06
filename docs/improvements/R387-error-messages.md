# R387 — Error Messages (M19)

**Date:** 2026-10-06
**Scope:** Audit vague error messages, missing context, inconsistent formats, unhelpful status codes, internal detail leakage

## Methodology

Full-stack audit of error handling across the N409 codebase, examining:

1. **Vague messages** — catch blocks that discard the server's detail in favour of a hardcoded string
2. **Missing context** — error responses lacking IDs, timestamps, or actionable information
3. **Inconsistent formats** — deviation from the RFC 9457 `application/problem+json` standard
4. **Unhelpful HTTP status codes** — status codes that don't match the error condition
5. **Internal detail leakage** — stack traces, SQL errors, or internal state exposed to clients

## Infrastructure Assessment

The error infrastructure is mature and well-designed:

| Layer | Implementation | Verdict |
|-------|---------------|---------|
| Wire format | RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`, `instance` | Correct |
| Error catalog | `PROBLEM_CATALOG` with 23 typed errors, each with resolution and retry advice, served at `GET /api/v1/problems` | Correct |
| Failure classifier | `classifyFailure()` with SQLSTATE, syscall, and HTTP status tables; `describeTransportFailure()` for human-readable transport errors | Correct |
| PII scrubbing | `scrubSensitive()` strips emails, tokens, UUIDs from error messages before logging | Correct |
| 5xx handler | `registerProblemHandler()` scrubs internal errors, never leaks `detail` to client | Correct |
| 4xx handler | Echoes Fastify's validation message as `detail` | Correct |
| Frontend helpers | `describeRequestFailure()`, `describeActionFailure()`, `describeLoadFailure()` | Correct |
| Status codes | `problems` factory maps each error type to its correct HTTP status | Correct |

## Gap Found

**20 frontend load-path catch blocks across 16 files discarded the server's `detail` field.**

Every catch was shaped `} catch { setError('Could not load X.'); }` — a bare catch with no binding, so the server's carefully-written refusal (e.g. a `forbidden()` explaining *why* the user cannot see this resource, or a validation error explaining what went wrong) was thrown away in favour of a generic retry suggestion.

This is the same class of bug that rounds R222, R255, R350, and R374 fixed on write paths and action paths. The existing `describeLoadFailure()` helper was already available but unused at these 20 sites.

## Files Changed (16 files, 20 catch sites)

All follow the same pattern: change `} catch {` + hardcoded string to `} catch (err) { setError(describeLoadFailure(err, 'original fallback string')); }`.

### Valuation panels (8 files, 8 catches)

| File | Line | Fallback message |
|------|------|-----------------|
| `components/valuation/FinancialModelPanel.tsx` | ~98 | Could not load the financial model. |
| `components/valuation/AuditorAccessPanel.tsx` | ~37 | Could not load auditor access settings. |
| `components/valuation/CalculationPanel.tsx` | ~121 | Could not load calculations. |
| `components/valuation/ParamsPanel.tsx` | ~478 | Could not load valuation parameters. |
| `components/valuation/TasksPanel.tsx` | ~73 | Could not load tasks. |
| `components/valuation/HrisSyncPanel.tsx` | ~125 | Could not load HRIS sync status. |
| `components/valuation/CapTableSyncPanel.tsx` | ~102 | Could not load cap table sync status. |
| `components/valuation/AccountingConnect.tsx` | ~67 | Could not load accounting connection. |

### Pages (8 files, 12 catches)

| File | Line | Fallback message |
|------|------|-----------------|
| `pages/EmailOutboxPage.tsx` | ~154 | Could not load the delivery trail. |
| `pages/EmailOutboxPage.tsx` | ~272 | Could not load delivery statistics. |
| `pages/AdminSsoPage.tsx` | ~88 | Could not load SSO configuration. |
| `pages/BotPromptsPage.tsx` | ~127 | Could not load prompt templates. |
| `pages/PortfolioPage.tsx` | ~155 | Could not load portfolio companies. |
| `pages/NotificationsPage.tsx` | ~82 | Could not load notifications. |
| `pages/AdminRetentionPage.tsx` | ~149 | Could not load retention data. |
| `pages/TasksPage.tsx` | ~168 | Could not load tasks. |
| `pages/TasksPage.tsx` | ~361 | Could not load review queue. |
| `pages/PartnerDetailPage.tsx` | ~296 | Could not load partner details. |

## Deliberately Unchanged

| Pattern | Reason |
|---------|--------|
| Clipboard `writeText` catches | Browser API, no server detail to surface |
| `localStorage` catches | Browser storage, silent fallback is correct |
| URL validation catches (`new URL()`) | Input parsing, not a server error |
| Non-fatal mark-as-read catches | Commented as intentionally silent; row stays unread |
| `SavedViews` / `SignaturePanel` catches | Commented with deliberate design reasoning |

## Test Coverage

The existing `errorMessageCensus.test.tsx` (established in R222, extended in R350, R374) already covers our changes:

- **`'opens the body at every load that displays a sentence'`** (line 436) — scans all source files for zero-arg `.catch(() =>` blocks that call `setError` without consulting the error. Our fixes converted bare `catch` to `catch (err)` with `describeLoadFailure`, so these sites no longer match the zero-arg pattern.
- **`'consults the error at every handler that changed something'`** (line 374) — ensures write handlers don't discard server refusals.
- **`describeLoadFailure` unit tests** (line 460) — verify the helper surfaces `detail` when present and falls back to the page's sentence when not.
- **`describeRequestFailure` unit tests** (line 488) — verify status-aware fallback prose.
- **`describeActionFailure` unit tests** (line 594) — verify operation + detail composition.

All error-message-related tests pass. The 25 pre-existing test file failures are in unrelated census tests (theme tokens, toggle state, touch targets).

## Impact

Before this fix, a user hitting a `403 Forbidden` on any of these 20 load paths would see "Could not load X" with no explanation. After: they see the server's own detail, e.g. "Viewing billing needs the account owner's access. Ask an owner to open it for you." — the action, the reason, and the remedy.

The same applies to validation errors (malformed date range, stale sort term) and rate limits, where the server's `detail` carries the specific constraint that was hit.
