from units import average


def make_report(city, readings):
    temperature = average(readings)
    if temperature >= 25:
        label = "warm"
    else:
        label = "mild"
    return f"{city}: {temperature:.1f} C, {label}"
