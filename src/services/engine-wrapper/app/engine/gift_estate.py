"""Gift & estate tax valuation (Rev. Rul. 59-60; IRC §§ 2031, 2512, 2503).

What separates this from a 409A is not the entity value — it is everything that
happens to that value on the way to the number reported on a Form 709 or 706:

  - **the discount chain is multiplicative, and in order.** A 20% DLOC and a
    30% DLOM are not a 50% discount, they are 1 − (0.80 × 0.70) = 44%. Adding
    them is the arithmetic error that shows up most often on examination, and
    the order matters for what each is applied *to*: DLOC steps the pro-rata
    share of entity value down to a non-controlling interest, and DLOM applies
    to that non-controlling interest — not to the pro-rata value;

  - **pro rata is not the same as the interest's value.** The transferred
    percentage is applied to entity value first; every discount is stated
    against that pro-rata amount so the report can show the bridge;

  - **the taxable gift is not the appraised value.** The annual exclusion
    (§2503(b), per donee, and doubled on a spousal split election) and the
    donor's prior taxable gifts sit between the two, and the deliverable is
    wrong if it stops at the appraisal;

  - **the eight §4.01 factors** are the governing checklist. Which of them the
    appraiser addressed is a fact about the file, so it is reported as one —
    an unaddressed factor is a finding, not a silence.

Pure and deterministic; entity value arrives as an input.
"""

from __future__ import annotations

import math

from .errors import EngineInputError

# Rev. Rul. 59-60 §4.01 — the eight factors "to be considered" in valuing the
# stock of a closely held corporation. Named here because the deliverable is
# graded against them.
REV_RUL_59_60_FACTORS = (
    ("nature_and_history", "The nature of the business and the history of the enterprise"),
    ("economic_outlook", "The economic outlook generally and the condition of the specific industry"),
    ("book_value", "The book value of the stock and the financial condition of the business"),
    ("earning_capacity", "The earning capacity of the company"),
    ("dividend_capacity", "The dividend-paying capacity of the company"),
    ("goodwill", "Whether the enterprise has goodwill or other intangible value"),
    ("prior_sales", "Sales of the stock and the size of the block to be valued"),
    ("comparable_companies", "The market price of comparable listed corporations"),
)

TRANSFER_TYPES = {"gift", "estate", "gst", "sale_to_grantor_trust"}


def _num(
    value, name: str, *, minimum: float | None = None, maximum: float | None = None
) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be a number") from exc
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise EngineInputError(f"{name} must be >= {minimum}")
    if maximum is not None and out > maximum:
        raise EngineInputError(f"{name} must be <= {maximum}")
    return out


def combined_discount(dloc: float, dlom: float) -> float:
    """The effective discount from applying DLOC then DLOM: 1 − (1−a)(1−b).

    Exposed on its own because it is the figure the report quotes and the one
    a reviewer recomputes by hand.
    """
    a = _num(dloc, "gifts.dloc", minimum=0.0, maximum=0.99)
    b = _num(dlom, "gifts.dlom", minimum=0.0, maximum=0.99)
    return 1.0 - (1.0 - a) * (1.0 - b)


def _factors(addressed) -> dict:
    """Which §4.01 factors the file addresses, and which it does not."""
    if addressed is None:
        keys: set[str] = set()
    elif isinstance(addressed, list):
        keys = {str(k).strip().lower() for k in addressed}
    else:
        raise EngineInputError("gifts.factors_addressed must be a list of factor keys")

    known = {key for key, _label in REV_RUL_59_60_FACTORS}
    unknown = sorted(keys - known)
    if unknown:
        raise EngineInputError(
            f"gifts.factors_addressed has unknown factor(s): {', '.join(unknown)}"
        )
    return {
        # Whether the file said anything at all. `None` and `[]` produce the
        # same eight "no"s and mean opposite things: an appraiser who worked
        # through the checklist and addressed none of it, versus a caller who
        # never passed the argument. Printing the second as the first puts "0 of
        # 8 factors addressed" in a Rev. Rul. 59-60 appraisal, which is the worst
        # sentence such a report can contain about itself.
        "stated": addressed is not None,
        "factors": [
            {"key": key, "label": label, "addressed": key in keys}
            for key, label in REV_RUL_59_60_FACTORS
        ],
        "addressed_count": len(keys),
        "total_count": len(REV_RUL_59_60_FACTORS),
        # An unaddressed factor is a finding the analyst resolves before
        # issuing, not something to leave the reader to notice.
        "unaddressed": sorted(key for key, _l in REV_RUL_59_60_FACTORS if key not in keys),
    }


def gift_estate_valuation(
    *,
    entity_value: float,
    percent_interest: float,
    transfer_type: str = "gift",
    dloc: float = 0.0,
    dlom: float = 0.0,
    transfer_date: str | None = None,
    # §2503(b) — per donee, per year. Supplied rather than hard-coded: it is
    # indexed for inflation, and an engine that bakes in one year's figure
    # silently misstates every other year's return.
    #
    # `None`, not 0.0, when it is absent. The two are the same arithmetic and
    # opposite statements: zero is "the exclusion was considered and none is
    # available", absent is "nobody has said what this year's figure is". The
    # default used to be 0.0, so a caller that never asked the question got a
    # return line reading "less annual exclusion — $0" and a taxable gift equal
    # to the whole appraised value, presented as a determination.
    annual_exclusion: float | None = None,
    donees: int = 1,
    split_gift: bool = False,
    prior_taxable_gifts: float = 0.0,
    factors_addressed: list | None = None,
) -> dict:
    """Entity value → transferred interest → discounts → reportable taxable gift."""
    value = _num(entity_value, "gifts.entity_value", minimum=0.0)
    # Accepted as a percentage because that is what the questionnaire asks for
    # ("25 for a quarter interest"); a fraction here would silently value a
    # quarter interest at a quarter of a percent.
    percent = _num(percent_interest, "gifts.percent_interest", minimum=0.0, maximum=100.0)
    kind = str(transfer_type or "").strip().lower()
    if kind not in TRANSFER_TYPES:
        raise EngineInputError(
            f"gifts.transfer_type must be one of {', '.join(sorted(TRANSFER_TYPES))}"
        )

    discount_lack_control = _num(dloc, "gifts.dloc", minimum=0.0, maximum=0.99)
    discount_marketability = _num(dlom, "gifts.dlom", minimum=0.0, maximum=0.99)

    pro_rata = value * (percent / 100.0)
    # Applied in order, each to the result of the last — never summed.
    after_dloc = pro_rata * (1.0 - discount_lack_control)
    after_dlom = after_dloc * (1.0 - discount_marketability)
    effective = combined_discount(discount_lack_control, discount_marketability)

    determined = annual_exclusion is not None
    exclusion_per_donee = (
        _num(annual_exclusion, "gifts.annual_exclusion", minimum=0.0) if determined else 0.0
    )
    donee_count = int(_num(donees, "gifts.donees", minimum=1, maximum=1000))
    # A split gift (§2513) is treated as made half by each spouse, which in
    # practice doubles the exclusion available against the transfer.
    exclusion_multiple = 2 if bool(split_gift) else 1
    exclusion = exclusion_per_donee * donee_count * exclusion_multiple

    # An estate inclusion (§2031) and a GST transfer are not sheltered by the
    # annual exclusion; applying it there would understate the return.
    exclusion_applies = kind in {"gift", "sale_to_grantor_trust"}
    exclusion_used = min(exclusion, after_dlom) if exclusion_applies else 0.0

    prior = _num(prior_taxable_gifts, "gifts.prior_taxable_gifts", minimum=0.0)
    taxable = max(after_dlom - exclusion_used, 0.0)

    return {
        "transfer_type": kind,
        "transfer_date": transfer_date,
        "entity_value": value,
        "percent_interest": percent,
        # The bridge the report prints line for line.
        "value_bridge": [
            {"step": "pro_rata_interest", "value": pro_rata},
            {
                "step": "less_dloc",
                "rate": discount_lack_control,
                "amount": pro_rata - after_dloc,
                "value": after_dloc,
            },
            {
                "step": "less_dlom",
                "rate": discount_marketability,
                "amount": after_dloc - after_dlom,
                "value": after_dlom,
            },
        ],
        "pro_rata_value": pro_rata,
        "dloc": discount_lack_control,
        "value_after_dloc": after_dloc,
        "dlom": discount_marketability,
        "concluded_value": after_dlom,
        # 1 − (1−a)(1−b), not a + b. Reported so the sum is visibly not what
        # was used.
        "effective_discount": effective,
        "total_discount_amount": pro_rata - after_dlom,
        "annual_exclusion": {
            # Whether this year's §2503(b) figure was supplied at all. A reader
            # cannot tell that from a zero, and the exhibit must not print an
            # unanswered question as a nil determination.
            "determined": determined,
            "per_donee": exclusion_per_donee,
            "donees": donee_count,
            "split_gift": bool(split_gift),
            "available": exclusion,
            "applied": exclusion_used,
            "applies": exclusion_applies,
        },
        "prior_taxable_gifts": prior,
        "taxable_gift": taxable,
        "cumulative_taxable_gifts": taxable + prior,
        "rev_rul_59_60": _factors(factors_addressed),
    }
