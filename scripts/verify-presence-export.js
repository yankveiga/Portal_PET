const assert = require("node:assert/strict");
const { buildPresenceCsv } = require("../src/services/presenceExportService");

const events = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Evento ${i + 1}` }));
const row = {
  name: 'Ana, "Silva"', email: "ana@example.com", cpf: "00123456789", badge_code: "001",
  presenceByEventId: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: false, 99: true },
};
const csv = buildPresenceCsv({ events, rows: [row] });
assert.ok(csv.startsWith("\uFEFFNOME,EMAIL,CPF,CRACHA,"));
assert.ok(csv.includes('"Ana, ""Silva""",ana@example.com,00123456789,001,'));
assert.ok(csv.endsWith('Presente,Presente,Presente,Presente,Presente,Presente,Presente,Ausente,Ausente,Ausente,7,10,"70,00%"'));
assert.ok(buildPresenceCsv({ events: events.slice(0, 3), rows: [{ ...row, presenceByEventId: { 1: true } }] }).endsWith('1,3,"33,33%"'));
assert.ok(buildPresenceCsv({ events, rows: [{ ...row, presenceByEventId: {} }] }).endsWith('0,10,"0,00%"'));
assert.ok(buildPresenceCsv({ events, rows: [{ ...row, presenceByEventId: Object.fromEntries(events.map(e => [e.id, true])) }] }).endsWith('10,10,"100,00%"'));
assert.ok(buildPresenceCsv({ events: [], rows: [row] }).endsWith('0,0,"0,00%"'));
assert.equal(buildPresenceCsv({ events: [], rows: [] }), "\uFEFFNOME,EMAIL,CPF,CRACHA,TOTAL_PRESENCAS,TOTAL_EVENTOS,PERCENTUAL_PRESENCA");
const escaped = buildPresenceCsv({ events: [{ id: 1, name: 'Palestra, "A"\nB' }, { id: 2, name: 'Palestra, "A"\nB' }], rows: [{ ...row, name: "=1+1", email: "+danger@example.com" }] });
assert.ok(escaped.includes('"Palestra, ""A""\nB [ID 1]","Palestra, ""A""\nB [ID 2]"'));
assert.ok(escaped.includes("\r\n'=1+1,'+danger@example.com,"));
console.log("OK: CSV geral, percentuais, ausência de eventos, caracteres especiais e texto seguro para planilhas.");
