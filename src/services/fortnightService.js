/* Regras de calendario dos complementos quinzenais. */
const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

function dateParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const values = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).forEach((part) => {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  });
  return values;
}

function formatDateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fortnightStartForDate(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = dateParts(date, timeZone);
  return formatDateKey(year, month, day <= 15 ? 1 : 16);
}

function normalizeFortnightStart(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-(01|02|03|04|05|06|07|08|09|10|11|12)-(\d{2})$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  if (day !== 1 && day !== 16) return null;
  return formatDateKey(year, month, day);
}

function isOpenFortnight(weekStart, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  return normalizeFortnightStart(weekStart) === fortnightStartForDate(now, timeZone);
}

module.exports = {
  DEFAULT_TIME_ZONE,
  fortnightStartForDate,
  normalizeFortnightStart,
  isOpenFortnight,
};
