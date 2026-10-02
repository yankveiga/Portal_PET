/*
 * ARQUIVO: scripts/run-notifications.js
 * FUNCAO: executa manualmente o sweep de notificacoes por e-mail.
 */
const database = require("../src/database");
const { config } = require("../src/config");
const { createNotificationService } = require("../src/services/notificationService");

async function main() {
  (await database.ensureSchema());
  const service = createNotificationService({ database, config });
  const result = await service.runDeadlineSweep();
  console.log("Sweep concluido:", result);
}

main().catch((error) => {
  console.error("Falha ao executar sweep de notificacoes:", error);
  process.exitCode = 1;
}).finally(() => require("../src/postgres").closePool());
