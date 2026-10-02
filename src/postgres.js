const { Pool } = require("pg");
const { AsyncLocalStorage } = require("node:async_hooks");
require("./config");

let pool;
const transactions = new AsyncLocalStorage();

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL nao configurada.");
    pool = new Pool({
      connectionString,
      max: Math.max(1, Number(process.env.PG_POOL_MAX) || 6),
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      options: process.env.PGOPTIONS || "-c timezone=America/Sao_Paulo",
      ssl: connectionString.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
    });
    pool.on("error", (error) => console.error("[postgres] Conexao ociosa encerrada:", error.code));
  }
  return pool;
}

async function query(sql, values = []) {
  const started = Date.now();
  try {
    return await (transactions.getStore() || getPool()).query(sql, values);
  } finally {
    const threshold = Number(process.env.DB_SLOW_QUERY_MS) || 0;
    if (threshold > 0 && Date.now() - started >= threshold) {
      console.warn(`[db] ${Date.now() - started}ms; operacao=${String(sql).trim().split(/\s+/)[0]}`);
    }
  }
}

// Helpers chamados dentro da transacao reutilizam a mesma conexao.
async function withTransaction(callback) {
  if (transactions.getStore()) return callback();
  const client = await getPool().connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    // Mantem a exclusao mutua das operacoes legadas de leitura seguida de escrita.
    // O lock pertence a transacao e e liberado tambem em rollback/desconexao.
    await client.query("SELECT pg_advisory_xact_lock(73628491)");
    const result = await transactions.run(client, callback);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}

async function closePool() {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

module.exports = { query, withTransaction, closePool };
