// CSV geral: cada evento cadastrado participa do denominador, mesmo sem vínculo.
function escapeCsvCell(value) {
  let text = String(value ?? "");
  // Dados de cadastro devem ser texto, nunca fórmulas executadas pela planilha.
  if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildPresenceCsv({ events, rows }) {
  const header = [
    "NOME", "EMAIL", "CPF", "CRACHA",
    ...events.map(event => `${event.name} [ID ${event.id}]`),
    "TOTAL_PRESENCAS", "TOTAL_EVENTOS", "PERCENTUAL_PRESENCA",
  ];
  const lines = [header.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    const presence = events.map(event => Boolean(row.presenceByEventId[event.id]));
    const attended = presence.filter(Boolean).length;
    const percentage = events.length ? attended / events.length * 100 : 0;
    lines.push([
      row.name, row.email, row.cpf, row.badge_code,
      ...presence.map(present => present ? "Presente" : "Ausente"),
      attended, events.length, `${percentage.toFixed(2).replace(".", ",")}%`,
    ].map(escapeCsvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

module.exports = { buildPresenceCsv };
