from rules import check_quality


def describe_quality(password):
    checks = check_quality(password)
    passed = sum(checks.values())
    return f"Passed {passed} of {len(checks)} simple checks."
