// Shared payroll calculation logic — loaded directly by index.html (plain script, no build step)
// AND required by payroll-tests.js for automated checking. Keeping this in one place means the
// tests actually verify the same code the app runs, instead of a copy that can quietly drift.

function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr() {
  return toLocalDateStr(new Date());
}
function toISO(d) {
  return toLocalDateStr(d);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toLocalDateStr(d);
}
function getMonday(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toLocalDateStr(d);
}
function getWeekStart(dateStr, weekStartsOn) {
  const wso = weekStartsOn === undefined || weekStartsOn === null ? 1 : weekStartsOn;
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = (day - wso + 7) % 7;
  d.setDate(d.getDate() - diff);
  return toLocalDateStr(d);
}

function roundHoursForSettings(hoursDecimal, settings) {
  const r = settings && settings.rounding;
  if (!r || !r.enabled) return Math.round(hoursDecimal * 100) / 100;
  const intervalHrs = (r.interval || 15) / 60;
  return Math.round(hoursDecimal / intervalHrs) * intervalHrs;
}

function minutesBetween(start, end) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins;
}

function applyBreakDeduction(dayHours, settings) {
  if (!dayHours || !settings.breakDeduction || !settings.breakDeduction.enabled) return dayHours;
  const reduced = dayHours - settings.breakDeduction.minutes / 60;
  return Math.max(0, reduced);
}

function calcEmployeeHours(employeeId, days, gridHours, settings) {
  const dayValues = days.map((d) => applyBreakDeduction(gridHours[employeeId + "|" + d] || 0, settings));
  const totalHours = dayValues.reduce((s, h) => s + h, 0);

  if (!settings.overtime || !settings.overtime.enabled) {
    return { totalHours, regularHours: totalHours, overtimeHours: 0 };
  }

  if (settings.overtime.threshold === "daily") {
    let regular = 0, overtime = 0;
    for (const h of dayValues) {
      regular += Math.min(h, 8);
      overtime += Math.max(0, h - 8);
    }
    return { totalHours, regularHours: regular, overtimeHours: overtime };
  }

  const weekTotals = {};
  days.forEach((d, i) => {
    const wk = getMonday(d);
    weekTotals[wk] = (weekTotals[wk] || 0) + dayValues[i];
  });
  let regular = 0, overtime = 0;
  Object.values(weekTotals).forEach((wkHours) => {
    regular += Math.min(wkHours, 40);
    overtime += Math.max(0, wkHours - 40);
  });
  return { totalHours, regularHours: regular, overtimeHours: overtime };
}

const NAMED_DEDUCTION_LABELS = {
  incomeTax: "Income Tax",
  ei: "EI",
  cpp: "CPP",
  pension: "Pension",
  vacationPay: "Vacation Pay",
  healthBenefits: "Health/Benefits",
  unionDues: "Union Dues",
};

function calcPay(employee, days, gridHours, settings) {
  const { totalHours, regularHours, overtimeHours } = calcEmployeeHours(employee.id, days, gridHours, settings);
  const multiplier = settings.overtime && settings.overtime.enabled ? settings.overtime.multiplier : 1;
  const gross = regularHours * employee.rate + overtimeHours * employee.rate * multiplier;

  const named = settings.namedDeductions || {};
  const namedLines = Object.keys(NAMED_DEDUCTION_LABELS)
    .map((key) => {
      const d = named[key];
      if (!d || d.value === "" || d.value === null || d.value === undefined || Number(d.value) === 0) return null;
      return { label: NAMED_DEDUCTION_LABELS[key], amount: d.type === "percent" ? gross * (Number(d.value) / 100) : Number(d.value) };
    })
    .filter(Boolean);

  const customLines = (settings.deductions || []).map((d) => ({
    label: d.label,
    amount: d.type === "percent" ? gross * (d.value / 100) : d.value,
  }));

  const deductionLines = [...namedLines, ...customLines];
  const totalDeductions = deductionLines.reduce((s, d) => s + d.amount, 0);
  const net = Math.max(0, gross - totalDeductions);
  return { totalHours, regularHours, overtimeHours, gross, deductionLines, totalDeductions, net };
}

function getPayPeriodRange(payPeriod, which, today) {
  const t = today || todayStr();
  if (payPeriod.type === "semimonthly") {
    const d = new Date(t + "T00:00:00");
    const day = d.getDate();
    let start, end;
    if (which === "current") {
      if (day <= 15) { start = new Date(d.getFullYear(), d.getMonth(), 1); end = new Date(d.getFullYear(), d.getMonth(), 15); }
      else { start = new Date(d.getFullYear(), d.getMonth(), 16); end = new Date(d.getFullYear(), d.getMonth() + 1, 0); }
    } else {
      if (day <= 15) { end = new Date(d.getFullYear(), d.getMonth(), 0); start = new Date(end.getFullYear(), end.getMonth(), 16); }
      else { start = new Date(d.getFullYear(), d.getMonth(), 1); end = new Date(d.getFullYear(), d.getMonth(), 15); }
    }
    return { start: toISO(start), end: toISO(end) };
  }
  if (payPeriod.type === "biweekly") {
    const anchor = payPeriod.biweeklyAnchor || t;
    const diffDays = Math.floor((new Date(t + "T00:00:00") - new Date(anchor + "T00:00:00")) / 86400000);
    const periodIndex = Math.floor(diffDays / 14);
    const idx = which === "current" ? periodIndex : periodIndex - 1;
    const start = addDays(anchor, idx * 14);
    return { start, end: addDays(start, 13) };
  }
  if (payPeriod.type === "monthly") {
    const d = new Date(t + "T00:00:00");
    if (which === "current") {
      return { start: toISO(new Date(d.getFullYear(), d.getMonth(), 1)), end: toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
    }
    return { start: toISO(new Date(d.getFullYear(), d.getMonth() - 1, 1)), end: toISO(new Date(d.getFullYear(), d.getMonth(), 0)) };
  }
  const weekStart = getWeekStart(t, payPeriod.weekStartsOn);
  const start = which === "current" ? weekStart : addDays(weekStart, -7);
  return { start, end: addDays(start, 6) };
}

// Universal export: works as a plain <script> in the browser (functions land on window via var/function
// hoisting at top level) and as a CommonJS module for the Node-based test runner.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    toLocalDateStr, todayStr, toISO, addDays, getMonday, getWeekStart,
    roundHoursForSettings, minutesBetween, applyBreakDeduction,
    calcEmployeeHours, calcPay, getPayPeriodRange, NAMED_DEDUCTION_LABELS,
  };
}
