// Automated payroll math checks. Runs on every push via GitHub Actions — catches a broken
// calculation before it ever reaches a real payslip, instead of an employee discovering it.
// No dependencies beyond Node's built-in assert, so this runs instantly in CI.

const assert = require("assert");
const {
  addDays, getMonday, getWeekStart, roundHoursForSettings, minutesBetween,
  applyBreakDeduction, calcEmployeeHours, calcPay, getPayPeriodRange,
} = require("./payroll-logic.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function closeTo(a, b, msg) {
  assert.ok(Math.abs(a - b) < 0.001, `${msg}: expected ${b}, got ${a}`);
}

const baseSettings = {
  overtime: { enabled: false },
  breakDeduction: { enabled: false, minutes: 30 },
  rounding: { enabled: false, interval: 15 },
  namedDeductions: {},
  deductions: [],
};

console.log("\n--- Basic hours & pay ---");

test("regular hours × rate = correct gross pay", () => {
  const days = ["2026-01-05", "2026-01-06"];
  const gridHours = { "e1|2026-01-05": 8, "e1|2026-01-06": 8 };
  const calc = calcPay({ id: "e1", rate: 25 }, days, gridHours, baseSettings);
  closeTo(calc.totalHours, 16, "total hours");
  closeTo(calc.gross, 400, "gross pay");
  closeTo(calc.net, 400, "net pay with no deductions");
});

test("multiple days sum correctly", () => {
  const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
  const gridHours = {};
  days.forEach((d) => (gridHours["e1|" + d] = 8));
  const calc = calcPay({ id: "e1", rate: 20 }, days, gridHours, baseSettings);
  closeTo(calc.totalHours, 40, "5 days at 8h = 40h");
  closeTo(calc.gross, 800, "gross for 40h at $20/hr");
});

test("zero hours worked = $0, not an error", () => {
  const calc = calcPay({ id: "e1", rate: 25 }, ["2026-01-05"], {}, baseSettings);
  closeTo(calc.totalHours, 0, "zero hours");
  closeTo(calc.gross, 0, "zero gross");
  closeTo(calc.net, 0, "zero net");
});

console.log("\n--- Overtime ---");

const otWeeklySettings = { ...baseSettings, overtime: { enabled: true, threshold: "weekly", multiplier: 1.5 } };

test("under weekly threshold — no overtime applied", () => {
  const days = ["2026-01-05", "2026-01-06", "2026-01-07"]; // Mon-Wed
  const gridHours = { "e1|2026-01-05": 8, "e1|2026-01-06": 8, "e1|2026-01-07": 8 };
  const calc = calcEmployeeHours("e1", days, gridHours, otWeeklySettings);
  closeTo(calc.regularHours, 24, "all 24h regular, under 40");
  closeTo(calc.overtimeHours, 0, "no overtime under threshold");
});

test("over weekly threshold — correct regular/overtime split", () => {
  const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]; // Mon-Fri, same week
  const gridHours = {};
  days.forEach((d) => (gridHours["e1|" + d] = 10)); // 50h total
  const calc = calcEmployeeHours("e1", days, gridHours, otWeeklySettings);
  closeTo(calc.totalHours, 50, "50 total hours");
  closeTo(calc.regularHours, 40, "capped at 40 regular");
  closeTo(calc.overtimeHours, 10, "10 hours overtime");
});

test("overtime multiplier applies only to the overtime portion", () => {
  const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
  const gridHours = {};
  days.forEach((d) => (gridHours["e1|" + d] = 10)); // 50h -> 40 regular + 10 OT
  const calc = calcPay({ id: "e1", rate: 20 }, days, gridHours, otWeeklySettings);
  // 40 * 20 + 10 * 20 * 1.5 = 800 + 300 = 1100
  closeTo(calc.gross, 1100, "gross with 1.5x overtime multiplier");
});

test("overtime disabled — straight regular pay no matter the hours", () => {
  const days = ["2026-01-05", "2026-01-06"];
  const gridHours = { "e1|2026-01-05": 12, "e1|2026-01-06": 12 }; // 24h, would be OT if enabled
  const calc = calcEmployeeHours("e1", days, gridHours, baseSettings);
  closeTo(calc.regularHours, 24, "all treated as regular when OT is off");
  closeTo(calc.overtimeHours, 0, "no overtime when disabled");
});

test("daily overtime threshold — over 8h/day triggers OT that day only", () => {
  const dailySettings = { ...baseSettings, overtime: { enabled: true, threshold: "daily", multiplier: 1.5 } };
  const days = ["2026-01-05", "2026-01-06"];
  const gridHours = { "2026-01-05": 0, "e1|2026-01-05": 10, "e1|2026-01-06": 6 };
  const calc = calcEmployeeHours("e1", days, gridHours, dailySettings);
  closeTo(calc.regularHours, 14, "8 (capped) + 6 = 14 regular");
  closeTo(calc.overtimeHours, 2, "2 hours over the daily 8h cap");
});

console.log("\n--- Rounding ---");

test("rounding off — exact minutes, no rounding", () => {
  const result = roundHoursForSettings(7.13, { rounding: { enabled: false } });
  closeTo(result, 7.13, "exact hours preserved when rounding is off");
});

test("rounding on — rounds to nearest interval", () => {
  const settings = { rounding: { enabled: true, interval: 15 } };
  // 7h07m = 7.1167h -> nearest 15 min (0.25h) -> 7.0h (7:00, since 7:07 is closer to 7:00 than 7:15)
  closeTo(roundHoursForSettings(7 + 7 / 60, settings), 7.0, "7:07 rounds down to 7:00 with 15-min rounding");
  // 7h08m = 7.1333h -> closer to 7:15 (7.25) than 7:00 (7.0)
  closeTo(roundHoursForSettings(7 + 8 / 60, settings), 7.25, "7:08 rounds up to 7:15 with 15-min rounding");
});

test("minutesBetween handles overnight shifts correctly", () => {
  const mins = minutesBetween("22:00", "06:00");
  assert.strictEqual(mins, 480, "10pm to 6am should be 8 hours (480 min)");
});

console.log("\n--- Break deduction ---");

test("break deduction off by default — nothing subtracted", () => {
  const result = applyBreakDeduction(8, { breakDeduction: { enabled: false, minutes: 30 } });
  closeTo(result, 8, "no deduction when disabled");
});

test("break deduction on — subtracts once for a worked day", () => {
  const result = applyBreakDeduction(8, { breakDeduction: { enabled: true, minutes: 30 } });
  closeTo(result, 7.5, "30 min break deducted from 8h day");
});

test("break deduction never applied to a zero-hour day", () => {
  const result = applyBreakDeduction(0, { breakDeduction: { enabled: true, minutes: 30 } });
  closeTo(result, 0, "no deduction on a day with no hours logged");
});

console.log("\n--- Deductions ---");

test("flat deduction subtracts the exact amount", () => {
  const settings = { ...baseSettings, deductions: [{ label: "Loan", type: "flat", value: 50 }] };
  const calc = calcPay({ id: "e1", rate: 25 }, ["2026-01-05"], { "e1|2026-01-05": 8 }, settings);
  closeTo(calc.gross, 200, "gross before deduction");
  closeTo(calc.net, 150, "net after $50 flat deduction");
});

test("percent deduction calculates off gross pay", () => {
  const settings = { ...baseSettings, namedDeductions: { incomeTax: { type: "percent", value: 10 } } };
  const calc = calcPay({ id: "e1", rate: 25 }, ["2026-01-05"], { "e1|2026-01-05": 8 }, settings);
  closeTo(calc.gross, 200, "gross before tax");
  closeTo(calc.net, 180, "net after 10% income tax");
});

test("multiple deductions stack correctly", () => {
  const settings = {
    ...baseSettings,
    namedDeductions: { ei: { type: "percent", value: 5 }, cpp: { type: "percent", value: 5 } },
    deductions: [{ label: "Union Fee", type: "flat", value: 10 }],
  };
  const calc = calcPay({ id: "e1", rate: 25 }, ["2026-01-05"], { "e1|2026-01-05": 8 }, settings);
  // gross 200, EI 5%=10, CPP 5%=10, flat 10 -> total deductions 30 -> net 170
  closeTo(calc.totalDeductions, 30, "deductions stack to 30");
  closeTo(calc.net, 170, "net after stacked deductions");
});

test("blank named deduction is excluded entirely, not treated as $0 line", () => {
  const settings = { ...baseSettings, namedDeductions: { incomeTax: { type: "percent", value: "" } } };
  const calc = calcPay({ id: "e1", rate: 25 }, ["2026-01-05"], { "e1|2026-01-05": 8 }, settings);
  assert.strictEqual(calc.deductionLines.length, 0, "blank deduction produces no line item at all");
});

console.log("\n--- Pay period boundaries ---");

test("weekly period returns a 7-day range", () => {
  const period = getPayPeriodRange({ type: "weekly", weekStartsOn: 1 }, "current", "2026-01-08"); // a Thursday
  const days = (new Date(period.end) - new Date(period.start)) / 86400000;
  assert.strictEqual(days, 6, "weekly period spans 7 days inclusive (6 day diff)");
});

test("biweekly period is exactly 14 days", () => {
  const period = getPayPeriodRange({ type: "biweekly", biweeklyAnchor: "2026-01-05" }, "current", "2026-01-10");
  const days = (new Date(period.end) - new Date(period.start)) / 86400000;
  assert.strictEqual(days, 13, "biweekly period spans 14 days inclusive (13 day diff)");
});

test("monthly period covers the full calendar month", () => {
  const period = getPayPeriodRange({ type: "monthly" }, "current", "2026-02-15");
  assert.strictEqual(period.start, "2026-02-01", "monthly period starts on the 1st");
  assert.strictEqual(period.end, "2026-02-28", "Feb 2026 (not a leap year) ends on the 28th");
});

test("semimonthly correctly splits first/second half of month", () => {
  const first = getPayPeriodRange({ type: "semimonthly" }, "current", "2026-03-10");
  assert.strictEqual(first.start, "2026-03-01");
  assert.strictEqual(first.end, "2026-03-15");
  const second = getPayPeriodRange({ type: "semimonthly" }, "current", "2026-03-20");
  assert.strictEqual(second.start, "2026-03-16");
  assert.strictEqual(second.end, "2026-03-31");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
