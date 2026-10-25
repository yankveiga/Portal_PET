const assert = require("node:assert/strict");
const {
  fortnightStartForDate,
  normalizeFortnightStart,
  isOpenFortnight,
} = require("../src/services/fortnightService");

const zone = "America/Sao_Paulo";
assert.equal(fortnightStartForDate(new Date("2026-01-16T02:59:59Z"), zone), "2026-01-01");
assert.equal(fortnightStartForDate(new Date("2026-01-16T03:00:00Z"), zone), "2026-01-16");
assert.equal(fortnightStartForDate(new Date("2026-02-01T02:59:59Z"), zone), "2026-01-16");
assert.equal(fortnightStartForDate(new Date("2026-02-01T03:00:00Z"), zone), "2026-02-01");
assert.equal(normalizeFortnightStart("2026-02-16"), "2026-02-16");
assert.equal(normalizeFortnightStart("2026-02-15"), null);
assert.equal(isOpenFortnight("2026-12-16", { now: new Date("2027-01-01T02:00:00Z"), timeZone: zone }), true);
console.log("Calendário quinzenal: OK");
