# R376 — Silent Failure Audit

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Round          | R376                                     |
| Methodology    | M5 — silent failure audit                |
| Cycle / Pass   | 57 / 4                                   |
| Findings       | 1 HIGH                                   |
| Commit         | (this commit)                            |

## Finding 1 — HIGH: Credit-spread → rating fallback broken by R367 isFinite guard

**File**: `src/services/valuation/src/routes/debt.ts` (lines 419–423, pre-fix)

**Bug**: R367 added a `Number.isFinite()` guard around `terms.spread` coercion
to prevent NaN/Infinity reaching the engine. However, the guard was wrapped in
its own `if` block while the rating fallback remained an `else if` bound to
the _outer_ null-check:

```typescript
// R367 (buggy)
if (terms?.spread != null) {
  const n = Number(terms.spread);
  if (Number.isFinite(n)) params.spread = n;
}
else if (terms?.rating) params.rating = terms.rating;
```

When `terms.spread` is non-null but non-finite (e.g. the string `"N/A"`), the
outer `if` is true so the `else if` is skipped, but `Number.isFinite` fails so
`params.spread` is never set. The engine receives **neither spread nor rating**
— the instrument is priced with incomplete parameters and no warning is raised.

**Impact**: A debt instrument with a corrupt or non-numeric spread value and a
valid rating would be silently priced without either credit parameter, producing
an incorrect fair value in the 409A report. This is data-affecting and silent.

**Fix**: Extracted the credit-term assembly into a pure exported function
`applyCreditTerms()` that evaluates spread finiteness first and falls through to
the rating when spread is absent _or_ non-finite:

```typescript
const spreadNum = terms.spread != null ? Number(terms.spread) : NaN;
if (Number.isFinite(spreadNum)) {
  params.spread = spreadNum;
} else if (terms.rating) {
  params.rating = terms.rating;
}
```

**Test**: `test/unit/debtCreditTermsFallback.test.ts` — 8 cases covering finite
spread, null spread, non-finite spread (the regression), NaN string, Infinity
string, absent rating, null terms, and non-finite benchmark_yield.

## Scan summary

Searched the full `src/services/valuation/src/` tree for silent failure patterns:

- Bare `.catch(() => {})` and `.catch((_) => {})` — all intentional containment
  with logging (scheduler, circuit observer, broadcast hub, UI resilience)
- `catch` blocks returning empty results — all have upstream guards or classified
  logging (partner logo, unsubscribe token, AI redaction identity)
- `Number()` coercion without `isFinite` — the three sites R367 fixed are the
  only critical ones; remaining sites either operate on database-stored numerics
  (always valid strings) or have explicit NaN handling (`|| 0`, `?? 0`)
- `parseInt`/`parseFloat` without NaN guard — all guarded with `|| 0` fallback
  or used in non-critical display contexts (hex parsing, SMTP codes)
- `JSON.parse` without try/catch — all inside validated Fastify body parsing or
  wrapped in existing error handlers
- State machine transitions — well-guarded with `assertTransition` in the order
  lifecycle
- Email/notification sending — per-message containment with `logFailure` /
  `logUnretried` and `recordSendFailure`
- Webhook handling — re-throws for Stripe redelivery; audit containment is
  intentional and logged

This codebase has been through 56 prior improvement cycles and the error-handling
discipline is strong. The one finding is a regression introduced by a valid fix
(R367) where the guard structure silently changed the control flow semantics.
