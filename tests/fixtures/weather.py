"""Build a short weather report from temperature readings."""

def format_report(city, average):
    return f"{city}: an average of {average:.1f}°C"

def average_temperature(readings):
    if not readings:
        return 0
    return sum(readings) / len(readings)

def describe_weather(city, readings):
    average = average_temperature(readings)
    return format_report(city, average)

city = "Portland"
temperatures = [14, 17, 19, 16]
report = describe_weather(city, temperatures)
print(report)
