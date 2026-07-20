from app.output_schema import has_schema, validate_result


def test_valid_extract_result_passes():
    result = {"engine_inputs": {"cash": 1.0}, "extractions": [], "documents_reviewed": []}
    assert validate_result("extract", result) == []


def test_missing_field_is_flagged():
    issues = validate_result("extract", {"engine_inputs": {}})
    assert any("extractions" in i for i in issues)


def test_wrong_type_is_flagged():
    issues = validate_result("comparables", {"comparables": {}, "sector": "x", "caveats": "y"})
    assert any("comparables" in i and "list" in i for i in issues)


def test_qa_verdict_enum_is_checked():
    good = {"findings": [], "assessment": "ok", "verdict": "pass"}
    assert validate_result("qa", good) == []
    bad = {"findings": [], "assessment": "ok", "verdict": "maybe"}
    assert any("verdict" in i for i in validate_result("qa", bad))


def test_non_dict_result_is_flagged():
    assert validate_result("extract", ["nope"]) == ["result must be an object, got list"]


def test_unknown_pipeline_is_not_validated():
    assert not has_schema("cap_table_agent")
    assert validate_result("cap_table_agent", {"anything": True}) == []
