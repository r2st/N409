"""Post-hoc output-shape validation for AI pipelines (audit B-2 P3).

The pipelines already normalize the raw LLM JSON into stable result dicts, but
nothing asserts the final shape before it is persisted, so a coding regression
(or an agent returning an off-contract object) could flow downstream silently.
This module declares the expected top-level shape per pipeline and validates the
*normalized* result. It is intentionally non-fatal: `run_pipeline` logs a warning
and still returns, so validation can never take a working pipeline offline — it
just makes drift observable.
"""

from __future__ import annotations

# pipeline -> {field: expected python type(s)}
_SCHEMAS: dict[str, dict[str, type | tuple[type, ...]]] = {
    "missing_data": {"missing_documents": list, "missing_params": list, "gaps": list},
    "extract": {"engine_inputs": dict, "extractions": list},
    "comparables": {"comparables": list, "sector": str, "caveats": str},
    "summarize": {"summaries": list, "overall": str},
    "qa": {"findings": list, "assessment": str, "verdict": str},
    "explain": {"summary": str, "methodology": list, "drivers": list},
}

_QA_VERDICTS = {"pass", "warn", "fail"}


def has_schema(pipeline: str) -> bool:
    return pipeline in _SCHEMAS


def validate_result(pipeline: str, result: object) -> list[str]:
    """Returns a list of human-readable shape issues (empty when valid)."""
    schema = _SCHEMAS.get(pipeline)
    if schema is None:
        return []
    if not isinstance(result, dict):
        return [f"result must be an object, got {type(result).__name__}"]

    issues: list[str] = []
    for field, expected in schema.items():
        if field not in result:
            issues.append(f"missing field '{field}'")
            continue
        if not isinstance(result[field], expected):
            names = (
                expected.__name__
                if isinstance(expected, type)
                else "/".join(t.__name__ for t in expected)
            )
            issues.append(f"field '{field}' should be {names}, got {type(result[field]).__name__}")

    if pipeline == "qa" and isinstance(result.get("verdict"), str):
        if result["verdict"] not in _QA_VERDICTS:
            issues.append(f"verdict '{result['verdict']}' not one of {sorted(_QA_VERDICTS)}")

    return issues
