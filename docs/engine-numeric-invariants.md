# Engine numeric invariants

Rules the `engine-wrapper` service holds to, and the reasoning behind them. This
exists because the same defect has been found and fixed six separate times in
this codebase — most recently in `rollforward.py` and `market_feed.py` — and it
will be reintroduced again by anyone who hasn't hit it. It is not a style guide.

## The invariant

> **No money field is ever `null` on a 200, and no bad input is ever a 500.**

A valuation endpoint has exactly two honest outcomes: a number, or a 4xx naming
the field that made a number impossible. A `200 {"fmv_per_share": null}` is the
one thing it must never do — it looks like a successful valuation to every
caller, it is stored as one, and it is defensible to nobody.

## Why NaN specifically defeats validation

NaN is not caught by the range checks written to catch bad numbers, because
**every comparison against NaN is False**:

```python
NaN <= 0      # False  → passes "must be positive"
NaN < 0       # False  → passes "must be non-negative"
0.0 < NaN < 5 # False  → correctly *rejected* by a two-sided bound
```

So a guard like this is not a guard at all:

```python
if shares <= 0:                       # NaN sails straight through
    raise EngineInputError("shares must be positive")
```

NaN then propagates: every arithmetic operation involving it yields NaN, so one
NaN share count makes every allocated class value NaN. FastAPI serialises those
as `null`, and the run returns 200 with holes where the money goes.

Three things follow, and each one has been a real bug here:

1. **The finiteness check must come *first*.** Ordering it after the range check
   means the range check has already waved the NaN past. (`waterfall.py` —
   commits `bf226c4`, `eacf633`.)
2. **A one-sided bound is not enough; a two-sided bound happens to work.**
   `0.0 < x < 5.0` rejects NaN by accident, because both halves are False.
   Don't rely on the accident — say `isfinite` and mean it. (`volatility.py`.)
3. **NaN survives "is this a usable value?" type checks.** `isinstance(nan,
   float)` is True, so filters that keep numbers and drop `None` keep NaN.
   (`market_feed.py` — commit `2157408`.)

## Infinity, and the arithmetic that produces it

Infinity passes the same checks NaN does in one direction (`inf <= 0` is False)
and is likewise not JSON. But it also arrives a second way: **inputs that are
each individually finite can still produce a non-finite result.** Validating
only at the boundary is therefore insufficient — a computed value that is about
to be returned needs its own check:

```python
if not math.isfinite(equity):
    raise EngineInputError("rolled equity value is not finite after adjustments")
if equity <= 0:
    raise EngineInputError("rolled equity value is not positive after adjustments")
```

## The other tail: results that aren't real numbers at all

`(1 + rate) ** years` looks like it returns a float. With a negative base and a
fractional exponent, **Python returns a complex number**:

```python
(-0.5) ** 0.5   # (4.3e-17+0.707j)
```

Nothing downstream expects that; `round()` raises `TypeError` and the request
dies as an opaque 500. Any `x ** y` with a caller-supplied `x` needs its domain
enforced up front — for an accretion or growth rate, `rate > -1`. (Commit
`efb426d`.)

## How to apply it

Every module that ingests numbers defines a local coercion helper that does all
of this in one place, and everything goes through it. The canonical form:

```python
def _num(value, name: str, *, minimum: float | None = None) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be a number") from exc
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise EngineInputError(f"{name} must be >= {minimum}")
    return out
```

Notes on the shape:

- **It raises `EngineInputError`, never a bare `ValueError`.** `EngineInputError`
  is what `app/errors.py` renders as a 4xx naming the field. A bare `float()` on
  caller data is how a typo becomes a 500 — including on data read back out of a
  *stored* prior result, which is caller data too.
- **`name` is the field path**, so the message points at the input rather than
  at the arithmetic that choked on it.
- **Where a value is optional, return `None` for absent** and let the caller
  decide — but still reject non-finite when it *is* present.

For data arriving from an external provider rather than a client, the same rule
applies with a different remedy: a non-finite reading means "no data", so it
should become `None` and be **excluded** from aggregates, not passed along.
`yfinance`'s `.info` is pandas-backed and returns `nan` for missing fields, so
this is the common case, not the exotic one — and a single NaN in a median drags
the aggregate for every other input to NaN with it.

## Where it is enforced

Every engine module that ingests numbers: `compute`, `current_value`,
`debt_valuation`, `fund_valuation`, `hybrid`, `market_feed`, `projection`,
`pwerm`, `rollforward`, `validate`, `volatility`, `wacc`, `waterfall`.

**A new engine module that takes numbers from a request belongs on that list.**
The gap that produced commit `efb426d` was exactly this: `rollforward._num` was
the one numeric helper in the engine without a finiteness check, and it had been
that way since the module was written.

## Testing it

Assert the invariant, not just the branch. Tests in this family should cover:

- the guard itself — the function raises `EngineInputError` for NaN, `inf`,
  `-inf`, and any out-of-domain value;
- **the HTTP boundary** — the same input is a 4xx, not a 500 and not a 200.
  `NaN` and `Infinity` are Python-JSON literals, so a raw body reaches the
  handler with them intact even though `json.dumps` will not emit them:

  ```python
  client.post(url, content='{"annual_accretion": NaN}',
              headers={"content-type": "application/json"})
  ```

- **the property**, stated directly — on a successful run, no money field came
  back `null`, and the payload survives `json.dumps(body, allow_nan=False)`.

See `tests/test_nonfinite_guards.py`, and the guard blocks in
`tests/test_rollforward.py` and `tests/test_market_feed.py`.
