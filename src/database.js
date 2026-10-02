const asyncArray = require("./asyncArray");
/*
 * ARQUIVO: src/database.js
 * FUNCAO: camada de persistencia PostgreSQL/Neon (schema, consultas, insercoes e atualizacoes de dados de dominio).
 * IMPACTO DE MUDANCAS:
 * - Qualquer ajuste de schema exige compatibilidade com dados existentes e consultas ja usadas no app.
 * - Mudancas em regras de normalizacao/validacao podem alterar dados gravados e relatorios gerados.
 * - Mudancas em nomes de colunas/joins afetam telas, filtros e exportacoes.
 */
const postgres = require("./postgres");

const { config } = require("./config");
const { firstNamesSummary } = require("./utils");

// ESTADO GLOBAL: instancia unica do adaptador de banco para a aplicacao.
let database;
let schemaEnsured = false;
// Timezone compartilhada pelas regras de datas da aplicacao.
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Sao_Paulo";





// FUNCAO: toPostgresSql.
function toPostgresSql(sql) {
  let index = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let output = "";

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const previous = i > 0 ? sql[i - 1] : "";

    if (char === "'" && previous !== "\\" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      output += char;
      continue;
    }

    if (char === '"' && previous !== "\\" && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      output += char;
      continue;
    }

    if (char === "?" && !inSingleQuote && !inDoubleQuote) {
      output += `$${index}`;
      index += 1;
      continue;
    }

    output += char;
  }

  // "user" e palavra reservada no Postgres; quote apenas quando usado como nome de tabela.
  return output
    .replace(/\bFROM\s+user\b/gi, 'FROM "user"')
    .replace(/\bJOIN\s+user\b/gi, 'JOIN "user"')
    .replace(/\bINTO\s+user\b/gi, 'INTO "user"')
    .replace(/\bUPDATE\s+user\b/gi, 'UPDATE "user"')
    .replace(/\bTABLE\s+user\b/gi, 'TABLE "user"')
    .replace(/\bREFERENCES\s+user\b/gi, 'REFERENCES "user"');
}








// SECAO: constantes de dominio e restricoes de valores aceitos no banco.

const USER_ROLES = new Set(["admin", "tutor", "common"]);
const INVENTORY_TYPES = new Set(["stock", "patrimony"]);
const DEFAULT_PROJECT_COLOR = "#0b6bcb";
const REPORT_STATUSES = new Set(["completed", "in_progress", "blocked"]);
const PLANNER_STATUSES = new Set(["todo", "in_progress", "done"]);
const PLANNER_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const PLANNER_RECURRENCE_UNITS = new Set(["days", "weeks", "months"]);
const PLANNER_WORKFLOW_STATES = new Set(["active", "missed"]);

// SECAO: normalizadores e utilitarios basicos usados antes de persistir dados.

// FUNCAO: normalizeInventoryType.
function normalizeInventoryType(value) {
  return INVENTORY_TYPES.has(value) ? value : "stock";
}

// FUNCAO: normalizeProjectColor.
function normalizeProjectColor(value) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized)
    ? normalized.toLowerCase()
    : DEFAULT_PROJECT_COLOR;
}

// FUNCAO: normalizeReportStatus.
function normalizeReportStatus(value) {
  return REPORT_STATUSES.has(value) ? value : "in_progress";
}

// FUNCAO: normalizePlannerStatus.
function normalizePlannerStatus(value) {
  return PLANNER_STATUSES.has(value) ? value : "todo";
}

// FUNCAO: normalizePlannerPriority.
function normalizePlannerPriority(value) {
  return PLANNER_PRIORITIES.has(value) ? value : "medium";
}

// FUNCAO: normalizePlannerRecurrenceUnit.
function normalizePlannerRecurrenceUnit(value) {
  return PLANNER_RECURRENCE_UNITS.has(value) ? value : null;
}

// FUNCAO: normalizePlannerWorkflowState.
function normalizePlannerWorkflowState(value) {
  return PLANNER_WORKFLOW_STATES.has(value) ? value : "active";
}

// FUNCAO: toSqlDateTime.
function toSqlDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const valueByType = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      valueByType[part.type] = part.value;
    }
  });

  return `${valueByType.year}-${valueByType.month}-${valueByType.day} ${valueByType.hour}:${valueByType.minute}:${valueByType.second}`;
}

// FUNCAO: fromSqlDateTime.
function fromSqlDateTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function addDaysToDateKey(dateKey, days) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function reportDueGraceDeadlineSql(dueAt, graceDays = 0) {
  const dateKey = String(dueAt || "").slice(0, 10);
  const deadlineDateKey = addDaysToDateKey(dateKey, graceDays);
  const fortnightEndDateKey = resolveFortnightEndFromDateKey(dateKey);
  const effectiveDateKey = [deadlineDateKey, fortnightEndDateKey]
    .filter(Boolean)
    .sort()
    .pop();
  return effectiveDateKey ? `${effectiveDateKey} 23:59:59` : null;
}

function isReportDueOverdue(dueAt, nowSql, graceDays = 0) {
  const deadlineSql = reportDueGraceDeadlineSql(dueAt, graceDays);
  return Boolean(deadlineSql && nowSql && deadlineSql < nowSql);
}

// FUNCAO: resolveFortnightStartFromSqlDateTime.
function resolveFortnightStartFromSqlDateTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return null;
  }

  const day = Number(match[3]);
  const fortnightStart = day <= 15 ? "01" : "16";
  return `${match[1]}-${match[2]}-${fortnightStart}`;
}

function resolveFortnightEndFromDateKey(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  if (day <= 15) {
    return `${match[1]}-${match[2]}-15`;
  }

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`;
}

// FUNCAO: addDaysToNow.
function addDaysToNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toSqlDateTime(date);
}

// SECAO: conexao PostgreSQL/Neon e garantia incremental de schema.

// FUNCAO: getDb.
function getDb() {
  if (!database) {
    database = createDbAdapter();
  }

  return database;
}

// FUNCAO: ensureColumn.
async function ensureColumn(tableName, columnName, definition) {
  const exists = (await postgres.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName],
  ));

  if (!exists.rows.length) {
    (await postgres.query(`ALTER TABLE ${tableName === "user" ? '"user"' : tableName} ADD COLUMN ${columnName} ${definition}`));
  }
}

// FUNCAO: ensureSchema.
async function ensureSchema() {
  if (schemaEnsured) {
    return;
  }

  const db = getDb();

  (await db.exec(`
    CREATE TABLE IF NOT EXISTS member (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      photo TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS "user" (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'admin',
      member_id INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      deactivated_at TEXT,
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS project (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      logo TEXT,
      primary_color TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_COLOR}'
    );

    CREATE TABLE IF NOT EXISTS ata (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      meeting_datetime TEXT NOT NULL,
      location_type TEXT,
      location_details TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      project_id INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES project(id)
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      is_coordinator INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, member_id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS ata_present_members (
      ata_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      PRIMARY KEY (ata_id, member_id),
      FOREIGN KEY (ata_id) REFERENCES ata(id),
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS ata_absent_justification (
      ata_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      justification TEXT NOT NULL,
      PRIMARY KEY (ata_id, member_id),
      FOREIGN KEY (ata_id) REFERENCES ata(id),
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS report_entry (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      project_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      created_by_user_id INTEGER,
      week_start TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS report_week_goal (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      member_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      created_by_user_id INTEGER,
      week_start TEXT NOT NULL,
      due_at TEXT,
      activity TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      planner_task_id INTEGER,
      goal_source TEXT NOT NULL DEFAULT 'manual',
      task_state TEXT NOT NULL DEFAULT 'active',
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      completed_late INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS report_week_goal_deletion_log (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      goal_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      deleted_by_user_id INTEGER NOT NULL,
      week_start TEXT NOT NULL,
      activity TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      deletion_reason TEXT,
      deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (deleted_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS planner_task (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      project_id INTEGER NOT NULL,
      assigned_member_id INTEGER NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      label TEXT,
      due_at TEXT NOT NULL,
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      completed_late INTEGER NOT NULL DEFAULT 0,
      workflow_state TEXT NOT NULL DEFAULT 'active',
      missed_at TEXT,
      last_extended_at TEXT,
      last_extended_by_user_id INTEGER,
      recurrence_interval_days INTEGER,
      recurrence_unit TEXT,
      recurrence_every INTEGER,
      recurrence_member_queue TEXT,
      recurrence_next_index INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (assigned_member_id) REFERENCES member(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id),
      FOREIGN KEY (last_extended_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS planner_task_completion_log (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      task_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      assigned_member_id INTEGER NOT NULL,
      completed_by_user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      priority TEXT NOT NULL DEFAULT 'medium',
      label TEXT,
      due_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES planner_task(id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (assigned_member_id) REFERENCES member(id),
      FOREIGN KEY (completed_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS task_audit_log (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      task_id INTEGER,
      report_goal_id INTEGER,
      member_id INTEGER,
      project_id INTEGER,
      event_type TEXT NOT NULL,
      actor_user_id INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS estoque (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'stock',
      category TEXT NOT NULL,
      category_id INTEGER,
      location TEXT,
      location_id INTEGER,
      amount INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedido (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      qtd_retirada INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      estoque_id INTEGER NOT NULL,
      data_pedido TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES user(id),
      FOREIGN KEY (estoque_id) REFERENCES estoque(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_category (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS inventory_location (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS inventory_loan (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      item_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      borrowed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      original_due_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      returned_at TEXT,
      extended_at TEXT,
      extended_by_user_id INTEGER,
      returned_by_user_id INTEGER,
      FOREIGN KEY (item_id) REFERENCES estoque(id),
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (extended_by_user_id) REFERENCES user(id),
      FOREIGN KEY (returned_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS writing_general_entry (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (author_user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS writing_tutor_private_entry (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tutor_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (tutor_user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS chat_conversation (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      title TEXT,
      created_by_user_id INTEGER NOT NULL,
      conversation_kind TEXT NOT NULL DEFAULT 'direct',
      theme_color TEXT,
      avatar_url TEXT,
      is_read_only INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (created_by_user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS report_fortnight_tutor_note (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      tutor_user_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      week_start TEXT NOT NULL,
      content TEXT NOT NULL,
      sent_to_chat_at TEXT,
      sent_to_chat_conversation_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      UNIQUE (tutor_user_id, member_id, week_start),
      FOREIGN KEY (tutor_user_id) REFERENCES "user"(id),
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (sent_to_chat_conversation_id) REFERENCES chat_conversation(id)
    );

    CREATE TABLE IF NOT EXISTS report_fortnight_member_note (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      member_id INTEGER NOT NULL,
      author_user_id INTEGER NOT NULL,
      target_tutor_user_id INTEGER,
      week_start TEXT NOT NULL,
      content TEXT NOT NULL,
      sent_to_chat_at TEXT,
      sent_to_chat_conversation_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      UNIQUE (member_id, week_start),
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (author_user_id) REFERENCES "user"(id),
      FOREIGN KEY (target_tutor_user_id) REFERENCES "user"(id),
      FOREIGN KEY (sent_to_chat_conversation_id) REFERENCES chat_conversation(id)
    );

    CREATE TABLE IF NOT EXISTS chat_conversation_participant (
      conversation_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_read_at TEXT,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES chat_conversation(id),
      FOREIGN KEY (user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS chat_message (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      author_user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES chat_conversation(id),
      FOREIGN KEY (author_user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS notification_email_delivery (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      kind TEXT NOT NULL,
      recipient_user_id INTEGER NOT NULL,
      reference_key TEXT NOT NULL,
      payload_json TEXT,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (kind, recipient_user_id, reference_key),
      FOREIGN KEY (recipient_user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS member_warning_event (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      member_id INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL,
      previous_count INTEGER NOT NULL,
      new_count INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (actor_user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS member_warning_restriction (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      member_id INTEGER NOT NULL,
      started_by_user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (started_by_user_id) REFERENCES "user"(id)
    );

    CREATE TABLE IF NOT EXISTS member_warning_cycle (
      cycle_date TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS event (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      event_date TEXT,
      location TEXT,
      description TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS attendee (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      cpf TEXT,
      email TEXT,
      badge_code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS event_attendee (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_id INTEGER NOT NULL,
      attendee_id INTEGER,
      name TEXT NOT NULL,
      cpf TEXT,
      email TEXT,
      badge_code TEXT NOT NULL,
      registration_number TEXT,
      course TEXT,
      institution TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      UNIQUE (event_id, badge_code),
      UNIQUE (event_id, attendee_id),
      FOREIGN KEY (event_id) REFERENCES event(id)
    );

    CREATE TABLE IF NOT EXISTS event_attendance (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_id INTEGER NOT NULL,
      attendee_id INTEGER NOT NULL,
      checked_in_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checked_in_by_user_id INTEGER,
      method TEXT NOT NULL DEFAULT 'scan',
      UNIQUE (event_id, attendee_id),
      FOREIGN KEY (event_id) REFERENCES event(id),
      FOREIGN KEY (attendee_id) REFERENCES event_attendee(id),
      FOREIGN KEY (checked_in_by_user_id) REFERENCES "user"(id)
    );

    CREATE INDEX IF NOT EXISTS ix_member_name ON member(name);
    CREATE INDEX IF NOT EXISTS ix_member_is_active ON member(is_active);
    CREATE INDEX IF NOT EXISTS ix_project_name ON project(name);
    CREATE INDEX IF NOT EXISTS ix_user_username ON "user"(username);
    CREATE INDEX IF NOT EXISTS ix_ata_meeting_datetime ON ata(meeting_datetime);
    CREATE INDEX IF NOT EXISTS ix_report_entry_project_id ON report_entry(project_id);
    CREATE INDEX IF NOT EXISTS ix_report_entry_member_id ON report_entry(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_entry_week_start ON report_entry(week_start);
    CREATE INDEX IF NOT EXISTS ix_report_entry_created_at ON report_entry(created_at);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_member_id ON report_week_goal(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_project_id ON report_week_goal(project_id);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_week_start ON report_week_goal(week_start);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_completed ON report_week_goal(is_completed);
    CREATE INDEX IF NOT EXISTS ix_report_goal_deletion_member_id ON report_week_goal_deletion_log(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_goal_deletion_project_id ON report_week_goal_deletion_log(project_id);
    CREATE INDEX IF NOT EXISTS ix_report_goal_deletion_deleted_at ON report_week_goal_deletion_log(deleted_at);
    CREATE INDEX IF NOT EXISTS ix_planner_task_project_id ON planner_task(project_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_assigned_member_id ON planner_task(assigned_member_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_due_at ON planner_task(due_at);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completed ON planner_task(is_completed);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_task_id ON planner_task_completion_log(task_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_project_id ON planner_task_completion_log(project_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_member_id ON planner_task_completion_log(assigned_member_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_completed_at ON planner_task_completion_log(completed_at);
    CREATE INDEX IF NOT EXISTS ix_estoque_name ON estoque(name);
    CREATE INDEX IF NOT EXISTS ix_estoque_type_name ON estoque(item_type, name, id);
    CREATE INDEX IF NOT EXISTS ix_estoque_item_type ON estoque(item_type);
    CREATE INDEX IF NOT EXISTS ix_estoque_category_id ON estoque(category_id);
    CREATE INDEX IF NOT EXISTS ix_estoque_location_id ON estoque(location_id);
    CREATE INDEX IF NOT EXISTS ix_pedido_usuario_id ON pedido(usuario_id);
    CREATE INDEX IF NOT EXISTS ix_pedido_estoque_id ON pedido(estoque_id);
    CREATE INDEX IF NOT EXISTS ix_pedido_data_id ON pedido(data_pedido, id);
    CREATE INDEX IF NOT EXISTS ix_inventory_category_name ON inventory_category(name);
    CREATE INDEX IF NOT EXISTS ix_inventory_location_name ON inventory_location(name);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_item_id ON inventory_loan(item_id);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_user_id ON inventory_loan(user_id);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_due_at ON inventory_loan(due_at);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_returned_at ON inventory_loan(returned_at);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_open_due ON inventory_loan(returned_at, due_at, id);
    CREATE INDEX IF NOT EXISTS ix_writing_general_author ON writing_general_entry(author_user_id);
    CREATE INDEX IF NOT EXISTS ix_writing_general_created_at ON writing_general_entry(created_at);
    CREATE INDEX IF NOT EXISTS ix_writing_tutor_author ON writing_tutor_private_entry(tutor_user_id);
    CREATE INDEX IF NOT EXISTS ix_writing_tutor_created_at ON writing_tutor_private_entry(created_at);
    CREATE INDEX IF NOT EXISTS ix_report_fortnight_note_tutor ON report_fortnight_tutor_note(tutor_user_id);
    CREATE INDEX IF NOT EXISTS ix_report_fortnight_note_member ON report_fortnight_tutor_note(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_fortnight_note_week ON report_fortnight_tutor_note(week_start);
    CREATE INDEX IF NOT EXISTS ix_report_member_note_member ON report_fortnight_member_note(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_member_note_week ON report_fortnight_member_note(week_start);
    CREATE INDEX IF NOT EXISTS ix_report_member_note_tutor ON report_fortnight_member_note(target_tutor_user_id);
    CREATE INDEX IF NOT EXISTS ix_chat_conversation_created_by ON chat_conversation(created_by_user_id);
    CREATE INDEX IF NOT EXISTS ix_chat_conversation_updated_at ON chat_conversation(updated_at);
    CREATE INDEX IF NOT EXISTS ix_chat_participant_user ON chat_conversation_participant(user_id);
    CREATE INDEX IF NOT EXISTS ix_chat_message_conversation ON chat_message(conversation_id);
    CREATE INDEX IF NOT EXISTS ix_chat_message_author ON chat_message(author_user_id);
    CREATE INDEX IF NOT EXISTS ix_chat_message_sent_at ON chat_message(sent_at);
    CREATE INDEX IF NOT EXISTS ix_notification_email_kind ON notification_email_delivery(kind);
    CREATE INDEX IF NOT EXISTS ix_notification_email_recipient ON notification_email_delivery(recipient_user_id);
    CREATE INDEX IF NOT EXISTS ix_notification_email_sent_at ON notification_email_delivery(sent_at);
    CREATE INDEX IF NOT EXISTS ix_event_active ON event(is_active);
    CREATE INDEX IF NOT EXISTS ix_event_date ON event(event_date);
    CREATE INDEX IF NOT EXISTS ix_event_attendee_event ON event_attendee(event_id);
    CREATE INDEX IF NOT EXISTS ix_event_attendee_badge ON event_attendee(badge_code);
    CREATE INDEX IF NOT EXISTS ix_attendee_badge ON attendee(badge_code);
    CREATE INDEX IF NOT EXISTS ix_attendee_name ON attendee(name);
    CREATE INDEX IF NOT EXISTS ix_event_attendance_event ON event_attendance(event_id);
    CREATE INDEX IF NOT EXISTS ix_event_attendance_attendee ON event_attendance(attendee_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_task_id ON task_audit_log(task_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_goal_id ON task_audit_log(report_goal_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_member_id ON task_audit_log(member_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_project_id ON task_audit_log(project_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_event_type ON task_audit_log(event_type);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_created_at ON task_audit_log(created_at);
  `));

  (await ensureColumn("ata", "location_type", "TEXT"));
  (await ensureColumn("ata", "location_details", "TEXT"));
  (await ensureColumn("user", "name", "TEXT"));
  (await ensureColumn("user", "email", "TEXT"));
  (await ensureColumn("user", "is_active", "INTEGER NOT NULL DEFAULT 1"));
  (await ensureColumn("user", "deactivated_at", "TEXT"));
  (await ensureColumn("user", "role", "TEXT NOT NULL DEFAULT 'admin'"));
  (await ensureColumn("user", "member_id", "INTEGER"));
  (await ensureColumn("member", "photo", "TEXT"));
  (await ensureColumn("report_entry", "status", "TEXT NOT NULL DEFAULT 'in_progress'"));
  (await ensureColumn("estoque", "location", "TEXT"));
  (await ensureColumn("estoque", "category_id", "INTEGER"));
  (await ensureColumn("estoque", "location_id", "INTEGER"));
  (await ensureColumn("estoque", "item_type", "TEXT NOT NULL DEFAULT 'stock'"));
  (await ensureColumn("project", "primary_color", `TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_COLOR}'`));
  (await ensureColumn("project_members", "is_coordinator", "INTEGER NOT NULL DEFAULT 0"));
  (await ensureColumn("report_week_goal", "planner_task_id", "INTEGER"));
  (await ensureColumn("report_week_goal", "goal_source", "TEXT NOT NULL DEFAULT 'manual'"));
  (await ensureColumn("planner_task", "status", "TEXT NOT NULL DEFAULT 'todo'"));
  (await ensureColumn("planner_task", "priority", "TEXT NOT NULL DEFAULT 'medium'"));
  (await ensureColumn("planner_task", "label", "TEXT"));
  (await ensureColumn("planner_task", "workflow_state", "TEXT NOT NULL DEFAULT 'active'"));
  (await ensureColumn("planner_task", "missed_at", "TEXT"));
  (await ensureColumn("planner_task", "last_extended_at", "TEXT"));
  (await ensureColumn("planner_task", "last_extended_by_user_id", "INTEGER"));
  (await ensureColumn("planner_task", "recurrence_interval_days", "INTEGER"));
  (await ensureColumn("planner_task", "recurrence_unit", "TEXT"));
  (await ensureColumn("planner_task", "recurrence_every", "INTEGER"));
  (await ensureColumn("planner_task", "recurrence_member_queue", "TEXT"));
  (await ensureColumn("planner_task", "recurrence_next_index", "INTEGER"));
  (await ensureColumn("task_audit_log", "member_id", "INTEGER"));
  (await ensureColumn("task_audit_log", "project_id", "INTEGER"));
  (await ensureColumn("report_fortnight_tutor_note", "sent_to_chat_at", "TEXT"));
  (await ensureColumn("report_fortnight_tutor_note", "sent_to_chat_conversation_id", "INTEGER"));
  (await ensureColumn("report_fortnight_member_note", "sent_to_chat_at", "TEXT"));
  (await ensureColumn("report_fortnight_member_note", "sent_to_chat_conversation_id", "INTEGER"));
  (await ensureColumn("report_week_goal", "due_at", "TEXT"));
  (await ensureColumn("report_week_goal", "task_state", "TEXT NOT NULL DEFAULT 'active'"));
  (await ensureColumn("report_week_goal", "completed_late", "INTEGER NOT NULL DEFAULT 0"));
  (await ensureColumn("report_week_goal_deletion_log", "deletion_reason", "TEXT"));
  (await ensureColumn("planner_task", "completed_late", "INTEGER NOT NULL DEFAULT 0"));
  (await ensureColumn("chat_conversation_participant", "last_read_at", "TEXT"));
  (await ensureColumn("chat_conversation", "conversation_kind", "TEXT NOT NULL DEFAULT 'direct'"));
  (await ensureColumn("chat_conversation", "theme_color", "TEXT"));
  (await ensureColumn("chat_conversation", "avatar_url", "TEXT"));
  (await ensureColumn("chat_conversation", "is_read_only", "INTEGER NOT NULL DEFAULT 0"));
  (await ensureColumn("event_attendee", "cpf", "TEXT"));
  (await ensureColumn("event_attendee", "attendee_id", "INTEGER"));
  (await ensureColumn("member_warning_event", "event_type", "TEXT NOT NULL DEFAULT 'count_changed'"));
  (await ensureColumn("member_warning_event", "target_event_id", "INTEGER REFERENCES member_warning_event(id)"));
  (await ensureColumn("member_warning_event", "previous_note", "TEXT"));

  (await db.exec(`
    INSERT INTO attendee (name, cpf, email, badge_code)
    SELECT
      MIN(name) AS name,
      MIN(cpf) AS cpf,
      MIN(email) AS email,
      badge_code
    FROM event_attendee
    WHERE badge_code IS NOT NULL
      AND TRIM(badge_code) <> ''
    GROUP BY badge_code
    ON CONFLICT (badge_code) DO NOTHING;

    UPDATE event_attendee ea
    SET attendee_id = a.id
    FROM attendee a
    WHERE ea.attendee_id IS NULL
      AND ea.badge_code = a.badge_code;
  `));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_status ON planner_task(status)"));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_priority ON planner_task(priority)"));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_workflow_state ON planner_task(workflow_state)"));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_missed_at ON planner_task(missed_at)"));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_completed_late ON planner_task(completed_late)"));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_report_week_goal_due_at ON report_week_goal(due_at)"));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_report_week_goal_task_state ON report_week_goal(task_state)"));
  (await getDb().exec("CREATE INDEX IF NOT EXISTS ix_report_week_goal_completed_late ON report_week_goal(completed_late)"));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_project_members_project_coordinator ON project_members(project_id, is_coordinator)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_project_members_member_project_coordinator ON project_members(member_id, project_id, is_coordinator)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_planner_task_project_open_due ON planner_task(project_id, is_completed, due_at)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_planner_task_member_open_due ON planner_task(assigned_member_id, is_completed, due_at)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_planner_task_active_due ON planner_task(workflow_state, is_completed, due_at)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_report_week_goal_member_project_week ON report_week_goal(member_id, project_id, week_start)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_chat_participant_conversation_user ON chat_conversation_participant(conversation_id, user_id)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_chat_message_conversation_author_sent ON chat_message(conversation_id, author_user_id, sent_at)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_member_warning_event_member_created ON member_warning_event(member_id, created_at, id)",
  ));
  (await getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_member_warning_restriction_member_started ON member_warning_restriction(member_id, started_at, id)",
  ));
  (await getDb().exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_report_week_goal_planner_task_id ON report_week_goal(planner_task_id) WHERE planner_task_id IS NOT NULL",
  ));
  (await getDb().exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_user_email_lower ON \"user\"(LOWER(email)) WHERE email IS NOT NULL AND LENGTH(TRIM(email)) > 0",
  ));

  (await db.prepare(
    `
    UPDATE estoque
    SET item_type = CASE
      WHEN item_type IN ('stock', 'patrimony') THEN item_type
      ELSE 'stock'
    END
  `,
  ).run());

  (await db.prepare(
    `
    UPDATE user
    SET
      name = COALESCE(NULLIF(TRIM(name), ''), username),
      email = NULLIF(LOWER(TRIM(email)), ''),
      role = CASE
        WHEN role IN ('admin', 'tutor', 'common') THEN role
        ELSE 'admin'
      END
  `,
  ).run());

  (await db.prepare(
    `
    UPDATE planner_task
    SET
      status = CASE
        WHEN status IN ('todo', 'in_progress', 'done') THEN status
        ELSE 'todo'
      END,
      priority = CASE
        WHEN priority IN ('low', 'medium', 'high', 'urgent') THEN priority
        ELSE 'medium'
      END,
      recurrence_unit = CASE
        WHEN recurrence_unit IN ('days', 'weeks', 'months') THEN recurrence_unit
        ELSE NULL
      END,
      workflow_state = CASE
        WHEN workflow_state IN ('active', 'missed') THEN workflow_state
        ELSE 'active'
      END,
      completed_late = CASE
        WHEN completed_late IN (0, 1) THEN completed_late
        ELSE 0
      END,
      recurrence_every = CASE
        WHEN recurrence_every IS NOT NULL AND recurrence_every >= 1 THEN recurrence_every
        ELSE NULL
      END
  `,
  ).run());

  (await db.exec(`
    INSERT INTO inventory_category (name)
    SELECT DISTINCT TRIM(category)
    FROM estoque
    WHERE category IS NOT NULL AND TRIM(category) <> ''
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO inventory_location (name)
    SELECT DISTINCT TRIM(location)
    FROM estoque
    WHERE location IS NOT NULL AND TRIM(location) <> ''
    ON CONFLICT (name) DO NOTHING;
  `));

  (await db.prepare(
    `
    UPDATE estoque
    SET category_id = (
      SELECT ic.id
      FROM inventory_category ic
      WHERE LOWER(ic.name) = LOWER(estoque.category)
      LIMIT 1
    )
    WHERE category_id IS NULL
      AND category IS NOT NULL
      AND TRIM(category) <> ''
  `,
  ).run());

  (await db.prepare(
    `
    UPDATE estoque
    SET location_id = (
      SELECT il.id
      FROM inventory_location il
      WHERE LOWER(il.name) = LOWER(estoque.location)
      LIMIT 1
    )
    WHERE location_id IS NULL
      AND location IS NOT NULL
      AND TRIM(location) <> ''
  `,
  ).run());

  (await db.prepare(
    `
    UPDATE project
    SET primary_color = CASE
      WHEN primary_color ~* '^#[0-9a-f]{6}$' THEN LOWER(primary_color)
      ELSE ?
    END
  `,
  ).run(DEFAULT_PROJECT_COLOR));

  (await db.prepare(
    `
    UPDATE report_entry
    SET status = CASE
      WHEN status IN ('completed', 'in_progress', 'blocked') THEN status
      ELSE 'in_progress'
    END
  `,
  ).run());

  (await db.prepare(
    `
    UPDATE report_week_goal
    SET goal_source = CASE
      WHEN goal_source IN ('manual', 'planner') THEN goal_source
      ELSE 'manual'
    END
  `,
  ).run());

  (await db.prepare(
    `
    UPDATE report_week_goal
    SET task_state = CASE
      WHEN task_state IN ('active', 'missed') THEN task_state
      ELSE 'active'
    END
  `,
  ).run());

  (await db.prepare(
    `
    UPDATE report_week_goal
    SET completed_late = CASE
      WHEN completed_late IN (0, 1) THEN completed_late
      ELSE 0
    END
  `,
  ).run());

  (await repairFortnightOnTimeCompletions(db));
  (await repairSubmittedFortnightTasksMarkedMissedEarly(db));
  (await repairPendingFortnightTasksMarkedMissedEarly(db));
  schemaEnsured = true;
}

async function repairFortnightOnTimeCompletions(db = getDb()) {
  const completedLateTasks = (await db
    .prepare(
      `
      SELECT id, due_at, completed_at
      FROM planner_task
      WHERE completed_late = 1
        AND completed_at IS NOT NULL
        AND due_at IS NOT NULL
    `,
    )
    .all());

  const taskIdsToRepair = completedLateTasks
    .filter((task) => {
      const effectiveDeadline = reportDueGraceDeadlineSql(task.due_at);
      return Boolean(effectiveDeadline && task.completed_at <= effectiveDeadline);
    })
    .map((task) => task.id);

  if (taskIdsToRepair.length) {
    const placeholders = taskIdsToRepair.map(() => "?").join(", ");
    (await db.prepare(
      `
      UPDATE planner_task
      SET
        completed_late = 0,
        workflow_state = 'active',
        missed_at = NULL
      WHERE id IN (${placeholders})
    `,
    ).run(...taskIdsToRepair));

    (await db.prepare(
      `
      UPDATE report_week_goal
      SET
        completed_late = 0,
        task_state = 'active'
      WHERE planner_task_id IN (${placeholders})
    `,
    ).run(...taskIdsToRepair));
  }

  const completedLateGoals = (await db
    .prepare(
      `
      SELECT id, due_at, completed_at
      FROM report_week_goal
      WHERE completed_late = 1
        AND completed_at IS NOT NULL
        AND due_at IS NOT NULL
        AND planner_task_id IS NULL
    `,
    )
    .all());

  const goalIdsToRepair = completedLateGoals
    .filter((goal) => {
      const effectiveDeadline = reportDueGraceDeadlineSql(goal.due_at);
      return Boolean(effectiveDeadline && goal.completed_at <= effectiveDeadline);
    })
    .map((goal) => goal.id);

  if (goalIdsToRepair.length) {
    const placeholders = goalIdsToRepair.map(() => "?").join(", ");
    (await db.prepare(
      `
      UPDATE report_week_goal
      SET
        completed_late = 0,
        task_state = 'active'
      WHERE id IN (${placeholders})
    `,
    ).run(...goalIdsToRepair));
  }

  return {
    plannerTasks: taskIdsToRepair.length,
    reportGoals: goalIdsToRepair.length,
  };
}

async function repairPendingFortnightTasksMarkedMissedEarly(db = getDb(), nowSql = toSqlDateTime(new Date())) {
  const missedTasks = (await db
    .prepare(
      `
      SELECT id, due_at
      FROM planner_task
      WHERE is_completed = 0
        AND workflow_state = 'missed'
        AND due_at IS NOT NULL
    `,
    )
    .all());

  const taskIdsToRepair = missedTasks
    .filter((task) => !isReportDueOverdue(task.due_at, nowSql))
    .map((task) => task.id);

  if (taskIdsToRepair.length) {
    const placeholders = taskIdsToRepair.map(() => "?").join(", ");
    (await db.prepare(
      `
      UPDATE planner_task
      SET
        workflow_state = 'active',
        missed_at = NULL
      WHERE id IN (${placeholders})
    `,
    ).run(...taskIdsToRepair));

    (await db.prepare(
      `
      UPDATE report_week_goal
      SET task_state = 'active'
      WHERE planner_task_id IN (${placeholders})
    `,
    ).run(...taskIdsToRepair));
  }

  return { plannerTasks: taskIdsToRepair.length };
}

async function repairSubmittedFortnightTasksMarkedMissedEarly(db = getDb()) {
  const submittedGoals = (await db
    .prepare(
      `
      SELECT
        g.id,
        g.planner_task_id,
        g.due_at,
        g.description,
        g.updated_at
      FROM report_week_goal g
      WHERE g.is_completed = 0
        AND g.task_state = 'missed'
        AND g.due_at IS NOT NULL
        AND g.updated_at IS NOT NULL
        AND LENGTH(TRIM(g.description)) >= 10
    `,
    )
    .all());

  const goalsToRepair = submittedGoals.filter((goal) => {
    const effectiveDeadline = reportDueGraceDeadlineSql(goal.due_at);
    return Boolean(effectiveDeadline && goal.updated_at <= effectiveDeadline);
  });

  if (!goalsToRepair.length) {
    return { reportGoals: 0, plannerTasks: 0 };
  }

  (await asyncArray.forEach(goalsToRepair, async (goal) => {
    const completedAt = String(goal.updated_at).replace(/(\.\d+)?[-+]\d{2}(?::?\d{2})?$/, "");
    (await db.prepare(
      `
      UPDATE report_week_goal
      SET
        is_completed = 1,
        completed_at = ?,
        completed_late = 0,
        task_state = 'active'
      WHERE id = ?
    `,
    ).run(completedAt, goal.id));

    if (goal.planner_task_id) {
      (await db.prepare(
        `
        UPDATE planner_task
        SET
          is_completed = 1,
          status = 'done',
          workflow_state = 'active',
          completed_at = ?,
          completed_late = 0,
          missed_at = NULL
        WHERE id = ?
      `,
      ).run(completedAt, goal.planner_task_id));
    }
  }));

  return {
    reportGoals: goalsToRepair.length,
    plannerTasks: goalsToRepair.filter((goal) => goal.planner_task_id).length,
  };
}

// SECAO: transacoes e mapeadores de linhas (SQL -> objetos de dominio).

// FUNCAO: withTransaction.


// FUNCAO: mapMember.
function mapMember(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    photo: row.photo || null,
    is_active: Boolean(row.is_active),
    is_coordinator: Boolean(row.is_coordinator),
  };
}

// FUNCAO: mapUser.
function mapUser(row) {
  if (!row) {
    return null;
  }

  const role = USER_ROLES.has(row.role) ? row.role : "admin";
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    name: row.name || row.username,
    email: row.email || null,
    member_id: row.member_id || null,
    member_name: row.member_name || null,
    is_active: row.is_active === undefined ? true : Boolean(row.is_active),
    deactivated_at: row.deactivated_at || null,
    role,
    is_admin: role === "admin" || role === "tutor",
  };
}

function mapWritingGeneralEntry(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    author_user_id: row.author_user_id,
    author_username: row.author_username || "",
    author_name: row.author_name || row.author_username || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function mapWritingTutorPrivateEntry(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tutor_user_id: row.tutor_user_id,
    tutor_username: row.tutor_username || "",
    tutor_name: row.tutor_name || row.tutor_username || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function mapReportFortnightTutorNote(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    tutor_user_id: row.tutor_user_id,
    member_id: row.member_id,
    week_start: row.week_start || "",
    content: row.content || "",
    sent_to_chat_at: row.sent_to_chat_at || null,
    sent_to_chat_conversation_id: row.sent_to_chat_conversation_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    tutor_name: row.tutor_name || row.tutor_username || "",
    tutor_username: row.tutor_username || "",
    member_name: row.member_name || "",
  };
}

function mapReportFortnightMemberNote(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    member_id: row.member_id,
    author_user_id: row.author_user_id,
    target_tutor_user_id: row.target_tutor_user_id || null,
    week_start: row.week_start || "",
    content: row.content || "",
    sent_to_chat_at: row.sent_to_chat_at || null,
    sent_to_chat_conversation_id: row.sent_to_chat_conversation_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    member_name: row.member_name || "",
    author_name: row.author_name || row.author_username || "",
    author_username: row.author_username || "",
    target_tutor_name: row.target_tutor_name || row.target_tutor_username || "",
    target_tutor_username: row.target_tutor_username || "",
  };
}

// FUNCAO: mapProject.
function mapProject(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    logo: row.logo || null,
    primary_color: normalizeProjectColor(row.primary_color),
  };
}

// FUNCAO: mapAta.
function mapAta(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    meeting_datetime: row.meeting_datetime,
    location_type: row.location_type || null,
    location_details: row.location_details || null,
    notes: row.notes || "",
    created_at: row.created_at || null,
    project_id: row.project_id,
  };
}

// FUNCAO: mapReportEntry.
function mapReportEntry(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    project_id: row.project_id,
    member_id: row.member_id,
    created_by_user_id: row.created_by_user_id || null,
    week_start: row.week_start,
    status: normalizeReportStatus(row.status),
    content: row.content || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    project: {
      id: row.project_id,
      name: row.project_name,
      logo: row.project_logo || null,
      primary_color: normalizeProjectColor(row.project_primary_color),
    },
    member: {
      id: row.member_id,
      name: row.member_name,
      photo: row.member_photo || null,
      is_active: Boolean(row.member_is_active),
    },
    created_by_user: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          username: row.created_by_username,
          name: row.created_by_name || row.created_by_username,
        }
      : null,
  };
}

// FUNCAO: mapReportWeekGoal.
function mapReportWeekGoal(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    member_id: row.member_id,
    project_id: row.project_id,
    created_by_user_id: row.created_by_user_id || null,
    week_start: row.week_start,
    due_at: row.due_at || null,
    activity: row.activity || "",
    description: row.description || "",
    planner_task_id: row.planner_task_id || null,
    goal_source: row.goal_source === "planner" ? "planner" : "manual",
    task_state: normalizePlannerWorkflowState(row.task_state),
    is_completed: Boolean(row.is_completed),
    completed_at: row.completed_at || null,
    completed_late: Boolean(row.completed_late),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    project: {
      id: row.project_id,
      name: row.project_name,
      logo: row.project_logo || null,
      primary_color: normalizeProjectColor(row.project_primary_color),
    },
    member: {
      id: row.member_id,
      name: row.member_name,
      photo: row.member_photo || null,
      is_active: Boolean(row.member_is_active),
    },
    created_by_user: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          username: row.created_by_username,
          name: row.created_by_name || row.created_by_username,
        }
      : null,
  };
}

// FUNCAO: mapPlannerTask.
function mapPlannerTask(row) {
  if (!row) {
    return null;
  }

  const recurrenceQueue = String(row.recurrence_member_queue || "")
    .split(",")
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);

  return {
    id: row.id,
    project_id: row.project_id,
    assigned_member_id: row.assigned_member_id,
    created_by_user_id: row.created_by_user_id,
    title: row.title || "",
    description: row.description || "",
    status: normalizePlannerStatus(row.status),
    priority: normalizePlannerPriority(row.priority),
    label: row.label || null,
    due_at: row.due_at,
    is_completed: Boolean(row.is_completed),
    completed_at: row.completed_at || null,
    completed_late: Boolean(row.completed_late),
    workflow_state: normalizePlannerWorkflowState(row.workflow_state),
    missed_at: row.missed_at || null,
    last_extended_at: row.last_extended_at || null,
    last_extended_by_user_id: row.last_extended_by_user_id || null,
    recurrence_interval_days:
      row.recurrence_interval_days === null || row.recurrence_interval_days === undefined
        ? null
        : Number(row.recurrence_interval_days),
    recurrence_unit: normalizePlannerRecurrenceUnit(row.recurrence_unit),
    recurrence_every:
      row.recurrence_every === null || row.recurrence_every === undefined
        ? null
        : Number(row.recurrence_every),
    recurrence_member_queue: recurrenceQueue,
    recurrence_next_index:
      row.recurrence_next_index === null || row.recurrence_next_index === undefined
        ? null
        : Number(row.recurrence_next_index),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    project: {
      id: row.project_id,
      name: row.project_name,
      logo: row.project_logo || null,
      primary_color: normalizeProjectColor(row.project_primary_color),
    },
    member: {
      id: row.assigned_member_id,
      name: row.member_name,
      photo: row.member_photo || null,
      is_active: Boolean(row.member_is_active),
    },
    created_by_user: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          username: row.created_by_username || null,
          name: row.created_by_name || row.created_by_username || null,
        }
      : null,
  };
}

// FUNCAO: mapPlannerTaskCompletionLog.
function mapPlannerTaskCompletionLog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    task_id: row.task_id,
    project_id: row.project_id,
    assigned_member_id: row.assigned_member_id,
    completed_by_user_id: row.completed_by_user_id,
    title: row.title || "",
    description: row.description || "",
    status: normalizePlannerStatus(row.status),
    priority: normalizePlannerPriority(row.priority),
    label: row.label || null,
    due_at: row.due_at || null,
    completed_at: row.completed_at || null,
    project_name: row.project_name || null,
    member_name: row.member_name || null,
    member_photo: row.member_photo || null,
    completed_by_name: row.completed_by_name || row.completed_by_username || null,
    completed_by_username: row.completed_by_username || null,
  };
}

// FUNCAO: mapReportWeekGoalDeletionLog.
function mapReportWeekGoalDeletionLog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    goal_id: row.goal_id,
    member_id: row.member_id,
    project_id: row.project_id,
    deleted_by_user_id: row.deleted_by_user_id,
    week_start: row.week_start,
    activity: row.activity || "",
    description: row.description || "",
    completed_at: row.completed_at || null,
    deleted_at: row.deleted_at || null,
    deletion_reason: row.deletion_reason || "",
    member_name: row.member_name || null,
    project_name: row.project_name || null,
    deleted_by_name: row.deleted_by_name || row.deleted_by_username || null,
    deleted_by_username: row.deleted_by_username || null,
  };
}

// FUNCAO: mapInventoryCatalog.
function mapInventoryCatalog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
  };
}

// FUNCAO: mapInventoryItem.
function mapInventoryItem(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    item_type: normalizeInventoryType(row.item_type),
    category: row.category || "",
    category_id: row.category_id || null,
    location: row.location || "",
    location_id: row.location_id || null,
    amount: row.amount,
    description: row.description || "",
  };
}

// FUNCAO: mapInventoryLoan.
function mapInventoryLoan(row) {
  if (!row) {
    return null;
  }

  const returnedAt = row.returned_at || null;
  const dueAt = row.due_at;
  const isOverdue =
    !returnedAt &&
    Boolean(dueAt) &&
    new Date(dueAt.replace(" ", "T")) < new Date();

  return {
    id: row.id,
    item_id: row.item_id,
    user_id: row.user_id,
    quantity: row.quantity,
    borrowed_at: row.borrowed_at,
    original_due_at: row.original_due_at,
    due_at: dueAt,
    returned_at: returnedAt,
    extended_at: row.extended_at || null,
    extended_by_user_id: row.extended_by_user_id || null,
    returned_by_user_id: row.returned_by_user_id || null,
    item_name: row.item_name,
    item_type: normalizeInventoryType(row.item_type),
    item_category: row.item_category || "",
    user_name: row.user_name || row.user_username,
    user_username: row.user_username,
    user_role: row.user_role,
    extended_by_name: row.extended_by_name || null,
    returned_by_name: row.returned_by_name || null,
    is_overdue: isOverdue,
    status: returnedAt ? "returned" : isOverdue ? "overdue" : "active",
  };
}

// SECAO: operacoes de usuarios e vinculacao com membros.

// FUNCAO: getUserById.
async function getUserById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.password_hash,
        u.name,
        u.email,
        u.role,
        u.member_id,
        u.is_active,
        u.deactivated_at,
        m.name AS member_name
      FROM user u
      LEFT JOIN member m ON m.id = u.member_id
      WHERE u.id = ?
    `,
    )
    .get(id));

  return mapUser(row);
}

// FUNCAO: getUserByUsername.
async function getUserByUsername(username) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.password_hash,
        u.name,
        u.email,
        u.role,
        u.member_id,
        u.is_active,
        u.deactivated_at,
        m.name AS member_name
      FROM user u
      LEFT JOIN member m ON m.id = u.member_id
      WHERE u.username = ?
    `,
    )
    .get(username));

  return mapUser(row);
}

// FUNCAO: listUsers.
async function listUsers() {
  return (await getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.name,
        u.email,
        u.role,
        u.member_id,
        u.is_active,
        u.deactivated_at,
        m.name AS member_name
      FROM user u
      LEFT JOIN member m ON m.id = u.member_id
      WHERE u.is_active = 1
      ORDER BY LOWER(COALESCE(u.name, u.username)), LOWER(u.username)
    `,
    )
    .all())
    .map(mapUser);
}

// FUNCAO: createUser.
async function createUser(
  username,
  passwordHash,
  {
    name = null,
    email = null,
    role = "admin",
    memberId = null,
  } = {},
) {
  return withTransaction(async () => {
  const db = getDb();
  const normalizedRole = USER_ROLES.has(role) ? role : "common";
  const normalizedEmail = String(email || "").trim().toLowerCase() || null;
  const result = (await db
    .prepare(
      `
      INSERT INTO user (username, password_hash, name, email, role, member_id)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    ).run(
      username,
      passwordHash,
      name || username,
      normalizedEmail,
      normalizedRole,
      memberId,
    ));

  return (await getUserById(result.lastInsertRowid));

  });
}

// FUNCAO: setUserMemberLink.
async function setUserMemberLink(userId, memberId = null) {
  return withTransaction(async () => {
  const db = getDb();
  const current = (await getUserById(userId));
  if (!current) {
    return null;
  }

  (await db.prepare("UPDATE user SET member_id = ? WHERE id = ?").run(memberId, userId));
  return (await getUserById(userId));

  });
}

// FUNCAO: updateUserPassword.
async function updateUserPassword(userId, passwordHash) {
  return withTransaction(async () => {
  const current = (await getUserById(userId));
  if (!current) {
    return null;
  }

  (await getDb()
    .prepare("UPDATE user SET password_hash = ? WHERE id = ?")
    .run(passwordHash, userId));
  return (await getUserById(userId));

  });
}

async function updateUserEmail(userId, email = null) {
  return withTransaction(async () => {
  const current = (await getUserById(userId));
  if (!current) {
    return null;
  }

  const normalizedEmail = String(email || "").trim().toLowerCase() || null;
  (await getDb()
    .prepare("UPDATE user SET email = ? WHERE id = ?")
    .run(normalizedEmail, userId));
  return (await getUserById(userId));

  });
}

// FUNCAO: deleteUser.
async function deleteUser(userId) {
  return (await withTransaction(async (db) => {
    const current = (await getUserById(userId));
    if (!current) {
      return { deleted: false, reason: "not_found" };
    }

    if (!current.is_active) {
      return { deleted: true, user: current, deactivated: true };
    }

    (await db.prepare(
      `
      UPDATE user
      SET
        is_active = 0,
        deactivated_at = CURRENT_TIMESTAMP,
        member_id = NULL,
        email = NULL
      WHERE id = ?
    `,
    ).run(userId));

    return { deleted: true, user: current, deactivated: true };
  }));
}

// SECAO: tabelas auxiliares do almoxarifado (categorias e locais).

// FUNCAO: listInventoryCategories.
async function listInventoryCategories() {
  return (await getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_category
      ORDER BY LOWER(name), id
    `,
    )
    .all())
    .map(mapInventoryCatalog);
}

// FUNCAO: getInventoryCategoryById.
async function getInventoryCategoryById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_category
      WHERE id = ?
    `,
    )
    .get(id));

  return mapInventoryCatalog(row);
}

// FUNCAO: createInventoryCategory.
async function createInventoryCategory(name) {
  return withTransaction(async () => {
  const db = getDb();
  const result = (await db
    .prepare(
      `
      INSERT INTO inventory_category (name)
      VALUES (?)
      RETURNING id
    `,
    )
    .run(name));

  return (await getInventoryCategoryById(result.lastInsertRowid));

  });
}

// FUNCAO: updateInventoryCategory.
async function updateInventoryCategory(id, name) {
  return (await withTransaction(async (db) => {
    const current = (await db
      .prepare(
        `
        SELECT id, name
        FROM inventory_category
        WHERE id = ?
      `,
      )
      .get(id));

    if (!current) {
      return null;
    }

    (await db.prepare("UPDATE inventory_category SET name = ? WHERE id = ?").run(name, id));
    (await db.prepare(
      `
      UPDATE estoque
      SET category = ?
      WHERE category_id = ?
    `,
    ).run(name, id));

    return (await getInventoryCategoryById(id));
  }));
}

// FUNCAO: deleteInventoryCategory.
async function deleteInventoryCategory(id) {
  return (await withTransaction(async (db) => {
    const current = (await db
      .prepare(
        `
        SELECT id, name
        FROM inventory_category
        WHERE id = ?
      `,
      )
      .get(id));

    if (!current) {
      return null;
    }

    (await db.prepare(
      `
      UPDATE estoque
      SET category_id = NULL
      WHERE category_id = ?
    `,
    ).run(id));

    (await db.prepare("DELETE FROM inventory_category WHERE id = ?").run(id));
    return mapInventoryCatalog(current);
  }));
}

// FUNCAO: listInventoryLocations.
async function listInventoryLocations() {
  return (await getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_location
      ORDER BY LOWER(name), id
    `,
    )
    .all())
    .map(mapInventoryCatalog);
}

// FUNCAO: getInventoryLocationById.
async function getInventoryLocationById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_location
      WHERE id = ?
    `,
    )
    .get(id));

  return mapInventoryCatalog(row);
}

// FUNCAO: createInventoryLocation.
async function createInventoryLocation(name) {
  return withTransaction(async () => {
  const db = getDb();
  const result = (await db
    .prepare(
      `
      INSERT INTO inventory_location (name)
      VALUES (?)
      RETURNING id
    `,
    )
    .run(name));

  return (await getInventoryLocationById(result.lastInsertRowid));

  });
}

// FUNCAO: updateInventoryLocation.
async function updateInventoryLocation(id, name) {
  return (await withTransaction(async (db) => {
    const current = (await db
      .prepare(
        `
        SELECT id, name
        FROM inventory_location
        WHERE id = ?
      `,
      )
      .get(id));

    if (!current) {
      return null;
    }

    (await db.prepare("UPDATE inventory_location SET name = ? WHERE id = ?").run(name, id));
    (await db.prepare(
      `
      UPDATE estoque
      SET location = ?
      WHERE location_id = ?
    `,
    ).run(name, id));

    return (await getInventoryLocationById(id));
  }));
}

// FUNCAO: deleteInventoryLocation.
async function deleteInventoryLocation(id) {
  return (await withTransaction(async (db) => {
    const current = (await db
      .prepare(
        `
        SELECT id, name
        FROM inventory_location
        WHERE id = ?
      `,
      )
      .get(id));

    if (!current) {
      return null;
    }

    (await db.prepare(
      `
      UPDATE estoque
      SET location_id = NULL
      WHERE location_id = ?
    `,
    ).run(id));

    (await db.prepare("DELETE FROM inventory_location WHERE id = ?").run(id));
    return mapInventoryCatalog(current);
  }));
}

// FUNCAO: resolveInventoryCatalogEntry.
async function resolveInventoryCatalogEntry({
  db,
  table,
  id,
  name,
}) {
  const normalizedName = trimCatalogValue(name);
  const numericId = Number.isInteger(Number(id)) ? Number(id) : null;

  if (normalizedName) {
    const existing = (await db
      .prepare(`SELECT id, name FROM ${table} WHERE LOWER(name) = LOWER(?)`)
      .get(normalizedName));
    if (existing) {
      return mapInventoryCatalog(existing);
    }

    const result = (await db
      .prepare(`INSERT INTO ${table} (name) VALUES (?) RETURNING id`)
      .run(normalizedName));

    return mapInventoryCatalog({
      id: Number(result.lastInsertRowid),
      name: normalizedName,
    });
  }

  if (numericId) {
    const row = (await db
      .prepare(`SELECT id, name FROM ${table} WHERE id = ?`)
      .get(numericId));

    if (row) {
      return mapInventoryCatalog(row);
    }
  }

  return null;
}

// FUNCAO: trimCatalogValue.
function trimCatalogValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

// SECAO: operacoes de membros (cadastro, busca e desativacao).

// FUNCAO: listActiveMembers.
async function listActiveMembers() {
  return (await getDb()
    .prepare(
      "SELECT id, name, photo, is_active FROM member WHERE is_active = 1 ORDER BY LOWER(name)",
    )
    .all())
    .map(mapMember);
}

// FUNCAO: getMemberById.
async function getMemberById(id) {
  const row = (await getDb()
    .prepare("SELECT id, name, photo, is_active FROM member WHERE id = ?")
    .get(id));

  return row ? mapMember(row) : null;
}

// FUNCAO: getMemberByName.
async function getMemberByName(name) {
  const normalized = String(name || "").trim();
  if (!normalized) {
    return null;
  }

  const row = (await getDb()
    .prepare(
      `
      SELECT id, name, photo, is_active
      FROM member
      WHERE LOWER(name) = LOWER(?)
      LIMIT 1
    `,
    )
    .get(normalized));

  return mapMember(row);
}

// FUNCAO: createMember.
async function createMember(name, photo = null) {
  return withTransaction(async () => {
  const db = getDb();
  const result = (await db
    .prepare("INSERT INTO member (name, photo, is_active) VALUES (?, ?, 1) RETURNING id")
    .run(name, photo));

  return (await getMemberById(result.lastInsertRowid));

  });
}

// FUNCAO: updateMember.
async function updateMember(id, { name, photo }) {
  return withTransaction(async () => {
  (await getDb().prepare("UPDATE member SET name = ?, photo = ? WHERE id = ?").run(name, photo, id));
  return (await getMemberById(id));

  });
}

// FUNCAO: deactivateMember.
async function deactivateMember(id) {
  return (await withTransaction(async (db) => {
    (await db.prepare("UPDATE member SET is_active = 0 WHERE id = ?").run(id));
    (await db.prepare("DELETE FROM project_members WHERE member_id = ?").run(id));
    return (await getMemberById(id));
  }));
}

// SECAO: operacoes de projetos e relacoes projeto-membro.

// FUNCAO: listProjectsBasic.
async function listProjectsBasic() {
  return (await getDb()
    .prepare("SELECT id, name, logo, primary_color FROM project ORDER BY LOWER(name)")
    .all())
    .map(mapProject);
}

// FUNCAO: getProjectMembers.
async function getProjectMembers(projectId, { activeOnly = false } = {}) {
  const where = activeOnly ? "AND m.is_active = 1" : "";

  return (await getDb()
    .prepare(
      `
      SELECT m.id, m.name, m.photo, m.is_active
      , pm.is_coordinator
      FROM member m
      INNER JOIN project_members pm ON pm.member_id = m.id
      WHERE pm.project_id = ?
      ${where}
      ORDER BY LOWER(m.name)
    `,
    )
    .all(projectId))
    .map(mapMember);
}

// FUNCAO: getProjectById.
async function getProjectById(id) {
  const projectRow = (await getDb()
    .prepare("SELECT id, name, logo, primary_color FROM project WHERE id = ?")
    .get(id));

  if (!projectRow) {
    return null;
  }

  const project = mapProject(projectRow);
  project.members = (await getProjectMembers(project.id));
  project.active_members = project.members.filter((member) => member.is_active);
  project.active_member_ids = project.active_members.map((member) => member.id);
  project.coordinator_member_ids = project.members
    .filter((member) => member.is_coordinator)
    .map((member) => member.id);
  project.coordinators = project.members.filter((member) => member.is_coordinator);
  project.active_coordinators = project.active_members.filter(
    (member) => member.is_coordinator,
  );
  project.member_name_preview = firstNamesSummary(project.members);
  project.coordinator_name_preview = firstNamesSummary(project.coordinators);
  return project;
}

// FUNCAO: listProjectsWithMembers.
async function listProjectsWithMembers(projectIds = null) {
  const ids = Array.isArray(projectIds)
    ? [...new Set(projectIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : null;
  if (ids && !ids.length) {
    return [];
  }
  const projectFilter = ids ? `WHERE p.id IN (${ids.map(() => "?").join(", ")})` : "";
  const rows = (await getDb()
    .prepare(
      `
      SELECT
        p.id AS project_id,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.id AS member_id,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        pm.is_coordinator
      FROM project p
      LEFT JOIN project_members pm ON pm.project_id = p.id
      LEFT JOIN member m ON m.id = pm.member_id
      ${projectFilter}
      ORDER BY LOWER(p.name), LOWER(m.name), m.id
    `,
    )
    .all(...(ids || [])));

  const projectsById = new Map();
  rows.forEach((row) => {
    if (!projectsById.has(row.project_id)) {
      projectsById.set(row.project_id, {
        ...mapProject({
          id: row.project_id,
          name: row.project_name,
          logo: row.project_logo,
          primary_color: row.project_primary_color,
        }),
        members: [],
      });
    }

    if (row.member_id) {
      projectsById.get(row.project_id).members.push(mapMember({
        id: row.member_id,
        name: row.member_name,
        photo: row.member_photo,
        is_active: row.member_is_active,
        is_coordinator: row.is_coordinator,
      }));
    }
  });

  return Array.from(projectsById.values()).map((project) => {
    project.active_members = project.members.filter((member) => member.is_active);
    project.active_member_ids = project.active_members.map((member) => member.id);
    project.coordinator_member_ids = project.members
      .filter((member) => member.is_coordinator)
      .map((member) => member.id);
    project.coordinators = project.members.filter((member) => member.is_coordinator);
    project.active_coordinators = project.active_members.filter(
      (member) => member.is_coordinator,
    );
    project.member_name_preview = firstNamesSummary(project.members);
    project.coordinator_name_preview = firstNamesSummary(project.coordinators);
    return project;
  });
}

async function listProjectsWithMembersByIds(projectIds = []) {
  const ids = [...new Set(
    (Array.isArray(projectIds) ? projectIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
  if (!ids.length) {
    return [];
  }
  return (await listProjectsWithMembers(ids));
}

// FUNCAO: createProject.
async function createProject({ name, logo, primaryColor, memberIds, coordinatorIds = null }) {
  return (await withTransaction(async (db) => {
    const uniqueMemberIds = [...new Set(memberIds)];
    const normalizedCoordinatorIds = Array.isArray(coordinatorIds)
      ? coordinatorIds.filter((memberId) => uniqueMemberIds.includes(memberId))
      : uniqueMemberIds.slice(0, 1);
    const coordinatorIdSet = new Set(normalizedCoordinatorIds);

    const result = (await db
      .prepare("INSERT INTO project (name, logo, primary_color) VALUES (?, ?, ?) RETURNING id")
      .run(name, logo || null, normalizeProjectColor(primaryColor)));

    const projectId = Number(result.lastInsertRowid);
    const insertMembership = db.prepare(
      "INSERT INTO project_members (project_id, member_id, is_coordinator) VALUES (?, ?, ?)",
    );

    for (const memberId of uniqueMemberIds) {
      await insertMembership.run(projectId, memberId, coordinatorIdSet.has(memberId) ? 1 : 0);
    }

    return (await getProjectById(projectId));
  }));
}

// FUNCAO: updateProject.
async function updateProject(
  id,
  { name, logo, primaryColor, memberIds, coordinatorIds = null },
) {
  return (await withTransaction(async (db) => {
    const uniqueMemberIds = [...new Set(memberIds)];
    const normalizedCoordinatorIds = Array.isArray(coordinatorIds)
      ? coordinatorIds.filter((memberId) => uniqueMemberIds.includes(memberId))
      : uniqueMemberIds.slice(0, 1);
    const coordinatorIdSet = new Set(normalizedCoordinatorIds);

    (await db.prepare("UPDATE project SET name = ?, logo = ?, primary_color = ? WHERE id = ?").run(
      name,
      logo || null,
      normalizeProjectColor(primaryColor),
      id,
    ));
    (await db.prepare("DELETE FROM project_members WHERE project_id = ?").run(id));

    const insertMembership = db.prepare(
      "INSERT INTO project_members (project_id, member_id, is_coordinator) VALUES (?, ?, ?)",
    );

    for (const memberId of uniqueMemberIds) {
      await insertMembership.run(id, memberId, coordinatorIdSet.has(memberId) ? 1 : 0);
    }

    return (await getProjectById(id));
  }));
}

// FUNCAO: listProjectsForMember.
async function listProjectsForMember(memberId) {
  return (await getDb()
    .prepare(
      `
      SELECT p.id, p.name, p.logo, p.primary_color
      FROM project p
      INNER JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.member_id = ?
      ORDER BY LOWER(p.name)
    `,
    )
    .all(memberId))
    .map(mapProject);
}

// FUNCAO: isProjectMember.
async function isProjectMember(projectId, memberId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM project_members
      WHERE project_id = ? AND member_id = ?
      LIMIT 1
    `,
    )
    .get(projectId, memberId));

  return Boolean(row?.ok);
}

// FUNCAO: isProjectCoordinator.
async function isProjectCoordinator(projectId, memberId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM project_members
      WHERE project_id = ? AND member_id = ? AND is_coordinator = 1
      LIMIT 1
    `,
    )
    .get(projectId, memberId));

  return Boolean(row?.ok);
}

// FUNCAO: deleteProject.
async function deleteProject(id) {
  return (await withTransaction(async (db) => {
    (await db.prepare(
      "DELETE FROM ata_absent_justification WHERE ata_id IN (SELECT id FROM ata WHERE project_id = ?)",
    ).run(id));
    (await db.prepare(
      "DELETE FROM ata_present_members WHERE ata_id IN (SELECT id FROM ata WHERE project_id = ?)",
    ).run(id));
    (await db.prepare("DELETE FROM ata WHERE project_id = ?").run(id));
    (await db.prepare("DELETE FROM project_members WHERE project_id = ?").run(id));
    (await db.prepare("DELETE FROM project WHERE id = ?").run(id));
  }));
}

// SECAO: operacoes de atas (consulta completa, criacao e exclusao).

// FUNCAO: listRecentAtas.
async function listRecentAtas(limit = 5) {
  return (await getDb()
    .prepare(
      `
      SELECT
        a.id,
        a.meeting_datetime,
        a.project_id,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color
      FROM ata a
      INNER JOIN project p ON p.id = a.project_id
      ORDER BY a.meeting_datetime DESC
      LIMIT ?
    `,
    )
    .all(limit))
    .map((row) => ({
      id: row.id,
      meeting_datetime: row.meeting_datetime,
      project_id: row.project_id,
      project: {
        id: row.project_id,
        name: row.project_name,
        logo: row.project_logo || null,
        primary_color: normalizeProjectColor(row.project_primary_color),
      },
    }));
}

// FUNCAO: getAtaBaseById.
async function getAtaBaseById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        a.id,
        a.meeting_datetime,
        a.location_type,
        a.location_details,
        a.notes,
        a.created_at,
        a.project_id,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color
      FROM ata a
      INNER JOIN project p ON p.id = a.project_id
      WHERE a.id = ?
    `,
    )
    .get(id));

  if (!row) {
    return null;
  }

  const ata = mapAta(row);
  ata.project = {
    id: row.project_id,
    name: row.project_name,
    logo: row.project_logo || null,
    primary_color: normalizeProjectColor(row.project_primary_color),
  };
  return ata;
}

// FUNCAO: getAtaPresentMembers.
async function getAtaPresentMembers(ataId) {
  return (await getDb()
    .prepare(
      `
      SELECT m.id, m.name, m.photo, m.is_active
      FROM member m
      INNER JOIN ata_present_members apm ON apm.member_id = m.id
      WHERE apm.ata_id = ?
      ORDER BY LOWER(m.name)
    `,
    )
    .all(ataId))
    .map(mapMember);
}

// FUNCAO: getAtaAbsentJustifications.
async function getAtaAbsentJustifications(ataId) {
  const rows = (await getDb()
    .prepare(
      `
      SELECT aj.member_id, aj.justification, m.name
      FROM ata_absent_justification aj
      INNER JOIN member m ON m.id = aj.member_id
      WHERE aj.ata_id = ?
      ORDER BY LOWER(m.name)
    `,
    )
    .all(ataId));

  const dictionary = {};
  rows.forEach((row) => {
    dictionary[row.member_id] = row.justification;
  });

  return {
    rows,
    dictionary,
  };
}

// FUNCAO: getAtaById.
async function getAtaById(id) {
  const ata = (await getAtaBaseById(id));
  if (!ata) {
    return null;
  }

  ata.present_members = (await getAtaPresentMembers(id));
  const project = (await getProjectById(ata.project_id));
  const presentMemberIds = new Set(ata.present_members.map((member) => member.id));
  ata.absent_members = project.members.filter(
    (member) => !presentMemberIds.has(member.id),
  );

  const justifications = (await getAtaAbsentJustifications(id));
  ata.absent_justifications = justifications.rows;
  ata.absent_justifications_dict = justifications.dictionary;

  return ata;
}

// FUNCAO: createAta.
async function createAta({ projectId, meetingDateTime, notes, presentMemberIds, justifications }) {
  return (await withTransaction(async (db) => {
    const result = (await db
      .prepare(
        `
        INSERT INTO ata (meeting_datetime, location_type, location_details, notes, created_at, project_id)
        VALUES (?, NULL, NULL, ?, CURRENT_TIMESTAMP, ?)
        RETURNING id
      `,
      )
      .run(meetingDateTime, notes, projectId));

    const ataId = Number(result.lastInsertRowid);
    const insertPresent = db.prepare(
      "INSERT INTO ata_present_members (ata_id, member_id) VALUES (?, ?)",
    );
    for (const memberId of presentMemberIds) {
      await insertPresent.run(ataId, memberId);
    }

    const insertJustification = db.prepare(
      `
      INSERT INTO ata_absent_justification (ata_id, member_id, justification)
      VALUES (?, ?, ?)
    `,
    );

    for (const [memberId, justification] of Object.entries(justifications)) {
      await insertJustification.run(ataId, Number(memberId), justification);
    }

    return (await getAtaById(ataId));
  }));
}

// FUNCAO: deleteAta.
async function deleteAta(id) {
  return (await withTransaction(async (db) => {
    (await db.prepare("DELETE FROM ata_absent_justification WHERE ata_id = ?").run(id));
    (await db.prepare("DELETE FROM ata_present_members WHERE ata_id = ?").run(id));
    (await db.prepare("DELETE FROM ata WHERE id = ?").run(id));
  }));
}

// SECAO: operacoes de relatorios semanais.

// FUNCAO: createReportEntry.
async function createReportEntry({
  projectId,
  memberId,
  createdByUserId = null,
  weekStart,
  status = "in_progress",
  content,
}) {
  return withTransaction(async () => {
  const result = (await getDb()
    .prepare(
      `
      INSERT INTO report_entry (
        project_id,
        member_id,
        created_by_user_id,
        week_start,
        status,
        content
      )
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(
      projectId,
      memberId,
      createdByUserId,
      weekStart,
      normalizeReportStatus(status),
      content,
    ));

  return (await getReportEntryById(result.lastInsertRowid));

  });
}

// FUNCAO: updateReportEntry.
async function updateReportEntry(id, { content, status = "in_progress" }) {
  return withTransaction(async () => {
  const db = getDb();
  const existing = (await getReportEntryById(id));
  if (!existing) {
    return null;
  }

  (await db.prepare(
    `
    UPDATE report_entry
    SET
      week_start = ?,
      status = ?,
      content = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(existing.week_start, normalizeReportStatus(status), content, id));

  return (await getReportEntryById(id));

  });
}

// FUNCAO: deleteReportEntry.
async function deleteReportEntry(id) {
  return withTransaction(async () => {
  const existing = (await getReportEntryById(id));
  if (!existing) {
    return null;
  }

  (await getDb().prepare("DELETE FROM report_entry WHERE id = ?").run(id));
  return existing;

  });
}

// FUNCAO: getReportEntryById.
async function getReportEntryById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        r.id,
        r.project_id,
        r.member_id,
        r.created_by_user_id,
        r.week_start,
        r.status,
        r.content,
        r.created_at,
        r.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_entry r
      INNER JOIN project p ON p.id = r.project_id
      INNER JOIN member m ON m.id = r.member_id
      LEFT JOIN user u ON u.id = r.created_by_user_id
      WHERE r.id = ?
    `,
    )
    .get(id));

  return mapReportEntry(row);
}

// FUNCAO: listReportEntries.
async function listReportEntries({
  memberId = null,
  projectId = null,
  weekStart = null,
  status = null,
  limit = 200,
} = {}) {
  const where = [];
  const params = [];

  if (memberId) {
    where.push("r.member_id = ?");
    params.push(memberId);
  }

  if (projectId) {
    where.push("r.project_id = ?");
    params.push(projectId);
  }

  if (weekStart) {
    where.push("r.week_start = ?");
    params.push(weekStart);
  }

  if (REPORT_STATUSES.has(status)) {
    where.push("r.status = ?");
    params.push(status);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return (await getDb()
    .prepare(
      `
      SELECT
        r.id,
        r.project_id,
        r.member_id,
        r.created_by_user_id,
        r.week_start,
        r.status,
        r.content,
        r.created_at,
        r.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_entry r
      INNER JOIN project p ON p.id = r.project_id
      INNER JOIN member m ON m.id = r.member_id
      LEFT JOIN user u ON u.id = r.created_by_user_id
      ${whereClause}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit))
    .map(mapReportEntry);
}

// FUNCAO: listReportProjectsForMember.
async function listReportProjectsForMember(memberId, { weekStart = null, status = null } = {}) {
  const where = ["r.member_id = ?"];
  const params = [memberId];
  if (weekStart) {
    where.push("r.week_start = ?");
    params.push(weekStart);
  }
  if (REPORT_STATUSES.has(status)) {
    where.push("r.status = ?");
    params.push(status);
  }

  return (await getDb()
    .prepare(
      `
      SELECT DISTINCT p.id, p.name, p.logo, p.primary_color
      FROM report_entry r
      INNER JOIN project p ON p.id = r.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY LOWER(p.name)
    `,
    )
    .all(...params))
    .map(mapProject);
}

// FUNCAO: listReportWeeksForMember.
async function listReportWeeksForMember(memberId, { projectId = null, status = null } = {}) {
  const where = ["member_id = ?"];
  const params = [memberId];
  if (projectId) {
    where.push("project_id = ?");
    params.push(projectId);
  }
  if (REPORT_STATUSES.has(status)) {
    where.push("status = ?");
    params.push(status);
  }

  return (await getDb()
    .prepare(
      `
      SELECT DISTINCT week_start
      FROM report_entry
      WHERE ${where.join(" AND ")}
      ORDER BY week_start DESC
    `,
    )
    .all(...params))
    .map((row) => row.week_start);
}

// FUNCAO: listReportMembersSummary.
async function listReportMembersSummary() {
  return (await getDb()
    .prepare(
      `
      SELECT
        m.id,
        m.name,
        m.photo,
        m.is_active,
        COALESCE(w.warning_count, 0) AS warning_count,
        wr.started_at AS restriction_started_at,
        COUNT(r.id) AS total_entries,
        MAX(r.created_at) AS last_created_at
      FROM member m
      LEFT JOIN report_entry r ON r.member_id = m.id
      LEFT JOIN LATERAL (
        SELECT e.new_count AS warning_count
        FROM member_warning_event e
        WHERE e.member_id = m.id
        ORDER BY e.id DESC
        LIMIT 1
      ) w ON true
      LEFT JOIN LATERAL (
        SELECT rr.started_at
        FROM member_warning_restriction rr
        WHERE rr.member_id = m.id
        ORDER BY rr.started_at DESC, rr.id DESC
        LIMIT 1
      ) wr ON true
      WHERE m.is_active = 1
      GROUP BY m.id, m.name, m.photo, m.is_active, w.warning_count, wr.started_at
      ORDER BY
        CASE WHEN COUNT(r.id) > 0 THEN 0 ELSE 1 END,
        LOWER(m.name)
    `,
    )
    .all())
    .map((row) => ({
      id: row.id,
      name: row.name,
      photo: row.photo || null,
      is_active: Boolean(row.is_active),
      total_entries: row.total_entries || 0,
      last_created_at: row.last_created_at || null,
      ...mapMemberWarningState(row),
    }));
}

// FUNCAO: createReportWeekGoal.
async function createReportWeekGoal({
  memberId,
  projectId,
  createdByUserId = null,
  weekStart,
  dueAt = null,
  activity,
  description = "",
  plannerTaskId = null,
  goalSource = "manual",
  taskState = "active",
  isCompleted = false,
  completedLate = false,
}) {
  return withTransaction(async () => {
  const result = (await getDb()
    .prepare(
      `
      INSERT INTO report_week_goal (
        member_id,
        project_id,
        created_by_user_id,
        week_start,
        due_at,
        activity,
        description,
        planner_task_id,
        goal_source,
        task_state,
        is_completed,
        completed_at,
        completed_late
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CAST(CURRENT_TIMESTAMP AS TEXT) ELSE NULL END, ?)
      RETURNING id
    `,
    )
    .run(
      memberId,
      projectId,
      createdByUserId,
      weekStart,
      dueAt,
      activity,
      description,
      plannerTaskId,
      goalSource === "planner" ? "planner" : "manual",
      normalizePlannerWorkflowState(taskState),
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      completedLate ? 1 : 0,
    ));

  return (await getReportWeekGoalById(result.lastInsertRowid));

  });
}

// FUNCAO: getReportWeekGoalById.
async function getReportWeekGoalById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        COALESCE(t.status, CASE WHEN g.is_completed = 1 THEN 'done' ELSE 'todo' END) AS task_status,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN planner_task t ON t.id = g.planner_task_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE g.id = ?
      LIMIT 1
    `,
    )
    .get(id));

  return mapReportWeekGoal(row);
}

// FUNCAO: getReportWeekGoalByPlannerTaskId.
async function getReportWeekGoalByPlannerTaskId(plannerTaskId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE g.planner_task_id = ?
      LIMIT 1
    `,
    )
    .get(plannerTaskId));

  return mapReportWeekGoal(row);
}

// FUNCAO: syncReportWeekGoalFromPlannerTask.
async function syncReportWeekGoalFromPlannerTask(
  plannerTask,
  { createdByUserId = null } = {},
) {
  return withTransaction(async () => {
  if (!plannerTask?.id || !plannerTask?.assigned_member_id || !plannerTask?.project_id) {
    return null;
  }

  const weekStart = resolveFortnightStartFromSqlDateTime(plannerTask.due_at);
  const activity = String(plannerTask.title || "").trim();
  if (!weekStart || !activity) {
    return null;
  }

  const description = String(plannerTask.description || "").trim();
  const ownerUserId = createdByUserId || plannerTask.created_by_user_id || null;
  const isCompleted = Boolean(plannerTask.is_completed);
  const completedLate = Boolean(plannerTask.completed_late);

  return (await withTransaction(async (db) => {
    const existing = (await db
      .prepare(
        `
        SELECT id
        FROM report_week_goal
        WHERE planner_task_id = ?
        LIMIT 1
      `,
      )
      .get(plannerTask.id));

    if (existing?.id) {
      (await db.prepare(
        `
        UPDATE report_week_goal
        SET
          member_id = ?,
          project_id = ?,
          week_start = ?,
          due_at = ?,
          activity = ?,
          description = ?,
          task_state = ?,
          is_completed = ?,
          completed_at = CASE
            WHEN ? = 1 THEN COALESCE(CAST(? AS TEXT), completed_at, CAST(CURRENT_TIMESTAMP AS TEXT))
            ELSE NULL
          END,
          completed_late = ?,
          goal_source = 'planner',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      ).run(
        plannerTask.assigned_member_id,
        plannerTask.project_id,
        weekStart,
        plannerTask.due_at,
        activity,
        description,
        normalizePlannerWorkflowState(plannerTask.workflow_state),
        isCompleted ? 1 : 0,
        isCompleted ? 1 : 0,
        plannerTask.completed_at || null,
        completedLate ? 1 : 0,
        existing.id,
      ));

      if (ownerUserId) {
        (await db.prepare(
          `
          UPDATE report_week_goal
          SET created_by_user_id = COALESCE(created_by_user_id, ?)
          WHERE id = ?
        `,
        ).run(ownerUserId, existing.id));
      }

      return (await getReportWeekGoalById(existing.id));
    }

    const inserted = (await db.prepare(
      `
      INSERT INTO report_week_goal (
        member_id,
        project_id,
        created_by_user_id,
        week_start,
        due_at,
        activity,
        description,
        planner_task_id,
        goal_source,
        task_state,
        is_completed,
        completed_at,
        completed_late
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planner', ?, ?, CASE WHEN ? = 1 THEN COALESCE(CAST(? AS TEXT), CAST(CURRENT_TIMESTAMP AS TEXT)) ELSE NULL END, ?)
      RETURNING id
    `,
    ).run(
      plannerTask.assigned_member_id,
      plannerTask.project_id,
      ownerUserId,
      weekStart,
      plannerTask.due_at,
      activity,
      description,
      plannerTask.id,
      normalizePlannerWorkflowState(plannerTask.workflow_state),
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      plannerTask.completed_at || null,
      completedLate ? 1 : 0,
    ));

    return (await getReportWeekGoalById(inserted.lastInsertRowid));
  }));

  });
}

// FUNCAO: updateReportWeekGoal.
async function updateReportWeekGoal(
  id,
  {
    activity,
    description,
    isCompleted = false,
    dueAt = null,
    taskState = null,
    completedLate = null,
  },
) {
  return withTransaction(async () => {
  const existing = (await getReportWeekGoalById(id));
  if (!existing) {
    return null;
  }

  (await getDb()
    .prepare(
      `
      UPDATE report_week_goal
      SET
        activity = ?,
        description = ?,
        due_at = COALESCE(?, due_at),
        task_state = CASE
          WHEN ? IS NULL THEN task_state
          ELSE ?
        END,
        is_completed = ?,
        completed_at = CASE WHEN ? = 1 THEN CAST(CURRENT_TIMESTAMP AS TEXT) ELSE NULL END,
        completed_late = CASE
          WHEN ? IS NULL THEN completed_late
          WHEN ? = 1 THEN 1
          ELSE 0
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(
      activity,
      description,
      dueAt,
      taskState ? normalizePlannerWorkflowState(taskState) : null,
      taskState ? normalizePlannerWorkflowState(taskState) : null,
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      completedLate === null ? null : (completedLate ? 1 : 0),
      completedLate ? 1 : 0,
      id,
    ));

  return (await getReportWeekGoalById(id));

  });
}

// FUNCAO: attachPlannerTaskToReportWeekGoal.
async function attachPlannerTaskToReportWeekGoal(goalId, plannerTaskId) {
  return withTransaction(async () => {
  const existing = (await getReportWeekGoalById(goalId));
  if (!existing || !plannerTaskId) {
    return null;
  }

  (await getDb()
    .prepare(
      `
      UPDATE report_week_goal
      SET
        planner_task_id = ?,
        goal_source = 'planner',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(plannerTaskId, goalId));

  return (await getReportWeekGoalById(goalId));

  });
}

// FUNCAO: deleteReportWeekGoal.
async function deleteReportWeekGoal(id) {
  return withTransaction(async () => {
  const existing = (await getReportWeekGoalById(id));
  if (!existing) {
    return null;
  }

  (await getDb().prepare("DELETE FROM report_week_goal WHERE id = ?").run(id));
  return existing;

  });
}

// FUNCAO: deleteReportWeekGoalWithAudit.
async function deleteReportWeekGoalWithAudit(id, deletedByUserId, deletionReason = null) {
  return (await withTransaction(async (db) => {
    const existing = (await getReportWeekGoalById(id));
    if (!existing) {
      return null;
    }

    (await db.prepare(
      `
      INSERT INTO report_week_goal_deletion_log (
        goal_id,
        member_id,
        project_id,
        deleted_by_user_id,
        week_start,
        activity,
        description,
        completed_at,
        deletion_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      existing.id,
      existing.member_id,
      existing.project_id,
      deletedByUserId,
      existing.week_start,
      existing.activity,
      existing.description || "",
      existing.completed_at,
      String(deletionReason || "").trim() || null,
    ));

    (await db.prepare("DELETE FROM report_week_goal WHERE id = ?").run(id));
    return existing;
  }));
}

// FUNCAO: listReportWeekGoalDeletionLogsForMember.
async function listReportWeekGoalDeletionLogsForMember(
  memberId,
  { projectId = null, limit = 30 } = {},
) {
  const where = ["l.member_id = ?"];
  const params = [memberId];

  if (projectId) {
    where.push("l.project_id = ?");
    params.push(projectId);
  }

  return (await getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.goal_id,
        l.member_id,
        l.project_id,
        l.deleted_by_user_id,
        l.week_start,
        l.activity,
        l.description,
        l.completed_at,
        l.deletion_reason,
        l.deleted_at,
        m.name AS member_name,
        p.name AS project_name,
        u.username AS deleted_by_username,
        u.name AS deleted_by_name
      FROM report_week_goal_deletion_log l
      INNER JOIN member m ON m.id = l.member_id
      INNER JOIN project p ON p.id = l.project_id
      INNER JOIN user u ON u.id = l.deleted_by_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.deleted_at DESC, l.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit))
    .map(mapReportWeekGoalDeletionLog);
}

// FUNCAO: listReportWeekGoalsForMember.
async function listReportWeekGoalsForMember(
  memberId,
  { projectId = null, currentWeekStart = null, nowSql = null, limit = 200 } = {},
) {
  const where = ["g.member_id = ?"];
  const params = [memberId];

  if (projectId) {
    where.push("g.project_id = ?");
    params.push(projectId);
  }

  const overdueReferenceWeek = currentWeekStart || "9999-12-31";
  const referenceNow = nowSql || toSqlDateTime(new Date());

  return (await getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY g.week_start DESC, g.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit))
    .map((row) => {
      const mapped = mapReportWeekGoal(row);
      const byDueDate = Boolean(mapped.due_at && isReportDueOverdue(mapped.due_at, referenceNow));
      const byFortnight = !mapped.due_at && mapped.week_start < overdueReferenceWeek;
      const isMissed = mapped.task_state === "missed"
        && (!mapped.due_at || isReportDueOverdue(mapped.due_at, referenceNow));
      return {
        ...mapped,
        is_overdue: !mapped.is_completed
          && (isMissed || byDueDate || byFortnight),
      };
    });
}

// FUNCAO: listReportMonthGoalsForMember.
async function listReportMonthGoalsForMember(memberId, { monthKey, limit = 1200 } = {}) {
  const normalizedMonth = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth)) {
    return [];
  }

  return (await getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE g.member_id = ?
        AND g.week_start LIKE (? || '-%')
      ORDER BY g.week_start DESC, g.id DESC
      LIMIT ?
    `,
    )
    .all(memberId, normalizedMonth, limit))
    .map(mapReportWeekGoal);
}

// FUNCAO: listReportMonthMemberNotesForPdf.
async function listReportMonthMemberNotesForPdf(memberId, { monthKey, limit = 200 } = {}) {
  const normalizedMonth = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth)) {
    return [];
  }

  return (await getDb()
    .prepare(
      `
      SELECT
        n.id,
        n.member_id,
        n.author_user_id,
        n.target_tutor_user_id,
        n.week_start,
        n.content,
        n.sent_to_chat_at,
        n.sent_to_chat_conversation_id,
        n.created_at,
        n.updated_at,
        m.name AS member_name,
        au.username AS author_username,
        au.name AS author_name,
        tu.username AS target_tutor_username,
        tu.name AS target_tutor_name
      FROM report_fortnight_member_note n
      INNER JOIN member m ON m.id = n.member_id
      INNER JOIN "user" au ON au.id = n.author_user_id
      LEFT JOIN "user" tu ON tu.id = n.target_tutor_user_id
      WHERE n.member_id = ?
        AND n.week_start LIKE (? || '-%')
      ORDER BY n.week_start DESC, n.id DESC
      LIMIT ?
    `,
    )
    .all(memberId, normalizedMonth, limit))
    .map(mapReportFortnightMemberNote);
}

// FUNCAO: serializeAuditPayload.
function serializeAuditPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  try {
    return JSON.stringify(payload);
  } catch (error) {
    return null;
  }
}

// FUNCAO: parseAuditPayload.
function parseAuditPayload(payloadJson) {
  const raw = String(payloadJson || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

// FUNCAO: extractAuditTaskTitle.
function extractAuditTaskTitle(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const directTitle = String(payload.title || "").trim();
  if (directTitle) {
    return directTitle;
  }

  const afterTitle = String(payload.after?.title || "").trim();
  if (afterTitle) {
    return afterTitle;
  }

  const beforeTitle = String(payload.before?.title || "").trim();
  if (beforeTitle) {
    return beforeTitle;
  }

  return null;
}

// FUNCAO: createTaskAuditLog.
async function createTaskAuditLog({
  db = null,
  taskId = null,
  reportGoalId = null,
  memberId = null,
  projectId = null,
  eventType,
  actorUserId = null,
  payload = null,
  createdAt = null,
}) {
  return withTransaction(async () => {
  const targetDb = db || getDb();
  const normalizedEvent = String(eventType || "").trim().toLowerCase();
  if (!normalizedEvent) {
    return null;
  }

  const result = (await targetDb
    .prepare(
      `
      INSERT INTO task_audit_log (
        task_id,
        report_goal_id,
        member_id,
        project_id,
        event_type,
        actor_user_id,
        payload_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS TEXT), CAST(CURRENT_TIMESTAMP AS TEXT)))
      RETURNING id
    `,
    )
    .run(
      taskId,
      reportGoalId,
      memberId,
      projectId,
      normalizedEvent,
      actorUserId,
      serializeAuditPayload(payload),
      createdAt,
    ));

  return Number(result.lastInsertRowid || 0);

  });
}

// FUNCAO: listTaskAuditLogsForMember.
async function listTaskAuditLogsForMember(memberId, { projectId = null, limit = 120 } = {}) {
  const where = ["l.member_id = ?"];
  const params = [memberId];
  if (projectId) {
    where.push("l.project_id = ?");
    params.push(projectId);
  }

  return (await getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.task_id,
        l.report_goal_id,
        l.member_id,
        l.project_id,
        l.event_type,
        l.actor_user_id,
        l.payload_json,
        l.created_at,
        p.name AS project_name,
        u.username AS actor_username,
        u.name AS actor_name
      FROM task_audit_log l
      LEFT JOIN project p ON p.id = l.project_id
      LEFT JOIN "user" u ON u.id = l.actor_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit))
    .map((row) => {
      const payload = parseAuditPayload(row.payload_json);
      return {
        id: row.id,
        task_id: row.task_id || null,
        report_goal_id: row.report_goal_id || null,
        member_id: row.member_id,
        project_id: row.project_id || null,
        project_name: row.project_name || null,
        event_type: row.event_type,
        actor_user_id: row.actor_user_id || null,
        actor_name: row.actor_name || row.actor_username || null,
        actor_username: row.actor_username || null,
        payload_json: row.payload_json || null,
        payload,
        task_title: extractAuditTaskTitle(payload),
        created_at: row.created_at || null,
      };
    });
}

// FUNCAO: refreshPlannerTaskLifecycle.
async function refreshPlannerTaskLifecycle({ now = null, graceDays = 0 } = {}) {
  const nowSql = toSqlDateTime(now || new Date());
  const nowDate = fromSqlDateTime(nowSql);
  if (!nowDate || !nowSql) {
    return { updatedCount: 0, taskIds: [] };
  }

  return (await withTransaction(async (db) => {
    const staleTasks = (await db
      .prepare(
        `
        SELECT id, project_id, assigned_member_id, due_at
        FROM planner_task
        WHERE is_completed = 0
          AND workflow_state = 'active'
          AND due_at <= ?
        ORDER BY due_at ASC, id ASC
      `,
      )
      .all(nowSql))
      .filter((task) => isReportDueOverdue(task.due_at, nowSql, graceDays));

    (await asyncArray.forEach(staleTasks, async (task) => {
      (await db.prepare(
        `
        UPDATE planner_task
        SET
          workflow_state = 'missed',
          missed_at = COALESCE(missed_at, ?),
          updated_at = ?
        WHERE id = ?
      `,
      ).run(nowSql, nowSql, task.id));

      (await db.prepare(
        `
        UPDATE report_week_goal
        SET
          task_state = 'missed',
          description = CASE
            WHEN TRIM(COALESCE(description, '')) = '' THEN ?
            ELSE description
          END,
          due_at = COALESCE(due_at, ?),
          updated_at = CURRENT_TIMESTAMP
        WHERE planner_task_id = ?
      `,
      ).run("Relatório não foi entregue nessa quinzena", task.due_at, task.id));

      (await createTaskAuditLog({
        db,
        taskId: task.id,
        memberId: task.assigned_member_id,
        projectId: task.project_id,
        eventType: "auto_missed",
        actorUserId: null,
        payload: {
          due_at: task.due_at,
          grace_days: Number(graceDays),
          grace_until: reportDueGraceDeadlineSql(task.due_at, graceDays),
        },
        createdAt: nowSql,
      }));
    }));

    const staleReportGoals = (await db
      .prepare(
        `
        SELECT id, due_at
        FROM report_week_goal
        WHERE is_completed = 0
          AND task_state = 'active'
          AND planner_task_id IS NULL
          AND due_at IS NOT NULL
          AND due_at <= ?
        ORDER BY due_at ASC, id ASC
      `,
      )
      .all(nowSql))
      .filter((goal) => isReportDueOverdue(goal.due_at, nowSql, graceDays));

    if (staleReportGoals.length) {
      const placeholders = staleReportGoals.map(() => "?").join(", ");
      (await db.prepare(
        `
        UPDATE report_week_goal
        SET
          task_state = 'missed',
          description = CASE
            WHEN TRIM(COALESCE(description, '')) = '' THEN ?
            ELSE description
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `,
      ).run("Relatório não foi entregue nessa quinzena", ...staleReportGoals.map((goal) => goal.id)));
    }

    return {
      updatedCount: staleTasks.length + staleReportGoals.length,
      taskIds: staleTasks.map((task) => task.id),
      goalIds: staleReportGoals.map((goal) => goal.id),
    };
  }));
}

// FUNCAO: createPlannerTask.
async function createPlannerTask({
  projectId,
  assignedMemberId,
  createdByUserId,
  title,
  description = "",
  status = "todo",
  workflowState = "active",
  priority = "medium",
  label = null,
  dueAt,
  recurrenceIntervalDays = null,
  recurrenceUnit = null,
  recurrenceEvery = null,
  recurrenceMemberQueue = null,
  recurrenceNextIndex = null,
}) {
  return withTransaction(async () => {
  const recurrenceQueueText = Array.isArray(recurrenceMemberQueue)
    ? recurrenceMemberQueue
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
      .join(",")
    : null;
  const result = (await getDb()
    .prepare(
      `
      INSERT INTO planner_task (
        project_id,
        assigned_member_id,
        created_by_user_id,
        title,
        description,
        status,
        workflow_state,
        priority,
        label,
        due_at,
        recurrence_interval_days,
        recurrence_unit,
        recurrence_every,
        recurrence_member_queue,
        recurrence_next_index
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(
      projectId,
      assignedMemberId,
      createdByUserId,
      title,
      description,
      normalizePlannerStatus(status),
      normalizePlannerWorkflowState(workflowState),
      normalizePlannerPriority(priority),
      label,
      dueAt,
      recurrenceIntervalDays,
      normalizePlannerRecurrenceUnit(recurrenceUnit),
      recurrenceEvery,
      recurrenceQueueText || null,
      recurrenceNextIndex,
    ));
  const createdTask = (await getPlannerTaskById(result.lastInsertRowid));
  if (createdTask) {
    (await createTaskAuditLog({
      taskId: createdTask.id,
      memberId: createdTask.assigned_member_id,
      projectId: createdTask.project_id,
      eventType: "task_created",
      actorUserId: createdByUserId || null,
      payload: {
        title: createdTask.title,
        due_at: createdTask.due_at,
      },
    }));
  }

  return createdTask;

  });
}

// FUNCAO: getPlannerTaskById.
async function getPlannerTaskById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.project_id,
        t.assigned_member_id,
        t.created_by_user_id,
        t.title,
        t.description,
        t.status,
        t.priority,
        t.label,
        t.due_at,
        t.is_completed,
        t.completed_at,
        t.completed_late,
        t.workflow_state,
        t.missed_at,
        t.last_extended_at,
        t.last_extended_by_user_id,
        t.recurrence_interval_days,
        t.recurrence_unit,
        t.recurrence_every,
        t.recurrence_member_queue,
        t.recurrence_next_index,
        t.created_at,
        t.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM planner_task t
      INNER JOIN project p ON p.id = t.project_id
      INNER JOIN member m ON m.id = t.assigned_member_id
      LEFT JOIN "user" u ON u.id = t.created_by_user_id
      WHERE t.id = ?
      LIMIT 1
    `,
    )
    .get(id));

  return mapPlannerTask(row);
}

// FUNCAO: listPlannerTasks.
async function listPlannerTasks({
  projectId = null,
  memberId = null,
  includeCompleted = true,
  includeMissed = true,
  workflowState = null,
  dueFrom = null,
  dueTo = null,
  limit = 240,
} = {}) {
  const where = [];
  const params = [];

  if (projectId) {
    where.push("t.project_id = ?");
    params.push(projectId);
  }

  if (memberId) {
    where.push("t.assigned_member_id = ?");
    params.push(memberId);
  }

  if (dueFrom) {
    where.push("t.due_at >= ?");
    params.push(dueFrom);
  }

  if (dueTo) {
    where.push("t.due_at < ?");
    params.push(dueTo);
  }

  if (!includeCompleted) {
    where.push("t.is_completed = 0");
  }

  if (!includeMissed) {
    where.push("t.workflow_state <> 'missed'");
  } else if (workflowState) {
    where.push("t.workflow_state = ?");
    params.push(normalizePlannerWorkflowState(workflowState));
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return (await getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.project_id,
        t.assigned_member_id,
        t.created_by_user_id,
        t.title,
        t.description,
        t.status,
        t.priority,
        t.label,
        t.due_at,
        t.is_completed,
        t.completed_at,
        t.completed_late,
        t.workflow_state,
        t.missed_at,
        t.last_extended_at,
        t.last_extended_by_user_id,
        t.recurrence_interval_days,
        t.recurrence_unit,
        t.recurrence_every,
        t.recurrence_member_queue,
        t.recurrence_next_index,
        t.created_at,
        t.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM planner_task t
      INNER JOIN project p ON p.id = t.project_id
      INNER JOIN member m ON m.id = t.assigned_member_id
      LEFT JOIN "user" u ON u.id = t.created_by_user_id
      ${whereClause}
      ORDER BY t.due_at ASC, t.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit))
    .map(mapPlannerTask);
}

// FUNCAO: deletePlannerTask.
async function deletePlannerTask(id, { actorUserId = null, reportGoalId = null } = {}) {
  return (await withTransaction(async (db) => {
    const taskRow = (await db
      .prepare(
        `
        SELECT id, project_id, assigned_member_id, title, due_at, status, workflow_state
        FROM planner_task
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(id));
    if (!taskRow) {
      return false;
    }

    (await createTaskAuditLog({
      db,
      taskId: taskRow.id,
      reportGoalId,
      memberId: taskRow.assigned_member_id,
      projectId: taskRow.project_id,
      eventType: "task_deleted",
      actorUserId,
      payload: {
        title: taskRow.title,
        due_at: taskRow.due_at,
        status: taskRow.status,
        workflow_state: taskRow.workflow_state,
      },
    }));

    (await db.prepare(
      `
      DELETE FROM planner_task_completion_log
      WHERE task_id = ?
    `,
    ).run(id));

    const result = (await db.prepare(
      `
      DELETE FROM planner_task
      WHERE id = ?
    `,
    ).run(id));

    return Number(result.changes || 0) > 0;
  }));
}

// FUNCAO: updatePlannerTaskCompletion.
async function updatePlannerTaskCompletion({
  id,
  isCompleted,
  completedAt = null,
  updatedAt = null,
  actorUserId = null,
}) {
  return withTransaction(async () => {
  const before = (await getPlannerTaskById(id));
  if (!before) {
    return null;
  }

  const result = (await getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        is_completed = ?,
        status = CASE WHEN ? = 1 THEN 'done' ELSE status END,
        workflow_state = CASE WHEN ? = 1 THEN 'active' ELSE workflow_state END,
        completed_at = ?,
        completed_late = 0,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      isCompleted ? completedAt : null,
      updatedAt || null,
      id,
    ));

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = (await getPlannerTaskById(id));
  if (updated) {
    (await createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: isCompleted ? "task_completed" : "task_reopened",
      actorUserId,
      payload: {
        from: before.is_completed ? 1 : 0,
        to: updated.is_completed ? 1 : 0,
      },
      createdAt: updatedAt || completedAt || null,
    }));
  }

  return updated;

  });
}

// FUNCAO: updatePlannerTaskStatus.
async function updatePlannerTaskStatus({
  id,
  status,
  updatedAt = null,
  actorUserId = null,
}) {
  return withTransaction(async () => {
  const before = (await getPlannerTaskById(id));
  if (!before) {
    return null;
  }

  const normalizedStatus = normalizePlannerStatus(status);
  const isDone = normalizedStatus === "done";
  const result = (await getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        status = ?,
        is_completed = ?,
        completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, CAST(CURRENT_TIMESTAMP AS TEXT)) ELSE NULL END,
        completed_late = 0,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      normalizedStatus,
      isDone ? 1 : 0,
      isDone ? 1 : 0,
      updatedAt || null,
      id,
    ));

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = (await getPlannerTaskById(id));
  if (updated) {
    (await createTaskAuditLog({
      taskId: updated.id,
      reportGoalId: null,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "status_changed",
      actorUserId,
      payload: {
        from: before.status,
        to: updated.status,
      },
    }));
  }

  return updated;

  });
}

// FUNCAO: updatePlannerTaskDetails.
async function updatePlannerTaskDetails({
  id,
  projectId,
  assignedMemberId,
  title,
  description = "",
  dueAt,
  status = null,
  priority = null,
  label = null,
  updatedAt = null,
  actorUserId = null,
}) {
  return withTransaction(async () => {
  const before = (await getPlannerTaskById(id));
  if (!before) {
    return null;
  }

  const normalizedStatus = status ? normalizePlannerStatus(status) : before.status;
  const normalizedPriority = priority ? normalizePlannerPriority(priority) : before.priority;
  const normalizedLabel = label === undefined ? before.label : label;
  const normalizedUpdatedAt = updatedAt || toSqlDateTime(new Date());
  const isDone = normalizedStatus === "done";
  const result = (await getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        project_id = ?,
        assigned_member_id = ?,
        title = ?,
        description = ?,
        due_at = ?,
        status = ?,
        priority = ?,
        label = ?,
        is_completed = ?,
        completed_at = CASE
          WHEN ? = 1 THEN COALESCE(completed_at, CAST(CURRENT_TIMESTAMP AS TEXT))
          ELSE NULL
        END,
        completed_late = CASE
          WHEN ? = 1 THEN completed_late
          ELSE 0
        END,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      projectId,
      assignedMemberId,
      title,
      description,
      dueAt,
      normalizedStatus,
      normalizedPriority,
      normalizedLabel,
      isDone ? 1 : 0,
      isDone ? 1 : 0,
      isDone ? 1 : 0,
      normalizedUpdatedAt,
      id,
    ));

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = (await getPlannerTaskById(id));
  if (updated) {
    (await createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "task_updated",
      actorUserId,
      payload: {
        before: {
          project_id: before.project_id,
          assigned_member_id: before.assigned_member_id,
          title: before.title,
          description: before.description,
          due_at: before.due_at,
          status: before.status,
          priority: before.priority,
          label: before.label,
        },
        after: {
          project_id: updated.project_id,
          assigned_member_id: updated.assigned_member_id,
          title: updated.title,
          description: updated.description,
          due_at: updated.due_at,
          status: updated.status,
          priority: updated.priority,
          label: updated.label,
        },
      },
    }));
  }

  return updated;

  });
}

// FUNCAO: markPlannerTaskDoneLate.
async function markPlannerTaskDoneLate({
  id,
  actorUserId = null,
  completedAt = null,
  title = null,
  description = null,
  dueAt = null,
}) {
  return withTransaction(async () => {
  const before = (await getPlannerTaskById(id));
  if (!before) {
    return null;
  }

  const doneAt = completedAt || toSqlDateTime(new Date());
  const result = (await getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        due_at = COALESCE(?, due_at),
        is_completed = 1,
        status = 'done',
        workflow_state = 'active',
        completed_at = ?,
        completed_late = 1,
        missed_at = NULL,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(title, description, dueAt, doneAt, doneAt, id));

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = (await getPlannerTaskById(id));
  if (updated) {
    (await createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "task_done_late",
      actorUserId,
      payload: {
        previous_state: before.workflow_state,
        missed_at: before.missed_at,
      },
      createdAt: doneAt,
    }));
  }

  return updated;

  });
}

// FUNCAO: extendPlannerTaskDeadline.
async function extendPlannerTaskDeadline({
  id,
  dueAt,
  actorUserId = null,
  reason = null,
  updatedAt = null,
}) {
  return withTransaction(async () => {
  const before = (await getPlannerTaskById(id));
  if (!before) {
    return null;
  }

  const stamp = updatedAt || toSqlDateTime(new Date());
  const result = (await getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        due_at = ?,
        workflow_state = 'active',
        missed_at = NULL,
        last_extended_at = ?,
        last_extended_by_user_id = ?,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      dueAt,
      stamp,
      actorUserId,
      stamp,
      id,
    ));

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = (await getPlannerTaskById(id));
  if (updated) {
    (await createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "deadline_extended",
      actorUserId,
      payload: {
        previous_due_at: before.due_at,
        next_due_at: updated.due_at,
        reason: String(reason || "").trim() || null,
      },
      createdAt: stamp,
    }));
  }

  return updated;

  });
}

// FUNCAO: createPlannerTaskCompletionLog.
async function createPlannerTaskCompletionLog({
  taskId,
  projectId,
  assignedMemberId,
  completedByUserId,
  title,
  description = "",
  status = "done",
  priority = "medium",
  label = null,
  dueAt,
  completedAt,
}) {
  return withTransaction(async () => {
  const result = (await getDb()
    .prepare(
      `
      INSERT INTO planner_task_completion_log (
        task_id,
        project_id,
        assigned_member_id,
        completed_by_user_id,
        title,
        description,
        status,
        priority,
        label,
        due_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(
      taskId,
      projectId,
      assignedMemberId,
      completedByUserId,
      title,
      description,
      normalizePlannerStatus(status),
      normalizePlannerPriority(priority),
      label,
      dueAt,
      completedAt || null,
    ));

  return Number(result.lastInsertRowid || 0);

  });
}

// FUNCAO: listPlannerTaskCompletionLogs.
async function listPlannerTaskCompletionLogs({
  projectId = null,
  memberId = null,
  limit = 60,
} = {}) {
  const where = [];
  const params = [];

  if (projectId) {
    where.push("l.project_id = ?");
    params.push(projectId);
  }
  if (memberId) {
    where.push("l.assigned_member_id = ?");
    params.push(memberId);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return (await getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.task_id,
        l.project_id,
        l.assigned_member_id,
        l.completed_by_user_id,
        l.title,
        l.description,
        l.status,
        l.priority,
        l.label,
        l.due_at,
        l.completed_at,
        p.name AS project_name,
        m.name AS member_name,
        m.photo AS member_photo,
        u.username AS completed_by_username,
        u.name AS completed_by_name
      FROM planner_task_completion_log l
      INNER JOIN project p ON p.id = l.project_id
      INNER JOIN member m ON m.id = l.assigned_member_id
      INNER JOIN "user" u ON u.id = l.completed_by_user_id
      ${whereClause}
      ORDER BY CAST(l.completed_at AS timestamp) DESC, l.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit))
    .map(mapPlannerTaskCompletionLog);
}

// SECAO: inventario e movimentacoes (retirada, emprestimo, prorrogacao e devolucao).

// FUNCAO: listInventoryItems.
async function listInventoryItems({ type = null } = {}) {
  const normalizedType = type ? normalizeInventoryType(type) : null;
  const sql = normalizedType
    ? `
      SELECT id, name, item_type, category, category_id, location, location_id, amount, description
      FROM estoque
      WHERE item_type = ?
      ORDER BY name ASC, id ASC
    `
    : `
      SELECT id, name, item_type, category, category_id, location, location_id, amount, description
      FROM estoque
      ORDER BY name ASC, id ASC
    `;

  const rows = normalizedType
    ? (await getDb().prepare(sql).all(normalizedType))
    : (await getDb().prepare(sql).all());

  return rows.map(mapInventoryItem);
}

// FUNCAO: getInventoryItemById.
async function getInventoryItemById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT id, name, item_type, category, category_id, location, location_id, amount, description
      FROM estoque
      WHERE id = ?
    `,
    )
    .get(id));

  return mapInventoryItem(row);
}

// FUNCAO: createInventoryItem.
async function createInventoryItem({
  name,
  itemType = "stock",
  category,
  categoryId = null,
  location = null,
  locationId = null,
  quantity,
  description,
}) {
  return (await withTransaction(async (db) => {
    const resolvedCategory = (await resolveInventoryCatalogEntry({
      db,
      table: "inventory_category",
      id: categoryId,
      name: category,
    }));
    const resolvedLocation = (await resolveInventoryCatalogEntry({
      db,
      table: "inventory_location",
      id: locationId,
      name: location,
    }));

    const result = (await db
      .prepare(
        `
        INSERT INTO estoque (name, item_type, category, category_id, location, location_id, amount, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `,
      )
      .run(
        name,
        normalizeInventoryType(itemType),
        resolvedCategory?.name || trimCatalogValue(category),
        resolvedCategory?.id || null,
        resolvedLocation?.name || trimCatalogValue(location),
        resolvedLocation?.id || null,
        quantity,
        description,
      ));

    return (await getInventoryItemById(result.lastInsertRowid));
  }));
}

// FUNCAO: updateInventoryItem.
async function updateInventoryItem(
  id,
  {
    name,
    itemType = "stock",
    category,
    categoryId = null,
    location = null,
    locationId = null,
    quantity,
    description,
  },
) {
  return (await withTransaction(async (db) => {
    const current = (await db
      .prepare(
        `
        SELECT id, item_type
        FROM estoque
        WHERE id = ?
      `,
      )
      .get(id));

    if (!current) {
      return null;
    }

    const normalizedItemType = normalizeInventoryType(itemType);
    if (current.item_type === "patrimony" && normalizedItemType === "stock") {
      const activeLoanCount =
        (await db.prepare(
          `
          SELECT COUNT(*) AS total
          FROM inventory_loan
          WHERE item_id = ?
            AND returned_at IS NULL
        `,
        ).get(id))?.total || 0;

      if (Number(activeLoanCount) > 0) {
        throw new Error(
          "Este patrimônio possui empréstimo em aberto e não pode ser alterado para estoque.",
        );
      }
    }

    const resolvedCategory = (await resolveInventoryCatalogEntry({
      db,
      table: "inventory_category",
      id: categoryId,
      name: category,
    }));
    const resolvedLocation = (await resolveInventoryCatalogEntry({
      db,
      table: "inventory_location",
      id: locationId,
      name: location,
    }));

    (await db.prepare(
      `
      UPDATE estoque
      SET
        name = ?,
        item_type = ?,
        category = ?,
        category_id = ?,
        location = ?,
        location_id = ?,
        amount = ?,
        description = ?
      WHERE id = ?
    `,
    ).run(
      name,
      normalizedItemType,
      resolvedCategory?.name || trimCatalogValue(category),
      resolvedCategory?.id || null,
      resolvedLocation?.name || trimCatalogValue(location),
      resolvedLocation?.id || null,
      quantity,
      description,
      id,
    ));

    return (await getInventoryItemById(id));
  }));
}

// FUNCAO: deleteInventoryItem.
async function deleteInventoryItem(id) {
  return (await withTransaction(async (db) => {
    const item = (await db
      .prepare(
        `
        SELECT id, name, item_type, category, category_id, location, location_id, amount, description
        FROM estoque
        WHERE id = ?
      `,
      )
      .get(id));

    if (!item) {
      return null;
    }

    const loanCount =
      (await db.prepare("SELECT COUNT(*) AS total FROM inventory_loan WHERE item_id = ?").get(id))
        ?.total || 0;

    if (loanCount > 0) {
      throw new Error(
        "Este item possui histórico de empréstimos e não pode ser removido.",
      );
    }

    (await db.prepare("DELETE FROM pedido WHERE estoque_id = ?").run(id));
    (await db.prepare("DELETE FROM estoque WHERE id = ?").run(id));
    return mapInventoryItem(item);
  }));
}

// FUNCAO: withdrawInventoryItem.
async function withdrawInventoryItem({ nameOrCode, quantity, userId }) {
  return (await withTransaction(async (db) => {
    const item = (await db
      .prepare(
        `
        SELECT id, name, item_type, category, category_id, location, location_id, amount, description
        FROM estoque
        WHERE item_type = 'stock'
          AND (LOWER(name) = LOWER(?) OR CAST(id AS TEXT) = ?)
        ORDER BY id
        LIMIT 1
      `,
      )
      .get(nameOrCode, nameOrCode));

    if (!item) {
      return {
        success: false,
        message: "Item de estoque não encontrado. Materiais patrimoniais devem ser emprestados.",
      };
    }

    if (item.amount < quantity) {
      return { success: false, message: "Quantidade insuficiente no estoque." };
    }

    const newQuantity = item.amount - quantity;
    (await db.prepare("UPDATE estoque SET amount = ? WHERE id = ?").run(newQuantity, item.id));
    (await db.prepare(
      `
      INSERT INTO pedido (qtd_retirada, usuario_id, estoque_id, data_pedido)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `,
    ).run(quantity, userId, item.id));

    return {
      success: true,
      message: "Item retirado com sucesso e registrado no histórico.",
      item: {
        ...item,
        amount: newQuantity,
      },
    };
  }));
}

// FUNCAO: getInventoryLoanById.
async function getInventoryLoanById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.item_id,
        l.user_id,
        l.quantity,
        l.borrowed_at,
        l.original_due_at,
        l.due_at,
        l.returned_at,
        l.extended_at,
        l.extended_by_user_id,
        l.returned_by_user_id,
        e.name AS item_name,
        e.item_type,
        e.category AS item_category,
        u.name AS user_name,
        u.username AS user_username,
        u.role AS user_role,
        eu.name AS extended_by_name,
        ru.name AS returned_by_name
      FROM inventory_loan l
      INNER JOIN estoque e ON e.id = l.item_id
      INNER JOIN user u ON u.id = l.user_id
      LEFT JOIN user eu ON eu.id = l.extended_by_user_id
      LEFT JOIN user ru ON ru.id = l.returned_by_user_id
      WHERE l.id = ?
    `,
    )
    .get(id));

  return mapInventoryLoan(row);
}

// FUNCAO: borrowInventoryItem.
async function borrowInventoryItem({ nameOrCode, quantity, userId }) {
  return (await withTransaction(async (db) => {
    const item = (await db
      .prepare(
        `
        SELECT id, name, item_type, category, category_id, location, location_id, amount, description
        FROM estoque
        WHERE item_type = 'patrimony'
          AND (LOWER(name) = LOWER(?) OR CAST(id AS TEXT) = ?)
        ORDER BY id
        LIMIT 1
      `,
      )
      .get(nameOrCode, nameOrCode));

    if (!item) {
      return {
        success: false,
        message: "Material patrimonial não encontrado para empréstimo.",
      };
    }

    if (item.amount < quantity) {
      return {
        success: false,
        message: "Quantidade insuficiente disponível para empréstimo.",
      };
    }

    const newQuantity = item.amount - quantity;
    const dueAt = addDaysToNow(7);

    (await db.prepare("UPDATE estoque SET amount = ? WHERE id = ?").run(newQuantity, item.id));
    const result = (await db
      .prepare(
        `
        INSERT INTO inventory_loan (
          item_id,
          user_id,
          quantity,
          original_due_at,
          due_at
        )
        VALUES (?, ?, ?, ?, ?)
        RETURNING id
      `,
      )
      .run(item.id, userId, quantity, dueAt, dueAt));

    return {
      success: true,
      message: "Empréstimo registrado com sucesso. A devolução está prevista para 7 dias.",
      loan: (await getInventoryLoanById(result.lastInsertRowid)),
      item: {
        ...item,
        amount: newQuantity,
      },
    };
  }));
}

// FUNCAO: extendInventoryLoan.
async function extendInventoryLoan({ loanId, extraDays, actorUserId }) {
  return (await withTransaction(async (db) => {
    const loan = (await db
      .prepare(
        `
        SELECT id, due_at, returned_at
        FROM inventory_loan
        WHERE id = ?
      `,
      )
      .get(loanId));

    if (!loan) {
      return { success: false, message: "Empréstimo não encontrado." };
    }

    if (loan.returned_at) {
      return {
        success: false,
        message: "Este empréstimo já foi encerrado e não pode ser prorrogado.",
      };
    }

    const dueDate = new Date(String(loan.due_at).replace(" ", "T"));
    dueDate.setDate(dueDate.getDate() + extraDays);
    const nextDueAt = toSqlDateTime(dueDate);

    (await db.prepare(
      `
      UPDATE inventory_loan
      SET due_at = ?, extended_at = CURRENT_TIMESTAMP, extended_by_user_id = ?
      WHERE id = ?
    `,
    ).run(nextDueAt, actorUserId, loanId));

    return {
      success: true,
      message: "Prazo do empréstimo prorrogado com sucesso.",
      loan: (await getInventoryLoanById(loanId)),
    };
  }));
}

// FUNCAO: returnInventoryLoan.
async function returnInventoryLoan({ loanId, actorUserId }) {
  return (await withTransaction(async (db) => {
    const loan = (await db
      .prepare(
        `
        SELECT id, item_id, quantity, returned_at
        FROM inventory_loan
        WHERE id = ?
      `,
      )
      .get(loanId));

    if (!loan) {
      return { success: false, message: "Empréstimo não encontrado." };
    }

    if (loan.returned_at) {
      return {
        success: false,
        message: "Este empréstimo já foi devolvido anteriormente.",
      };
    }

    (await db.prepare(
      `
      UPDATE estoque
      SET amount = amount + ?
      WHERE id = ?
    `,
    ).run(loan.quantity, loan.item_id));

    (await db.prepare(
      `
      UPDATE inventory_loan
      SET returned_at = CURRENT_TIMESTAMP, returned_by_user_id = ?
      WHERE id = ?
    `,
    ).run(actorUserId, loanId));

    return {
      success: true,
      message: "Devolução registrada com sucesso.",
      loan: (await getInventoryLoanById(loanId)),
    };
  }));
}

// FUNCAO: listInventoryRequests.
async function listInventoryRequests(limit = null) {
  const sql = `
    SELECT
      p.id AS pedido_id,
      p.usuario_id,
      p.estoque_id,
      u.name AS nome_usuario,
      u.username AS username_usuario,
      u.role AS role_usuario,
      e.name AS nome_item_estoque,
      p.qtd_retirada,
      p.data_pedido
    FROM pedido p
    INNER JOIN user u ON u.id = p.usuario_id
    INNER JOIN estoque e ON e.id = p.estoque_id
    ORDER BY p.data_pedido DESC, p.id DESC
  `;

  const rows = limit
    ? (await getDb().prepare(`${sql} LIMIT ?`).all(limit))
    : (await getDb().prepare(sql).all());

  return rows.map((row) => ({
    pedido_id: row.pedido_id,
    usuario_id: row.usuario_id,
    estoque_id: row.estoque_id,
    nome_usuario: row.nome_usuario || row.username_usuario,
    username_usuario: row.username_usuario,
    role_usuario: row.role_usuario,
    nome_item_estoque: row.nome_item_estoque,
    qtd_retirada: row.qtd_retirada,
    data_pedido: row.data_pedido,
  }));
}

// FUNCAO: listInventoryLoans.
async function listInventoryLoans({ status = null, limit = null } = {}) {
  const conditions = [];
  const params = [];
  const nowSql = toSqlDateTime(new Date());
  let orderBy = `
    ORDER BY
      CASE WHEN l.returned_at IS NULL THEN 0 ELSE 1 END,
      l.due_at ASC,
      l.borrowed_at DESC,
      l.id DESC
  `;

  if (status === "active") {
    conditions.push("l.returned_at IS NULL");
    orderBy = `
      ORDER BY
        l.due_at ASC,
        l.borrowed_at DESC,
        l.id DESC
    `;
  } else if (status === "returned") {
    conditions.push("l.returned_at IS NOT NULL");
    orderBy = `
      ORDER BY
        l.returned_at DESC,
        l.id DESC
    `;
  } else if (status === "overdue") {
    conditions.push("l.returned_at IS NULL");
    conditions.push("l.due_at < ?");
    params.push(nowSql);
    orderBy = `
      ORDER BY
        l.due_at ASC,
        l.borrowed_at DESC,
        l.id DESC
    `;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT
      l.id,
      l.item_id,
      l.user_id,
      l.quantity,
      l.borrowed_at,
      l.original_due_at,
      l.due_at,
      l.returned_at,
      l.extended_at,
      l.extended_by_user_id,
      l.returned_by_user_id,
      e.name AS item_name,
      e.item_type,
      e.category AS item_category,
      u.name AS user_name,
      u.username AS user_username,
      u.role AS user_role,
      eu.name AS extended_by_name,
      ru.name AS returned_by_name
    FROM inventory_loan l
    INNER JOIN estoque e ON e.id = l.item_id
    INNER JOIN user u ON u.id = l.user_id
    LEFT JOIN user eu ON eu.id = l.extended_by_user_id
    LEFT JOIN user ru ON ru.id = l.returned_by_user_id
    ${whereClause}
    ${orderBy}
  `;

  const statement = limit ? `${sql} LIMIT ?` : sql;
  const rows = limit
    ? (await getDb().prepare(statement).all(...params, limit))
    : (await getDb().prepare(statement).all(...params));

  return rows.map(mapInventoryLoan);
}

// SECAO: agregacoes para dashboard do almoxarifado.

// FUNCAO: getInventoryDashboardData.
async function getInventoryDashboardData() {
  const db = getDb();
  const summaryStats = (await db
    .prepare(
      `
      SELECT
        COUNT(*) AS item_count,
        COALESCE(SUM(CASE WHEN item_type = 'stock' THEN 1 ELSE 0 END), 0) AS stock_item_count,
        COALESCE(SUM(CASE WHEN item_type = 'patrimony' THEN 1 ELSE 0 END), 0) AS patrimony_item_count,
        COALESCE(SUM(amount), 0) AS total_units,
        COALESCE(SUM(CASE WHEN item_type = 'stock' THEN amount ELSE 0 END), 0) AS stock_units,
        COALESCE(SUM(CASE WHEN item_type = 'patrimony' THEN amount ELSE 0 END), 0) AS patrimony_units,
        (SELECT COUNT(*) FROM inventory_category) AS category_count,
        (SELECT COUNT(*) FROM inventory_location) AS location_count,
        (SELECT COUNT(*) FROM "user" WHERE is_active = 1) AS user_count,
        (SELECT COUNT(*) FROM pedido) AS request_count,
        (SELECT COUNT(*) FROM inventory_loan WHERE returned_at IS NULL) AS active_loan_count,
        (
          SELECT COUNT(*) FROM inventory_loan
          WHERE returned_at IS NULL AND due_at < ?
        ) AS overdue_loan_count
      FROM estoque
    `,
    )
    .get(toSqlDateTime(new Date()))) || {};
  const summary = {
    user_count: Number(summaryStats.user_count || 0),
    item_count: Number(summaryStats.item_count || 0),
    stock_item_count: Number(summaryStats.stock_item_count || 0),
    patrimony_item_count: Number(summaryStats.patrimony_item_count || 0),
    category_count: Number(summaryStats.category_count || 0),
    location_count: Number(summaryStats.location_count || 0),
    request_count: Number(summaryStats.request_count || 0),
    active_loan_count: Number(summaryStats.active_loan_count || 0),
    overdue_loan_count: Number(summaryStats.overdue_loan_count || 0),
    total_units: Number(summaryStats.total_units || 0),
    stock_units: Number(summaryStats.stock_units || 0),
    patrimony_units: Number(summaryStats.patrimony_units || 0),
  };

  return {
    summary,
    recent_requests: (await listInventoryRequests(6)),
    recent_loans: (await listInventoryLoans({ status: "active", limit: 6 })),
    recent_users: (await db
      .prepare(
        `
        SELECT id, username, name, role, is_active, deactivated_at
        FROM user
        WHERE is_active = 1
        ORDER BY id DESC
        LIMIT 6
      `,
      )
      .all())
      .map(mapUser),
  };
}

async function listWritingGeneralEntries() {
  return (await getDb()
    .prepare(
      `
      SELECT
        e.id,
        e.title,
        e.content,
        e.author_user_id,
        e.created_at,
        e.updated_at,
        u.username AS author_username,
        u.name AS author_name
      FROM writing_general_entry e
      INNER JOIN "user" u ON u.id = e.author_user_id
      ORDER BY CAST(COALESCE(e.updated_at, e.created_at) AS timestamp) DESC, e.id DESC
    `,
    )
    .all())
    .map(mapWritingGeneralEntry);
}

async function getWritingGeneralEntryById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        e.id,
        e.title,
        e.content,
        e.author_user_id,
        e.created_at,
        e.updated_at,
        u.username AS author_username,
        u.name AS author_name
      FROM writing_general_entry e
      INNER JOIN "user" u ON u.id = e.author_user_id
      WHERE e.id = ?
    `,
    )
    .get(id));
  return mapWritingGeneralEntry(row);
}

async function createWritingGeneralEntry({ title, content, authorUserId }) {
  return withTransaction(async () => {
  const result = (await getDb()
    .prepare(
      `
      INSERT INTO writing_general_entry (title, content, author_user_id)
      VALUES (?, ?, ?)
      RETURNING id
    `,
    )
    .run(title, content, authorUserId));
  return (await getWritingGeneralEntryById(result.lastInsertRowid));

  });
}

async function updateWritingGeneralEntry(id, { title, content }) {
  return withTransaction(async () => {
  const current = (await getWritingGeneralEntryById(id));
  if (!current) {
    return null;
  }

  const updatedAt = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      UPDATE writing_general_entry
      SET title = ?, content = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(title, content, updatedAt, id));
  return (await getWritingGeneralEntryById(id));

  });
}

async function deleteWritingGeneralEntry(id) {
  return withTransaction(async () => {
  const current = (await getWritingGeneralEntryById(id));
  if (!current) {
    return null;
  }

  (await getDb().prepare("DELETE FROM writing_general_entry WHERE id = ?").run(id));
  return current;

  });
}

async function listWritingTutorPrivateEntries(tutorUserId) {
  return (await getDb()
    .prepare(
      `
      SELECT
        e.id,
        e.title,
        e.content,
        e.tutor_user_id,
        e.created_at,
        e.updated_at,
        u.username AS tutor_username,
        u.name AS tutor_name
      FROM writing_tutor_private_entry e
      INNER JOIN "user" u ON u.id = e.tutor_user_id
      WHERE e.tutor_user_id = ?
      ORDER BY CAST(COALESCE(e.updated_at, e.created_at) AS timestamp) DESC, e.id DESC
    `,
    )
    .all(tutorUserId))
    .map(mapWritingTutorPrivateEntry);
}

async function getWritingTutorPrivateEntryById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        e.id,
        e.title,
        e.content,
        e.tutor_user_id,
        e.created_at,
        e.updated_at,
        u.username AS tutor_username,
        u.name AS tutor_name
      FROM writing_tutor_private_entry e
      INNER JOIN "user" u ON u.id = e.tutor_user_id
      WHERE e.id = ?
    `,
    )
    .get(id));
  return mapWritingTutorPrivateEntry(row);
}

async function createWritingTutorPrivateEntry({ title, content, tutorUserId }) {
  return withTransaction(async () => {
  const result = (await getDb()
    .prepare(
      `
      INSERT INTO writing_tutor_private_entry (title, content, tutor_user_id)
      VALUES (?, ?, ?)
      RETURNING id
    `,
    )
    .run(title, content, tutorUserId));
  return (await getWritingTutorPrivateEntryById(result.lastInsertRowid));

  });
}

async function updateWritingTutorPrivateEntry(id, { title, content }) {
  return withTransaction(async () => {
  const current = (await getWritingTutorPrivateEntryById(id));
  if (!current) {
    return null;
  }

  const updatedAt = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      UPDATE writing_tutor_private_entry
      SET title = ?, content = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(title, content, updatedAt, id));
  return (await getWritingTutorPrivateEntryById(id));

  });
}

async function deleteWritingTutorPrivateEntry(id) {
  return withTransaction(async () => {
  const current = (await getWritingTutorPrivateEntryById(id));
  if (!current) {
    return null;
  }

  (await getDb().prepare("DELETE FROM writing_tutor_private_entry WHERE id = ?").run(id));
  return current;

  });
}

async function getReportFortnightTutorNote({ tutorUserId, memberId, weekStart }) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        n.id,
        n.tutor_user_id,
        n.member_id,
        n.week_start,
        n.content,
        n.sent_to_chat_at,
        n.sent_to_chat_conversation_id,
        n.created_at,
        n.updated_at,
        u.username AS tutor_username,
        u.name AS tutor_name,
        m.name AS member_name
      FROM report_fortnight_tutor_note n
      INNER JOIN "user" u ON u.id = n.tutor_user_id
      INNER JOIN member m ON m.id = n.member_id
      WHERE n.tutor_user_id = ?
        AND n.member_id = ?
        AND n.week_start = ?
      LIMIT 1
    `,
    )
    .get(tutorUserId, memberId, weekStart));
  return mapReportFortnightTutorNote(row);
}

async function upsertReportFortnightTutorNote({ tutorUserId, memberId, weekStart, content }) {
  return withTransaction(async () => {
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) {
    throw new Error("Conteúdo da avaliação é obrigatório.");
  }
  const current = (await getReportFortnightTutorNote({ tutorUserId, memberId, weekStart }));
  if (!current) {
    const inserted = (await getDb()
      .prepare(
        `
        INSERT INTO report_fortnight_tutor_note (tutor_user_id, member_id, week_start, content)
        VALUES (?, ?, ?, ?)
        RETURNING id
      `,
      )
      .run(tutorUserId, memberId, weekStart, normalizedContent));
    return (await getReportFortnightTutorNote({
      tutorUserId,
      memberId,
      weekStart,
    })) || mapReportFortnightTutorNote({ id: inserted.lastInsertRowid });
  }

  const updatedAt = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      UPDATE report_fortnight_tutor_note
      SET content = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(normalizedContent, updatedAt, current.id));
  return (await getReportFortnightTutorNote({ tutorUserId, memberId, weekStart }));

  });
}

async function markReportFortnightTutorNoteAsSentToChat(id, conversationId) {
  return withTransaction(async () => {
  const now = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      UPDATE report_fortnight_tutor_note
      SET sent_to_chat_at = ?, sent_to_chat_conversation_id = ?
      WHERE id = ?
    `,
    )
    .run(now, conversationId, id));

  });
}

async function getReportFortnightMemberNote({ memberId, weekStart }) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        n.id,
        n.member_id,
        n.author_user_id,
        n.target_tutor_user_id,
        n.week_start,
        n.content,
        n.sent_to_chat_at,
        n.sent_to_chat_conversation_id,
        n.created_at,
        n.updated_at,
        m.name AS member_name,
        au.username AS author_username,
        au.name AS author_name,
        tu.username AS target_tutor_username,
        tu.name AS target_tutor_name
      FROM report_fortnight_member_note n
      INNER JOIN member m ON m.id = n.member_id
      INNER JOIN "user" au ON au.id = n.author_user_id
      LEFT JOIN "user" tu ON tu.id = n.target_tutor_user_id
      WHERE n.member_id = ?
        AND n.week_start = ?
      LIMIT 1
    `,
    )
    .get(memberId, weekStart));
  return mapReportFortnightMemberNote(row);
}

async function upsertReportFortnightMemberNote({
  memberId,
  authorUserId,
  targetTutorUserId = null,
  weekStart,
  content,
}) {
  return withTransaction(async () => {
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) {
    throw new Error("Conteúdo do complemento é obrigatório.");
  }
  const current = (await getReportFortnightMemberNote({ memberId, weekStart }));
  if (!current) {
    (await getDb()
      .prepare(
        `
        INSERT INTO report_fortnight_member_note (
          member_id,
          author_user_id,
          target_tutor_user_id,
          week_start,
          content
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(memberId, authorUserId, targetTutorUserId, weekStart, normalizedContent));
    return (await getReportFortnightMemberNote({ memberId, weekStart }));
  }

  const updatedAt = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      UPDATE report_fortnight_member_note
      SET
        content = ?,
        target_tutor_user_id = ?,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(normalizedContent, targetTutorUserId, updatedAt, current.id));
  return (await getReportFortnightMemberNote({ memberId, weekStart }));

  });
}

async function markReportFortnightMemberNoteAsSentToChat(id, conversationId) {
  return withTransaction(async () => {
  const now = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      UPDATE report_fortnight_member_note
      SET sent_to_chat_at = ?, sent_to_chat_conversation_id = ?
      WHERE id = ?
    `,
    )
    .run(now, conversationId, id));

  });
}

async function getUserByMemberId(memberId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.password_hash,
        u.name,
        u.email,
        u.role,
        u.member_id,
        m.name AS member_name,
        m.is_active AS member_is_active
      FROM "user" u
      LEFT JOIN member m ON m.id = u.member_id
      WHERE u.member_id = ?
      ORDER BY u.id ASC
      LIMIT 1
    `,
    )
    .get(memberId));
  return mapUser(row);
}

// Garante um usuario remetente fixo para mensagens automaticas administrativas.
async function getOrCreateAdministrativeUser() {
  const username = "administrativo";
  const existing = (await getUserByUsername(username));
  if (existing) {
    return existing;
  }
  const result = (await getDb()
    .prepare(
      `
      INSERT INTO "user" (username, password_hash, name, role, is_active)
      VALUES (?, ?, ?, 'admin', 1)
      RETURNING id
    `,
    )
    .run(username, "system-administrativo", "Administrativo"));
  return (await getUserById(result.lastInsertRowid));
}

// Data atual da aplicacao na timezone configurada, usada por ciclos automaticos.
function getCurrentAppDateKey() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

// So retorna uma data nos dias em que as advertencias devem ser processadas.
function getCurrentWarningCycleDateKey() {
  const today = getCurrentAppDateKey();
  return today.endsWith("-01-01") || today.endsWith("-07-02") ? today : null;
}

// Aplica a regra semestral: zera quem tem menos de 3 e inicia restricao para quem tem 3.
async function applySemiannualMemberWarningCycle() {
  return withTransaction(async () => {
  const cycleDateKey = getCurrentWarningCycleDateKey();
  if (!cycleDateKey) {
    return { applied: false };
  }

  const alreadyApplied = (await getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM member_warning_cycle
      WHERE cycle_date = ?
      LIMIT 1
    `,
    )
    .get(cycleDateKey));

  if (alreadyApplied?.ok) {
    return { applied: false, cycleDateKey };
  }

  const adminUser = (await getOrCreateAdministrativeUser());
  const cycleStartedAt = `${cycleDateKey} 00:00:00`;

  return (await withTransaction(async (db) => {
    const rows = (await db
      .prepare(
        `
        SELECT
          m.id,
          COALESCE(w.warning_count, 0) AS warning_count,
          wr.started_at AS restriction_started_at
        FROM member m
        LEFT JOIN LATERAL (
          SELECT e.new_count AS warning_count
          FROM member_warning_event e
          WHERE e.member_id = m.id
          ORDER BY e.id DESC
          LIMIT 1
        ) w ON true
        LEFT JOIN LATERAL (
          SELECT r.started_at
          FROM member_warning_restriction r
          WHERE r.member_id = m.id
          ORDER BY r.started_at DESC, r.id DESC
          LIMIT 1
        ) wr ON true
        WHERE m.is_active = 1
        ORDER BY m.id ASC
      `,
      )
      .all());

    (await asyncArray.forEach(rows, async (row) => {
      const currentCount = Math.max(0, Math.min(3, Number(row.warning_count || 0)));
      if (currentCount >= 3) {
        const hasRestrictionForCycle =
          row.restriction_started_at
          && String(row.restriction_started_at).slice(0, 10) >= cycleDateKey;
        if (!hasRestrictionForCycle) {
          (await db.prepare(
            `
            INSERT INTO member_warning_restriction (member_id, started_by_user_id, started_at)
            VALUES (?, ?, ?)
          `,
          ).run(row.id, adminUser.id, cycleStartedAt));
        }
        return;
      }

      if (currentCount > 0) {
        (await db.prepare(
          `
          INSERT INTO member_warning_event
            (member_id, actor_user_id, previous_count, new_count, note, event_type)
          VALUES (?, ?, ?, 0, ?, 'cycle_reset')
        `,
        ).run(row.id, adminUser.id, currentCount, `Zerado automaticamente no ciclo semestral ${cycleDateKey}.`));
      }
    }));

    (await db.prepare("INSERT INTO member_warning_cycle (cycle_date) VALUES (?)").run(cycleDateKey));

    return { applied: true, cycleDateKey };
  }));

  });
}

// Confere se o usuario pertence a um projeto pelo nome, usado em permissoes simples.
async function isUserMemberOfProjectName(userId, projectName) {
  const row = (await getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM "user" u
      INNER JOIN project_members pm ON pm.member_id = u.member_id
      INNER JOIN project p ON p.id = pm.project_id
      WHERE u.id = ?
        AND LOWER(p.name) = LOWER(?)
      LIMIT 1
    `,
    )
    .get(userId, String(projectName || "").trim()));
  return Boolean(row?.ok);
}

// Monta o estado atual de advertencias e calcula os dias restantes sem gravar um dia por vez.
function mapMemberWarningState(row) {
  const count = Math.max(0, Math.min(3, Number(row?.warning_count || 0)));
  const restrictionStartedAt = row?.restriction_started_at || null;
  let restrictionDaysRemaining = 0;
  let restrictionIsActive = false;
  if (restrictionStartedAt) {
    const start = new Date(`${String(restrictionStartedAt).slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(start.getTime())) {
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const elapsedDays = Math.floor((today.getTime() - start.getTime()) / 86400000);
      restrictionDaysRemaining = Math.max(0, 365 - elapsedDays);
      restrictionIsActive = restrictionDaysRemaining > 0;
    }
  }
  return {
    warning_count: count,
    restriction_started_at: restrictionStartedAt,
    restriction_days_remaining: restrictionDaysRemaining,
    restriction_is_active: restrictionIsActive,
  };
}

// Busca a quantidade atual de advertencias e o ultimo periodo de restricao de um membro.
async function getMemberWarningState(memberId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        COALESCE((
          SELECT e.new_count
          FROM member_warning_event e
          WHERE e.member_id = ?
          ORDER BY e.id DESC
          LIMIT 1
        ), 0) AS warning_count,
        (
          SELECT r.started_at
          FROM member_warning_restriction r
          WHERE r.member_id = ?
          ORDER BY r.started_at DESC, r.id DESC
          LIMIT 1
        ) AS restriction_started_at
    `,
    )
    .get(memberId, memberId));
  return mapMemberWarningState(row);
}

// Lista o historico completo de advertencias, incluindo edicoes e exclusoes logicas.
async function listMemberWarningEvents(memberId) {
  const events = (await getDb().prepare(`
    SELECT e.*, COALESCE(NULLIF(u.name, ''), u.username) AS actor_name
    FROM member_warning_event e
    LEFT JOIN "user" u ON u.id = e.actor_user_id
    WHERE e.member_id = ?
    ORDER BY e.id DESC
  `).all(memberId));
  return events.map((event) => {
    const revisions = events.filter((revision) => revision.target_event_id === event.id);
    const latestEdit = revisions.find((revision) => revision.event_type === "edited");
    return {
      ...event,
      is_warning: event.event_type === "added" || (event.event_type === "count_changed" && event.new_count > event.previous_count),
      is_deleted: revisions.some((revision) => revision.event_type === "deleted"),
      current_note: latestEdit ? latestEdit.note : event.note,
    };
  });
}

// Historico append-only: registros antigos e motivos originais nunca sao sobrescritos.
async function mutateMemberWarning({ memberId, actorUserId, action, warningId, note = "" }) {
  const validationError = (message) => Object.assign(new Error(message), { warningValidation: true });
  if (!(await isUserMemberOfProjectName(actorUserId, "Administrativo"))) {
    throw validationError("Somente membros do Administrativo podem alterar advertências.");
  }
  if (!["add", "edit", "delete"].includes(action)) throw validationError("Ação inválida.");
  const normalizedNote = String(note || "").trim();
  if (normalizedNote.length > 300) throw validationError("O motivo deve ter no máximo 300 caracteres.");
  return (await withTransaction(async (db) => {
    if (!(await db.prepare("SELECT id FROM member WHERE id = ? FOR UPDATE").get(memberId))) {
      throw validationError("Membro inválido.");
    }
    const current = (await getMemberWarningState(memberId));
    const target = action === "add" ? null : (await listMemberWarningEvents(memberId)).find((event) => event.id === warningId && event.is_warning && !event.is_deleted);
    if (action !== "add" && !target) throw validationError("Advertência não encontrada ou já excluída.");
    if (action === "add" && current.warning_count >= 3) throw validationError("Este membro já possui 3 advertências.");
    const count = action === "add" ? current.warning_count + 1
      : action === "delete" ? Math.max(0, current.warning_count - (target.new_count - target.previous_count))
        : current.warning_count;
    (await db.prepare(`
      INSERT INTO member_warning_event
        (member_id, actor_user_id, previous_count, new_count, note, event_type, target_event_id, previous_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(memberId, actorUserId, current.warning_count, count,
      action === "delete" ? target.current_note : normalizedNote,
      { add: "added", edit: "edited", delete: "deleted" }[action], target?.id || null, target?.current_note || null));
    return { warning_count: count, previous_count: current.warning_count, changed: true };
  }));
}

// Ajusta a quantidade total registrando uma nova linha de auditoria.
async function setMemberWarningCount({ memberId, actorUserId, newCount, note = "" }) {
  return withTransaction(async () => {
  const normalizedCount = Math.max(0, Math.min(3, Number(newCount)));
  if (!Number.isInteger(normalizedCount)) {
    throw new Error("Quantidade de advertencias invalida.");
  }
  const current = (await getMemberWarningState(memberId));
  if (current.warning_count === normalizedCount) {
    return { ...current, changed: false };
  }
  (await getDb()
    .prepare(
      `
      INSERT INTO member_warning_event (member_id, actor_user_id, previous_count, new_count, note)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(memberId, actorUserId, current.warning_count, normalizedCount, String(note || "").trim() || null));
  return { ...(await getMemberWarningState(memberId)), previous_count: current.warning_count, changed: true };

  });
}

// Inicia manualmente o periodo de acompanhamento/restricao de 365 dias.
async function startMemberWarningRestriction({ memberId, actorUserId, startedAt = null }) {
  return withTransaction(async () => {
  const normalizedStartedAt = startedAt || toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      INSERT INTO member_warning_restriction (member_id, started_by_user_id, started_at)
      VALUES (?, ?, ?)
    `,
    )
    .run(memberId, actorUserId, normalizedStartedAt));
  return (await getMemberWarningState(memberId));

  });
}

// Cria conversa read-only do Administrativo avisando todos os usuarios sobre 3 advertencias.
async function createWarningBroadcastForMember(member) {
  return withTransaction(async () => {
  if (!member?.id) {
    return null;
  }
  const adminUser = (await getOrCreateAdministrativeUser());
  const users = (await listUsers());
  const participantUserIds = users.map((user) => user.id);
  const conversation = (await createChatConversation({
    title: "Administrativo",
    createdByUserId: adminUser.id,
    participantUserIds,
    conversationKind: "system",
    themeColor: "#f1a7a6",
    avatarUrl: "img/logoadm.png",
    isReadOnly: true,
  }));
  (await createChatMessage({
    conversationId: conversation.id,
    authorUserId: adminUser.id,
    text: `${member.name} atingiu 3 advertencias.`,
  }));
  return conversation;

  });
}

// Procura conversa direta existente entre dois usuarios para evitar duplicidade.
async function findDirectConversationByUsers(userAId, userBId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT c.id
      FROM chat_conversation c
      INNER JOIN chat_conversation_participant p1
        ON p1.conversation_id = c.id AND p1.user_id = ?
      INNER JOIN chat_conversation_participant p2
        ON p2.conversation_id = c.id AND p2.user_id = ?
      INNER JOIN (
        SELECT conversation_id, COUNT(*) AS participant_count
        FROM chat_conversation_participant
        GROUP BY conversation_id
      ) pc ON pc.conversation_id = c.id
      WHERE pc.participant_count = 2
        AND COALESCE(c.conversation_kind, 'direct') = 'direct'
      ORDER BY CAST(COALESCE(c.updated_at, c.created_at) AS timestamp) DESC, c.id DESC
      LIMIT 1
    `,
    )
    .get(userAId, userBId));

  return row?.id ? (await getChatConversationById(row.id)) : null;
}

function mapChatConversation(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title || "",
    created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name || row.created_by_username || "",
    created_by_username: row.created_by_username || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    last_message_at: row.last_message_at || null,
    last_message_text: row.last_message_text || "",
    conversation_kind: row.conversation_kind || "direct",
    theme_color: row.theme_color || null,
    avatar_url: row.avatar_url || null,
    is_read_only: Boolean(row.is_read_only),
    participants_label: row.participants_label || "",
    other_user_id: row.other_user_id || null,
    other_user_name: row.other_user_name || row.other_user_username || "",
    other_user_username: row.other_user_username || "",
    other_user_photo: row.other_user_photo || null,
    unread_count: Number(row.unread_count || 0),
  };
}

function mapChatMessage(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversation_id: row.conversation_id,
    author_user_id: row.author_user_id,
    author_name: row.author_name || row.author_username || "",
    author_username: row.author_username || "",
    author_photo: row.author_photo || null,
    text: row.text || "",
    sent_at: row.sent_at || null,
  };
}

async function createChatConversation({
  title = null,
  createdByUserId,
  participantUserIds = [],
  conversationKind = "direct",
  themeColor = null,
  avatarUrl = null,
  isReadOnly = false,
}) {
  return withTransaction(async () => {
  const uniqueParticipantIds = [...new Set(
    participantUserIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];

  if (!uniqueParticipantIds.includes(Number(createdByUserId))) {
    uniqueParticipantIds.push(Number(createdByUserId));
  }

  if (conversationKind === "direct" && uniqueParticipantIds.length !== 2) {
    throw new Error("A conversa deve ter exatamente duas pessoas.");
  }

  return (await withTransaction(async (db) => {
    const now = toSqlDateTime(new Date());
    const created = (await db.prepare(
      `
      INSERT INTO chat_conversation (title, created_by_user_id, conversation_kind, theme_color, avatar_url, is_read_only)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    ).run(
      String(title || "").trim() || null,
      createdByUserId,
      conversationKind === "system" ? "system" : "direct",
      themeColor || null,
      avatarUrl || null,
      isReadOnly ? 1 : 0,
    ));

    (await asyncArray.forEach(uniqueParticipantIds, async (userId) => {
      const isCreator = Number(userId) === Number(createdByUserId);
      (await db.prepare(
        `
        INSERT INTO chat_conversation_participant (conversation_id, user_id, last_read_at)
        VALUES (?, ?, ?)
      `,
      ).run(created.lastInsertRowid, userId, isCreator ? now : null));
    }));

    return (await getChatConversationById(created.lastInsertRowid));
  }));

  });
}

async function getChatConversationById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        c.id,
        c.title,
        c.created_by_user_id,
        c.conversation_kind,
        c.theme_color,
        c.avatar_url,
        c.is_read_only,
        c.created_at,
        c.updated_at,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM chat_conversation c
      INNER JOIN "user" u ON u.id = c.created_by_user_id
      WHERE c.id = ?
    `,
    )
    .get(id));
  return mapChatConversation(row);
}

async function listChatConversationParticipants(conversationId) {
  return (await getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.name,
        u.role,
        m.photo AS member_photo
      FROM chat_conversation_participant p
      INNER JOIN "user" u ON u.id = p.user_id
      LEFT JOIN member m ON m.id = u.member_id
      WHERE p.conversation_id = ?
      ORDER BY LOWER(COALESCE(u.name, u.username)), u.id
    `,
    )
    .all(conversationId))
    .map((row) => ({
      id: row.id,
      username: row.username,
      name: row.name || row.username,
      photo: row.member_photo || null,
      role: row.role,
      is_admin: row.role === "admin" || row.role === "tutor",
    }));
}

async function isChatConversationParticipant(conversationId, userId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT 1
      FROM chat_conversation_participant
      WHERE conversation_id = ?
        AND user_id = ?
      LIMIT 1
    `,
    )
    .get(conversationId, userId));
  return Boolean(row);
}

async function listChatConversationsForUser(userId) {
  return (await getDb()
    .prepare(
      `
      SELECT
        c.id,
        c.title,
        c.created_by_user_id,
        c.conversation_kind,
        c.theme_color,
        c.avatar_url,
        c.is_read_only,
        c.created_at,
        c.updated_at,
        cu.username AS created_by_username,
        cu.name AS created_by_name,
        lm.sent_at AS last_message_at,
        lm.text AS last_message_text,
        COALESCE(uc.unread_count, 0) AS unread_count,
        CASE WHEN c.conversation_kind = 'system' THEN NULL ELSE ou.id END AS other_user_id,
        CASE WHEN c.conversation_kind = 'system' THEN NULL ELSE ou.username END AS other_user_username,
        CASE WHEN c.conversation_kind = 'system' THEN c.title ELSE ou.name END AS other_user_name,
        CASE WHEN c.conversation_kind = 'system' THEN c.avatar_url ELSE ou.photo END AS other_user_photo,
        (
          SELECT STRING_AGG(COALESCE(NULLIF(TRIM(u2.name), ''), u2.username), ', ' ORDER BY LOWER(COALESCE(NULLIF(TRIM(u2.name), ''), u2.username)))
          FROM chat_conversation_participant p2
          INNER JOIN "user" u2 ON u2.id = p2.user_id
          WHERE p2.conversation_id = c.id
        ) AS participants_label
      FROM chat_conversation_participant p
      INNER JOIN chat_conversation c ON c.id = p.conversation_id
      INNER JOIN "user" cu ON cu.id = c.created_by_user_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS unread_count
        FROM chat_message um
        WHERE um.conversation_id = c.id
          AND um.author_user_id <> p.user_id
          AND CAST(um.sent_at AS timestamp) > CAST(COALESCE(p.last_read_at, '1970-01-01 00:00:00') AS timestamp)
      ) uc ON true
      LEFT JOIN LATERAL (
        SELECT uo.id, uo.username, uo.name, mo.photo
        FROM chat_conversation_participant po
        INNER JOIN "user" uo ON uo.id = po.user_id
        LEFT JOIN member mo ON mo.id = uo.member_id
        WHERE po.conversation_id = c.id
          AND po.user_id <> p.user_id
        ORDER BY po.joined_at ASC, po.user_id ASC
        LIMIT 1
      ) ou ON true
      LEFT JOIN LATERAL (
        SELECT m.sent_at, m.text
        FROM chat_message m
        WHERE m.conversation_id = c.id
        ORDER BY CAST(m.sent_at AS timestamp) DESC, m.id DESC
        LIMIT 1
      ) lm ON true
      WHERE p.user_id = ?
      ORDER BY CAST(COALESCE(lm.sent_at, c.created_at) AS timestamp) DESC, c.id DESC
    `,
    )
    .all(userId))
    .map(mapChatConversation);
}

async function listChatMessagesForConversation(conversationId) {
  return (await getDb()
    .prepare(
      `
      SELECT
        m.id,
        m.conversation_id,
        m.author_user_id,
        m.text,
        m.sent_at,
        u.username AS author_username,
        u.name AS author_name,
        mp.photo AS author_photo
      FROM chat_message m
      INNER JOIN "user" u ON u.id = m.author_user_id
      LEFT JOIN member mp ON mp.id = u.member_id
      WHERE m.conversation_id = ?
      ORDER BY CAST(m.sent_at AS timestamp) ASC, m.id ASC
    `,
    )
    .all(conversationId))
    .map(mapChatMessage);
}

async function createChatMessage({ conversationId, authorUserId, text }) {
  return withTransaction(async () => {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    throw new Error("A mensagem não pode estar vazia.");
  }

  if (!(await isChatConversationParticipant(conversationId, authorUserId))) {
    throw new Error("Usuário sem permissão para enviar mensagem nesta conversa.");
  }

  const conversation = (await getChatConversationById(conversationId));
  if (conversation?.is_read_only && Number(conversation.created_by_user_id) !== Number(authorUserId)) {
    throw new Error("Esta conversa e somente para recebimento.");
  }

  return (await withTransaction(async (db) => {
    const inserted = (await db.prepare(
      `
      INSERT INTO chat_message (conversation_id, author_user_id, text)
      VALUES (?, ?, ?)
      RETURNING id
    `,
    ).run(conversationId, authorUserId, normalizedText));

    const now = toSqlDateTime(new Date());
    (await db.prepare(
      `
      UPDATE chat_conversation
      SET updated_at = ?
      WHERE id = ?
    `,
    ).run(now, conversationId));

    const row = (await db.prepare(
      `
      SELECT
        m.id,
        m.conversation_id,
        m.author_user_id,
        m.text,
        m.sent_at,
        u.username AS author_username,
        u.name AS author_name
      FROM chat_message m
      INNER JOIN "user" u ON u.id = m.author_user_id
      WHERE m.id = ?
    `,
    ).get(inserted.lastInsertRowid));
    return mapChatMessage(row);
  }));

  });
}

async function markChatConversationAsRead(conversationId, userId) {
  return withTransaction(async () => {
  if (!conversationId || !userId) {
    return;
  }
  if (!(await isChatConversationParticipant(conversationId, userId))) {
    return;
  }
  const now = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      UPDATE chat_conversation_participant
      SET last_read_at = ?
      WHERE conversation_id = ?
        AND user_id = ?
    `,
    )
    .run(now, conversationId, userId));

  });
}

async function countUnreadChatConversationsForUser(userId) {
  const row = (await getDb()
    .prepare(
      `
      SELECT COUNT(DISTINCT p.conversation_id) AS total
      FROM chat_conversation_participant p
      INNER JOIN chat_message m ON m.conversation_id = p.conversation_id
      WHERE p.user_id = ?
        AND m.author_user_id <> ?
        AND CAST(m.sent_at AS timestamp) > CAST(COALESCE(p.last_read_at, '1970-01-01 00:00:00') AS timestamp)
    `,
    )
    .get(userId, userId));
  return Number(row?.total || 0);
}

async function listUnreadChatConversationCountsForUser(userId) {
  return (await getDb()
    .prepare(
      `
      SELECT
        p.conversation_id,
        COUNT(*) AS unread_count
      FROM chat_conversation_participant p
      INNER JOIN chat_message m ON m.conversation_id = p.conversation_id
      WHERE p.user_id = ?
        AND m.author_user_id <> ?
        AND CAST(m.sent_at AS timestamp) > CAST(COALESCE(p.last_read_at, '1970-01-01 00:00:00') AS timestamp)
      GROUP BY p.conversation_id
    `,
    )
    .all(userId, userId))
    .map((row) => ({
      conversation_id: Number(row.conversation_id),
      unread_count: Number(row.unread_count || 0),
    }));
}

async function registerNotificationEmailDelivery({
  kind,
  recipientUserId,
  referenceKey,
  payloadJson = null,
}) {
  const normalizedKind = String(kind || "").trim();
  const normalizedReference = String(referenceKey || "").trim();
  if (!normalizedKind || !recipientUserId || !normalizedReference) {
    return false;
  }

  const row = (await getDb()
    .prepare(
      `
      INSERT INTO notification_email_delivery (
        kind,
        recipient_user_id,
        reference_key,
        payload_json
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT (kind, recipient_user_id, reference_key) DO NOTHING
      RETURNING id
    `,
    )
    .get(
      normalizedKind,
      recipientUserId,
      normalizedReference,
      payloadJson ? String(payloadJson) : null,
    ));

  return Boolean(row?.id);
}

async function listPlannerTasksDueOnDateForEmail(dateKey, { limit = 2000 } = {}) {
  const normalizedDateKey = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDateKey)) {
    return [];
  }
  const nextDateKey = addDaysToDateKey(normalizedDateKey, 1);
  if (!nextDateKey) {
    return [];
  }

  return (await getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.project_id,
        t.title,
        t.due_at,
        p.name AS project_name,
        ru.id AS recipient_user_id,
        COALESCE(NULLIF(TRIM(ru.name), ''), ru.username) AS recipient_name,
        ru.email AS recipient_email
      FROM planner_task t
      INNER JOIN project p ON p.id = t.project_id
      LEFT JOIN LATERAL (
        SELECT
          u.id,
          u.username,
          u.name,
          u.email,
          u.role
        FROM "user" u
        WHERE u.member_id = t.assigned_member_id
          AND u.email IS NOT NULL
          AND LENGTH(TRIM(u.email)) > 0
        ORDER BY
          CASE
            WHEN u.role = 'common' THEN 0
            WHEN u.role = 'admin' THEN 1
            ELSE 2
          END,
          u.id ASC
        LIMIT 1
      ) ru ON true
      WHERE t.is_completed = 0
        AND t.workflow_state = 'active'
        AND t.due_at >= ?
        AND t.due_at < ?
      ORDER BY t.due_at ASC, t.id ASC
      LIMIT ?
    `,
    )
    .all(`${normalizedDateKey} 00:00:00`, `${nextDateKey} 00:00:00`, limit))
    .map((row) => ({
      id: Number(row.id),
      project_id: Number(row.project_id),
      project_name: row.project_name || "",
      title: row.title || "",
      due_at: row.due_at || null,
      recipient_user_id: row.recipient_user_id ? Number(row.recipient_user_id) : null,
      recipient_name: row.recipient_name || null,
      recipient_email: row.recipient_email || null,
    }));
}

async function listUsersForFortnightReportDeadlineReminder() {
  return (await getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.name,
        u.email,
        u.role,
        m.name AS member_name
      FROM "user" u
      INNER JOIN member m ON m.id = u.member_id
      WHERE m.is_active = 1
        AND u.is_active = 1
        AND u.role = 'common'
        AND u.email IS NOT NULL
        AND LENGTH(TRIM(u.email)) > 0
      ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.name), ''), u.username)), u.id ASC
    `,
    )
    .all())
    .map((row) => ({
      id: Number(row.id),
      username: row.username,
      name: row.name || row.username,
      email: row.email || null,
      role: row.role || "common",
      member_name: row.member_name || null,
    }));
}

function mapEvent(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    name: row.name || "",
    event_date: row.event_date || null,
    location: row.location || "",
    description: row.description || "",
    is_active: Boolean(Number(row.is_active)),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    attendee_count: Number(row.attendee_count || 0),
    present_count: Number(row.present_count || 0),
  };
}

function mapEventAttendee(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    event_id: Number(row.event_id),
    name: row.name || "",
    cpf: row.cpf || "",
    email: row.email || "",
    badge_code: row.badge_code || "",
    registration_number: row.registration_number || "",
    course: row.course || "",
    institution: row.institution || "",
    notes: row.notes || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    checked_in_at: row.checked_in_at || null,
    checked_in_by_name: row.checked_in_by_name || "",
    is_present: Boolean(row.checked_in_at),
  };
}

function mapAttendee(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    name: row.name || "",
    cpf: row.cpf || "",
    email: row.email || "",
    badge_code: row.badge_code || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    event_count: Number(row.event_count || 0),
  };
}

async function listAttendees({ query = "" } = {}) {
  const search = String(query || "").trim().toLowerCase();
  const params = [];
  let where = "";
  if (search) {
    params.push(`%${search}%`);
    where = `
      WHERE LOWER(a.name) LIKE ?
        OR LOWER(COALESCE(a.cpf, '')) LIKE ?
        OR LOWER(COALESCE(a.email, '')) LIKE ?
        OR LOWER(a.badge_code) LIKE ?
    `;
    params.push(params[0], params[0], params[0]);
  }
  return (await getDb()
    .prepare(
      `
      SELECT a.*, COUNT(DISTINCT ea.event_id) AS event_count
      FROM attendee a
      LEFT JOIN event_attendee ea ON ea.attendee_id = a.id
      ${where}
      GROUP BY a.id
      ORDER BY LOWER(a.name), a.id
    `,
    )
    .all(...params))
    .map(mapAttendee);
}

async function getAttendeeById(id) {
  return mapAttendee((await getDb().prepare("SELECT * FROM attendee WHERE id = ?").get(id)));
}

async function getAttendeeByBadgeCode(badgeCode) {
  return mapAttendee(
    (await getDb()
      .prepare("SELECT * FROM attendee WHERE badge_code = ? LIMIT 1")
      .get(String(badgeCode || "").trim())),
  );
}

async function createAttendee(payload) {
  return withTransaction(async () => {
  const inserted = (await getDb()
    .prepare(
      `
      INSERT INTO attendee (name, cpf, email, badge_code)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(payload.name, payload.cpf || null, payload.email || null, payload.badgeCode));
  return (await getAttendeeById(inserted.lastInsertRowid));

  });
}

async function updateAttendee(payload) {
  return withTransaction(async () => {
  (await getDb()
    .prepare(
      `
      UPDATE attendee
      SET name = ?, cpf = ?, email = ?, badge_code = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      payload.name,
      payload.cpf || null,
      payload.email || null,
      payload.badgeCode,
      toSqlDateTime(new Date()),
      payload.id,
    ));
  (await getDb()
    .prepare(
      `
      UPDATE event_attendee
      SET name = ?, cpf = ?, email = ?, badge_code = ?, updated_at = ?
      WHERE attendee_id = ?
    `,
    )
    .run(
      payload.name,
      payload.cpf || null,
      payload.email || null,
      payload.badgeCode,
      toSqlDateTime(new Date()),
      payload.id,
    ));
  return (await getAttendeeById(payload.id));

  });
}

async function deleteAttendee(id) {
  return (await withTransaction(async (db) => {
    const linked = (await db.prepare("SELECT COUNT(*) AS total FROM event_attendee WHERE attendee_id = ?").get(id));
    if (Number(linked?.total || 0) > 0) {
      throw new Error("Ouvinte vinculado a evento; remova o vínculo no evento antes de excluir.");
    }
    return (await db.prepare("DELETE FROM attendee WHERE id = ?").run(id)).changes > 0;
  }));
}

async function attachAttendeeToEvent({ eventId, attendeeId }) {
  return withTransaction(async () => {
  const attendee = (await getAttendeeById(attendeeId));
  if (!attendee) {
    throw new Error("Ouvinte não encontrado.");
  }
  return (await withTransaction(async (db) => {
    const existing = (await db
      .prepare(
        `
        SELECT id
        FROM event_attendee
        WHERE event_id = ?
          AND (attendee_id = ? OR badge_code = ?)
        LIMIT 1
      `,
      )
      .get(eventId, attendee.id, attendee.badge_code));

    if (existing) {
      (await db.prepare(
        `
        UPDATE event_attendee
        SET attendee_id = ?, name = ?, cpf = ?, email = ?, badge_code = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(
        attendee.id,
        attendee.name,
        attendee.cpf || null,
        attendee.email || null,
        attendee.badge_code,
        toSqlDateTime(new Date()),
        existing.id,
      ));
      return (await getEventAttendeeById(existing.id));
    }

    const inserted = (await db
      .prepare(
        `
        INSERT INTO event_attendee (event_id, attendee_id, name, cpf, email, badge_code)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id
      `,
      )
      .run(eventId, attendee.id, attendee.name, attendee.cpf || null, attendee.email || null, attendee.badge_code));
    return (await getEventAttendeeById(inserted.lastInsertRowid));
  }));

  });
}

async function listEvents() {
  return (await getDb()
    .prepare(
      `
      SELECT
        e.*,
        COUNT(DISTINCT ea.id) AS attendee_count,
        COUNT(DISTINCT ar.attendee_id) AS present_count
      FROM event e
      LEFT JOIN event_attendee ea ON ea.event_id = e.id
      LEFT JOIN event_attendance ar ON ar.event_id = e.id
      GROUP BY e.id
      ORDER BY e.is_active DESC, COALESCE(e.event_date, e.created_at) DESC, e.id DESC
    `,
    )
    .all())
    .map(mapEvent);
}

async function getEventById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        e.*,
        COUNT(DISTINCT ea.id) AS attendee_count,
        COUNT(DISTINCT ar.attendee_id) AS present_count
      FROM event e
      LEFT JOIN event_attendee ea ON ea.event_id = e.id
      LEFT JOIN event_attendance ar ON ar.event_id = e.id
      WHERE e.id = ?
      GROUP BY e.id
    `,
    )
    .get(id));
  return mapEvent(row);
}

async function createEvent({ name, eventDate = null, location = "", description = "" }) {
  return withTransaction(async () => {
  const inserted = (await getDb()
    .prepare(
      `
      INSERT INTO event (name, event_date, location, description)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(name, eventDate, location || null, description || ""));
  return (await getEventById(inserted.lastInsertRowid));

  });
}

async function updateEvent({ id, name, eventDate = null, location = "", description = "", isActive = true }) {
  return withTransaction(async () => {
  (await getDb()
    .prepare(
      `
      UPDATE event
      SET name = ?, event_date = ?, location = ?, description = ?, is_active = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(name, eventDate, location || null, description || "", isActive ? 1 : 0, toSqlDateTime(new Date()), id));
  return (await getEventById(id));

  });
}

async function deleteEvent(id) {
  return (await withTransaction(async (db) => {
    (await db.prepare("DELETE FROM event_attendance WHERE event_id = ?").run(id));
    (await db.prepare("DELETE FROM event_attendee WHERE event_id = ?").run(id));
    return (await db.prepare("DELETE FROM event WHERE id = ?").run(id)).changes > 0;
  }));
}

async function listEventAttendees(eventId, { query = "" } = {}) {
  const search = String(query || "").trim().toLowerCase();
  const params = [eventId];
  let where = "WHERE ea.event_id = ?";
  if (search) {
    params.push(`%${search}%`);
    where += `
      AND (
        LOWER(ea.name) LIKE ?
        OR LOWER(COALESCE(ea.cpf, '')) LIKE ?
        OR LOWER(COALESCE(ea.email, '')) LIKE ?
        OR LOWER(ea.badge_code) LIKE ?
        OR LOWER(COALESCE(ea.registration_number, '')) LIKE ?
      )
    `;
    params.push(params[1], params[1], params[1], params[1]);
  }
  return (await getDb()
    .prepare(
      `
      SELECT
        ea.*,
        ar.checked_in_at,
        COALESCE(u.name, u.username) AS checked_in_by_name
      FROM event_attendee ea
      LEFT JOIN event_attendance ar
        ON ar.event_id = ea.event_id AND ar.attendee_id = ea.id
      LEFT JOIN "user" u ON u.id = ar.checked_in_by_user_id
      ${where}
      ORDER BY LOWER(ea.name), ea.id
    `,
    )
    .all(...params))
    .map(mapEventAttendee);
}

async function getEventAttendeeById(id) {
  const row = (await getDb()
    .prepare(
      `
      SELECT
        ea.*,
        ar.checked_in_at,
        COALESCE(u.name, u.username) AS checked_in_by_name
      FROM event_attendee ea
      LEFT JOIN event_attendance ar
        ON ar.event_id = ea.event_id AND ar.attendee_id = ea.id
      LEFT JOIN "user" u ON u.id = ar.checked_in_by_user_id
      WHERE ea.id = ?
    `,
    )
    .get(id));
  return mapEventAttendee(row);
}

async function createEventAttendee(payload) {
  return (await withTransaction(async () => {
    const existing = (await getAttendeeByBadgeCode(payload.badgeCode));
    const attendee = existing
      ? (await updateAttendee({ id: existing.id, ...payload }))
      : (await createAttendee(payload));
    return (await attachAttendeeToEvent({ eventId: payload.eventId, attendeeId: attendee.id }));
  }));
}

async function updateEventAttendee(payload) {
  return withTransaction(async () => {
  (await getDb()
    .prepare(
      `
      UPDATE event_attendee
      SET
        name = ?,
        cpf = ?,
        email = ?,
        badge_code = ?,
        registration_number = ?,
        course = ?,
        institution = ?,
        notes = ?,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      payload.name,
      payload.cpf || null,
      payload.email || null,
      payload.badgeCode,
      payload.registrationNumber || null,
      payload.course || null,
      payload.institution || null,
      payload.notes || "",
      toSqlDateTime(new Date()),
      payload.id,
    ));
  return (await getEventAttendeeById(payload.id));

  });
}

async function deleteEventAttendee(id) {
  return (await withTransaction(async (db) => {
    (await db.prepare("DELETE FROM event_attendance WHERE attendee_id = ?").run(id));
    return (await db.prepare("DELETE FROM event_attendee WHERE id = ?").run(id)).changes > 0;
  }));
}

async function registerEventAttendance({ eventId, badgeCode, checkedInByUserId, method = "scan" }) {
  return withTransaction(async () => {
  const normalizedBadge = String(badgeCode || "").trim();
  if (!eventId) {
    return { success: false, message: "Selecione um evento." };
  }
  if (!normalizedBadge) {
    return { success: false, message: "Informe o código do crachá." };
  }
  const event = (await getEventById(eventId));
  if (!event) {
    return { success: false, message: "Evento não encontrado." };
  }
  let attendee = (await getDb()
    .prepare(
      `
      SELECT ea.*
      FROM event_attendee ea
      WHERE ea.event_id = ?
        AND ea.badge_code = ?
      LIMIT 1
    `,
    )
    .get(eventId, normalizedBadge));
  if (!attendee) {
    const generalAttendee = (await getAttendeeByBadgeCode(normalizedBadge));
    if (!generalAttendee) {
      return { success: false, message: "Crachá não encontrado na lista de ouvintes." };
    }
    attendee = (await attachAttendeeToEvent({ eventId, attendeeId: generalAttendee.id }));
  }
  const current = (await getDb()
    .prepare(
      `
      SELECT checked_in_at
      FROM event_attendance
      WHERE event_id = ? AND attendee_id = ?
      LIMIT 1
    `,
    )
    .get(eventId, attendee.id));
  if (current?.checked_in_at) {
    return {
      success: false,
      message: `${attendee.name} já tinha presença registrada em ${current.checked_in_at}.`,
      attendee: mapEventAttendee({ ...attendee, checked_in_at: current.checked_in_at }),
    };
  }
  const checkedInAt = toSqlDateTime(new Date());
  (await getDb()
    .prepare(
      `
      INSERT INTO event_attendance (event_id, attendee_id, checked_in_at, checked_in_by_user_id, method)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(eventId, attendee.id, checkedInAt, checkedInByUserId || null, method));
  return {
    success: true,
    message: `${attendee.name} registrado(a) em ${event.name}.`,
    attendee: mapEventAttendee({ ...attendee, checked_in_at: checkedInAt }),
  };

  });
}

async function listPresenceMatrixEvents() {
  return (await getDb()
    .prepare(
      `
      SELECT *
      FROM event
      ORDER BY COALESCE(event_date, created_at), id
    `,
    )
    .all())
    .map(mapEvent);
}

async function listPresenceMatrixRows() {
  const rows = (await getDb()
    .prepare(
      `
      SELECT
        a.id,
        a.badge_code,
        a.name,
        a.cpf,
        a.email,
        ea.event_id,
        ar.checked_in_at
      FROM attendee a
      LEFT JOIN event_attendee ea ON ea.attendee_id = a.id
      LEFT JOIN event_attendance ar
        ON ar.event_id = ea.event_id AND ar.attendee_id = ea.id
      ORDER BY LOWER(a.name), a.id, ea.event_id
    `,
    )
    .all());
  const byId = new Map();
  rows.forEach((row) => {
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: Number(row.id),
        badge_code: row.badge_code || "",
        name: row.name || "",
        cpf: row.cpf || "",
        email: row.email || "",
        presenceByEventId: {},
      });
    }
    if (row.event_id) {
      byId.get(row.id).presenceByEventId[Number(row.event_id)] = Boolean(row.checked_in_at);
    }
  });
  return Array.from(byId.values());
}

// SECAO: interface publica deste modulo para o restante da aplicacao.
// OBSERVACAO: alteracoes de nomes exportados exigem ajuste imediato nos imports de rotas/servicos.

module.exports = {
  attachAttendeeToEvent,
  createAta,
  createAttendee,
  createEvent,
  createEventAttendee,
  createMember,
  createProject,
  createUser,
  createInventoryItem,
  createInventoryCategory,
  createInventoryLocation,
  borrowInventoryItem,
  deactivateMember,
  deleteAta,
  deleteAttendee,
  deleteEvent,
  deleteEventAttendee,
  deleteReportEntry,
  deleteInventoryItem,
  deleteInventoryCategory,
  deleteInventoryLocation,
  deleteProject,
  ensureSchema,
  getAtaById,
  getAttendeeById,
  getDb,
  getEventById,
  getEventAttendeeById,
  getInventoryDashboardData,
  listWritingGeneralEntries,
  getWritingGeneralEntryById,
  createWritingGeneralEntry,
  updateWritingGeneralEntry,
  deleteWritingGeneralEntry,
  listWritingTutorPrivateEntries,
  getWritingTutorPrivateEntryById,
  createWritingTutorPrivateEntry,
  updateWritingTutorPrivateEntry,
  deleteWritingTutorPrivateEntry,
  getReportFortnightTutorNote,
  upsertReportFortnightTutorNote,
  markReportFortnightTutorNoteAsSentToChat,
  getReportFortnightMemberNote,
  upsertReportFortnightMemberNote,
  markReportFortnightMemberNoteAsSentToChat,
  createChatConversation,
  createWarningBroadcastForMember,
  getChatConversationById,
  listChatConversationParticipants,
  isChatConversationParticipant,
  findDirectConversationByUsers,
  listChatConversationsForUser,
  listChatMessagesForConversation,
  listEvents,
  listPresenceMatrixEvents,
  listPresenceMatrixRows,
  listAttendees,
  listEventAttendees,
  createChatMessage,
  markChatConversationAsRead,
  countUnreadChatConversationsForUser,
  listUnreadChatConversationCountsForUser,
  registerEventAttendance,
  registerNotificationEmailDelivery,
  listPlannerTasksDueOnDateForEmail,
  listUsersForFortnightReportDeadlineReminder,
  getUserByMemberId,
  getMemberWarningState,
  applySemiannualMemberWarningCycle,
  listMemberWarningEvents,
  mutateMemberWarning,
  isUserMemberOfProjectName,
  getInventoryCategoryById,
  getInventoryItemById,
  getInventoryLoanById,
  getInventoryLocationById,
  isReportDueOverdue,
  getMemberById,
  getMemberByName,
  getProjectById,
  getProjectMembers,
  getReportEntryById,
  getReportWeekGoalById,
  getReportWeekGoalByPlannerTaskId,
  getUserById,
  getUserByUsername,
  listInventoryCategories,
  listInventoryItems,
  listInventoryLoans,
  listInventoryLocations,
  listInventoryRequests,
  listUsers,
  listActiveMembers,
  listProjectsBasic,
  listProjectsForMember,
  listProjectsWithMembers,
  listProjectsWithMembersByIds,
  listReportEntries,
  listReportMembersSummary,
  listReportProjectsForMember,
  listReportMonthGoalsForMember,
  listReportMonthMemberNotesForPdf,
  listPlannerTasks,
  getPlannerTaskById,
  refreshPlannerTaskLifecycle,
  listReportWeekGoalsForMember,
  listReportWeekGoalDeletionLogsForMember,
  listTaskAuditLogsForMember,
  listReportWeeksForMember,
  listRecentAtas,
  createReportEntry,
  createReportWeekGoal,
  syncReportWeekGoalFromPlannerTask,
  createPlannerTask,
  createTaskAuditLog,
  createPlannerTaskCompletionLog,
  updatePlannerTaskDetails,
  updatePlannerTaskCompletion,
  markPlannerTaskDoneLate,
  extendPlannerTaskDeadline,
  updatePlannerTaskStatus,
  deletePlannerTask,
  listPlannerTaskCompletionLogs,
  extendInventoryLoan,
  returnInventoryLoan,
  setUserMemberLink,
  updateUserPassword,
  updateUserEmail,
  deleteUser,
  updateInventoryCategory,
  updateInventoryItem,
  updateInventoryLocation,
  updateEvent,
  updateAttendee,
  updateEventAttendee,
  updateMember,
  updateProject,
  updateReportEntry,
  updateReportWeekGoal,
  setMemberWarningCount,
  startMemberWarningRestriction,
  attachPlannerTaskToReportWeekGoal,
  deleteReportWeekGoal,
  deleteReportWeekGoalWithAudit,
  isProjectMember,
  isProjectCoordinator,
  withdrawInventoryItem,
};

function createPreparedStatement(sql) {
  const converted = toPostgresSql(sql);
  return {
    async run(...params) {
      const result = await postgres.query(converted, params);
      return { changes: Number(result.rowCount || 0), lastInsertRowid: result.rows?.[0]?.id == null ? null : Number(result.rows[0].id) };
    },
    async get(...params) { return (await postgres.query(converted, params)).rows[0]; },
    async all(...params) { return (await postgres.query(converted, params)).rows; },
  };
}
function createDbAdapter() {
  return { prepare: createPreparedStatement, exec: async (sql) => (await postgres.query(toPostgresSql(sql))) };
}
async function withTransaction(callback) {
  return (await postgres.withTransaction(() => callback(getDb())));
}
