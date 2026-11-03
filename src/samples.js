export const samples=[{
filename:'checkout.js',code:`// A small checkout, from cart to receipt.
const DISCOUNT_RATE = 0.1;

function formatReceipt(total) {
  return 'Your total is $' + total.toFixed(2);
}

function calculateSubtotal(items) {
  return items.reduce((sum, item) => {
    return sum + item.price * item.quantity;
  }, 0);
}

function applyDiscount(subtotal, code) {
  if (code === 'STORY10') {
    return subtotal * (1 - DISCOUNT_RATE);
  }
  return subtotal;
}

function checkout(items, discountCode) {
  const subtotal = calculateSubtotal(items);
  const total = applyDiscount(subtotal, discountCode);
  return formatReceipt(total);
}

const cart = [
  { name: 'Notebook', price: 12, quantity: 2 },
  { name: 'Pencil', price: 3, quantity: 4 },
];

const receipt = checkout(cart, 'STORY10');
console.log(receipt);
`},{filename:'weather.py',code:`"""Build a short weather report from temperature readings."""

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
`},{filename:'users.ts',code:`type User = {
  id: number;
  name: string;
  active: boolean;
};

function getActiveUsers(users: User[]): User[] {
  return users.filter(user => user.active);
}

function getNames(users: User[]): string[] {
  return users.map(user => user.name);
}

function buildDirectory(users: User[]): string[] {
  const activeUsers = getActiveUsers(users);
  return getNames(activeUsers);
}

const users: User[] = [
  { id: 1, name: 'Alex', active: true },
  { id: 2, name: 'Sam', active: false },
];

console.log(buildDirectory(users));
`},{filename:"page.html",code:"<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>Weekly reading list</title>\n  <style>\n    body { font-family: system-ui; max-width: 40rem; margin: 2rem auto; }\n    .finished { color: green; }\n  </style>\n</head>\n<body>\n  <header><h1>Weekly reading list</h1></header>\n  <main>\n    <p>One small goal: finish two chapters.</p>\n    <ul>\n      <li class=\"finished\">Chapter 1: variables</li>\n      <li>Chapter 2: functions</li>\n    </ul>\n  </main>\n  <footer>Saved as a local HTML page.</footer>\n</body>\n</html>\n"},{filename:"TemperatureConverter.java",code:"public class TemperatureConverter {\n    public static double toFahrenheit(double celsius) {\n        return celsius * 9.0 / 5.0 + 32;\n    }\n\n    public static String describe(double celsius) {\n        if (celsius >= 30) {\n            return \"Warm day\";\n        }\n        return \"Cooler day\";\n    }\n\n    public static void main(String[] args) {\n        double celsius = 20;\n        double fahrenheit = toFahrenheit(celsius);\n        System.out.println(fahrenheit + \" F - \" + describe(celsius));\n    }\n}\n"},{filename:"TemperatureConverter.cs",code:"using System;\n\npublic class TemperatureConverter\n{\n    public static double ToFahrenheit(double celsius)\n    {\n        return celsius * 9.0 / 5.0 + 32;\n    }\n\n    public static string Describe(double celsius)\n    {\n        if (celsius >= 30)\n        {\n            return \"Warm day\";\n        }\n        return \"Cooler day\";\n    }\n\n    public static void Main()\n    {\n        double celsius = 20;\n        double fahrenheit = ToFahrenheit(celsius);\n        Console.WriteLine($\"{fahrenheit} F - {Describe(celsius)}\");\n    }\n}\n"},{filename:"sales_summary.sql",code:"-- Demonstration data for a temporary database, not a production database.\nCREATE TABLE sales (\n    product VARCHAR(40),\n    quantity INTEGER,\n    price_cents INTEGER\n);\n\nINSERT INTO sales (product, quantity, price_cents)\nVALUES ('Notebook', 2, 500), ('Pencil', 3, 100), ('Notebook', 1, 500);\n\nSELECT product,\n       SUM(quantity) AS units,\n       SUM(quantity * price_cents) AS revenue_cents,\n       CASE WHEN SUM(quantity) >= 3 THEN 'Goal reached' ELSE 'Below goal' END AS goal\nFROM sales\nGROUP BY product\nORDER BY product;\n"}];
