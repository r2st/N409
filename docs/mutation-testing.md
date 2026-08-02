# Mutation testing the engine

Coverage tells you a line *ran*. It does not tell you the line's value was ever
checked. Those are different claims, and for a valuation engine only the second
one matters: a report that says `$1.4271` instead of `$1.4270` is 100% covered
and wrong.

Mutation testing closes that gap by breaking the code on purpose. Change `>` to
`>=`, `+` to `-`, a default from `0.0` to `1.0` — then rerun the suite. If the
tests still pass, no test was actually asserting on that decision, and a real
change there would ship silently.

## Running it

```bash
cd src/services/engine-wrapper
pip install -r requirements-dev.txt     # brings in mutmut
mutmut run                              # ~2.5 min, 10.4k mutants
mutmut results                          # surviving mutants, by id
mutmut show app.engine.waterfall.x__segments__mutmut_42   # one mutant's diff
mutmut browse                           # interactive TUI
```

Config is in `setup.cfg`. The whole `app/` package is copied into `mutants/` so
the FastAPI tests can still import `app.main`, but `app/main.py` itself is
excluded from mutation: it is request plumbing, and its mutants would dilute the
score without saying anything about the numbers.

`mutants/` is generated build output and is gitignored. Delete it whenever you
want a clean run; `mutmut run` rebuilds it.

## Why it is not in CI

A full run takes minutes, not seconds, and the survivor list needs a human to
read it — most survivors are not defects. Putting that in the PR path would
train everyone to ignore it. Run it when you change `app/engine/`, and treat a
new survivor in a value-producing expression the way you would treat a failing
test.

## Reading the results

The score is not the point, and chasing 100% is actively harmful. Sort
survivors into three kinds:

**Noise — ignore.** mutmut rewrites string literals (`"face"` → `"XXfaceXX"`),
so every error message produces mutants that survive unless a test asserts the
exact message text. Pinning message strings makes the suite brittle for no
gain. Roughly 40% of survivors here are this.

**Equivalent — ignore, but check first.** The mutation changed the source
without changing the behaviour: a clamp bound that no reachable input can hit, a
default that is overwritten before use. These are worth one minute of thought
each, because "surely that's equivalent" is also what a real bug looks like from
a distance.

**Real — fix.** The mutation changed what the engine would *return*, and
nothing noticed. Two shapes dominate:

- **Boundary flips** — `t <= 0` becoming `t < 0` survives whenever no test
  passes exactly `t = 0`. Degenerate inputs (zero volatility, zero time to
  exit, a single share class) are exactly the ones that reach production via a
  half-filled form.
- **Guard defaults** — `_num(x, "x", minimum=0.0)` becoming `minimum=None`
  survives whenever no test passes a *negative* value for that field. A
  surviving mutant here means the validation is unproven, and a negative
  volatility or share count would flow into the model.

Both shapes are fixed by adding the missing assertion, not by changing the
engine. When fixing one reveals that the engine really is wrong, that is the
harness doing its job — see `docs/engine-numeric-invariants.md` for the class of
defect this codebase keeps reintroducing.

## Baseline

At the time this harness landed: **10,422 mutants, 6,321 killed, 4,015 survived
(61.1%)**. Of the survivors, ~1,559 were string-literal noise and ~2,279 changed
a numeric decision. That second number is the backlog worth working through,
highest-consequence module first — `compute`, `waterfall`, `approaches` and
`pwerm` decide the FMV per share that goes on the report.

After the first pass over it (`test_allocation_properties.py` and
`test_boundary_inputs.py`, 28 tests): **6,376 killed, 3,960 survived (61.7%)**.

Fifty-five mutants for twenty-eight tests is a fair exchange rate, and it is
worth being clear about why the score barely moved: the tests that closed real
gaps were boundary cases, and each boundary is one or two mutants. The bulk of
what remains is message strings and clamps no reachable input can hit. Reporting
this as "+0.5%" would be true and useless — the useful statement is that
thirteen structural invariants now hold over a few hundred generated cap tables,
and that no invariant failed when it was first run, which is evidence about the
engine rather than about the score.

Do not chase the number. Read the survivors.
