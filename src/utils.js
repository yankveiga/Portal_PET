/*
 * ARQUIVO: src/utils.js
 * FUNCAO: utilitarios compartilhados (rotas nomeadas, formatacao, seguranca de arquivos/CSRF, parsers e helpers).
 * IMPACTO DE MUDANCAS:
 * - Alterar helpers comuns afeta varios modulos ao mesmo tempo; revisar chamadas cruzadas e testes de regressao.
 * - Alterar mapeamento de rotas nomeadas impacta links e redirecionamentos em templates e controllers.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Sao_Paulo";

// SECAO: mapeamento central das rotas nomeadas usadas por controllers/templates.

const ROUTES = Object.freeze({
  static: "/static/:filename",
  login: "/login",
  logout: "/logout",
  services: "/services",
  almox_home: "/almoxarifado",
  home: "/home",
  user_maintenance: "/manutencao-usuarios",
  writing_spaces: "/espacos-escrita",
  messages_home: "/mensagens",
  message_conversation: "/mensagens/conversas/:id",
  planner: "/planner",
  presenca: "/presenca",
  presenca_eventos: "/presenca/eventos",
  presenca_ouvintes: "/presenca/ouvintes",
  presenca_checkin: "/presenca/check-in",
  presenca_crachas: "/presenca/crachas",
  presenca_crachas_generate: "/presenca/crachas/gerar",
  registrar_presenca: "/presenca/registrar",
  presenca_event_create: "/presenca/eventos/criar",
  presenca_event_update: "/presenca/eventos/:id/editar",
  presenca_event_delete: "/presenca/eventos/:id/excluir",
  presenca_attendee_create: "/presenca/ouvintes/criar",
  presenca_attendee_update: "/presenca/ouvintes/:id/editar",
  presenca_attendee_delete: "/presenca/ouvintes/:id/excluir",
  presenca_import_preview: "/presenca/ouvintes/importar/preview",
  presenca_import_confirm: "/presenca/ouvintes/importar/confirmar",
  presenca_export_csv: "/presenca/eventos/:id/exportar.csv",
  presenca_export_geral_csv: "/presenca/exportar-geral.csv",
  relatorios: "/relatorios",
  create_report: "/relatorios/create",
  edit_report: "/relatorios/edit/:id",
  delete_report: "/relatorios/delete/:id",
  list_members: "/members",
  add_member: "/members/add",
  edit_member: "/members/edit/:id",
  delete_member: "/members/delete/:id",
  list_projects: "/projects",
  add_project: "/projects/add",
  edit_project: "/projects/edit/:id",
  delete_project: "/projects/delete/:id",
  create_ata: "/atas/create",
  create_ata_for: "/atas/create/for/:project_id",
  download_ata_pdf: "/atas/download/:id",
  delete_ata: "/atas/delete/:id",
  api_get_project_members: "/api/project/:project_id/members",
});

// SECAO: tabelas de localizacao em portugues para datas e texto por extenso.

const MONTHS_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

const DAYS_EXTENSO = {
  1: "primeiro",
  2: "dois",
  3: "três",
  4: "quatro",
  5: "cinco",
  6: "seis",
  7: "sete",
  8: "oito",
  9: "nove",
  10: "dez",
  11: "onze",
  12: "doze",
  13: "treze",
  14: "quatorze",
  15: "quinze",
  16: "dezesseis",
  17: "dezessete",
  18: "dezoito",
  19: "dezenove",
  20: "vinte",
  21: "vinte e um",
  22: "vinte e dois",
  23: "vinte e três",
  24: "vinte e quatro",
  25: "vinte e cinco",
  26: "vinte e seis",
  27: "vinte e sete",
  28: "vinte e oito",
  29: "vinte e nove",
  30: "trinta",
  31: "trinta e um",
};

// SECAO: helpers de rotas, flash e CSRF (estado de sessao e seguranca de formulario).

function urlFor(name, params = {}) {
  if (name === "create_ata" && params.project_id) {
    return `/atas/create/for/${params.project_id}`;
  }

  const template = ROUTES[name];
  if (!template) {
    throw new Error(`Rota desconhecida: ${name}`);
  }

  if (name === "static") {
    const filename = String(params.filename || "").replace(/^\/+/, "");
    return `/static/${filename}`;
  }

  return template.replace(/:([a-zA-Z_]+)/g, (_, key) => {
    const value = params[key];
    if (value === undefined || value === null) {
      throw new Error(`Parâmetro ausente para rota "${name}": ${key}`);
    }
    return encodeURIComponent(String(value));
  });
}

function addFlash(req, category, message) {
  if (!req.session) {
    return;
  }
  if (!Array.isArray(req.session.flashes)) {
    req.session.flashes = [];
  }
  req.session.flashes.push({ category, message });
}

function consumeFlashes(req) {
  if (!req.session || !Array.isArray(req.session.flashes)) {
    return [];
  }
  const flashes = [...req.session.flashes];
  req.session.flashes = [];
  return flashes;
}

function ensureCsrfToken(req) {
  if (!req.session) {
    return "";
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  }
  return req.session.csrfToken;
}

function verifyCsrf(req) {
  const token =
    req.body?.csrf_token ||
    req.body?._csrf ||
    req.headers["x-csrf-token"];

  return Boolean(token && req.session && token === req.session.csrfToken);
}

// SECAO: utilitarios de arquivos e seguranca de I/O.

function sanitizeFilename(filename) {
  const base = path.basename(filename || "");
  const ascii = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = ascii
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned || `arquivo_${Date.now()}`;
}

function safeUnlink(filePath) {
  if (!filePath) {
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(`Falha ao remover arquivo ${filePath}:`, error);
  }
}

// SECAO: parsers e normalizacao de entrada (ids, listas e tipos basicos).

function trimToNull(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function parseId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseIdArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(parseId).filter(Boolean))];
  }
  const parsed = parseId(value);
  return parsed ? [parsed] : [];
}

// SECAO: formatacao de data/hora para SQL, UI e campos datetime-local.

function extractDateParts(value) {
  if (!value) {
    return null;
  }

  const toTzParts = (date) => {
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

    return {
      year: Number(valueByType.year),
      month: Number(valueByType.month),
      day: Number(valueByType.day),
      hour: Number(valueByType.hour || 0),
      minute: Number(valueByType.minute || 0),
      second: Number(valueByType.second || 0),
    };
  };

  if (typeof value === "string") {
    const normalized = value.trim().replace("T", " ");
    const plainMatch = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    );

    if (plainMatch) {
      return {
        year: Number(plainMatch[1]),
        month: Number(plainMatch[2]),
        day: Number(plainMatch[3]),
        hour: Number(plainMatch[4] || 0),
        minute: Number(plainMatch[5] || 0),
        second: Number(plainMatch[6] || 0),
      };
    }

    const isoCandidate = normalized
      .replace(" ", "T")
      .replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(isoCandidate);
    if (!Number.isNaN(parsed.getTime())) {
      return toTzParts(parsed);
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toTzParts(value);
  }

  return null;
}

function zeroPad(value) {
  return String(value).padStart(2, "0");
}

function toSqlDateTime(value) {
  const parts = extractDateParts(value);
  if (!parts) {
    return null;
  }

  return `${parts.year}-${zeroPad(parts.month)}-${zeroPad(parts.day)} ${zeroPad(parts.hour)}:${zeroPad(parts.minute)}:${zeroPad(parts.second)}`;
}

function toDateTimeLocalValue(value) {
  const parts = extractDateParts(value);
  if (!parts) {
    return "";
  }

  return `${parts.year}-${zeroPad(parts.month)}-${zeroPad(parts.day)}T${zeroPad(parts.hour)}:${zeroPad(parts.minute)}`;
}

function formatDateTimePt(value) {
  const parts = extractDateParts(value);
  if (!parts) {
    return "";
  }

  return `${zeroPad(parts.day)}/${zeroPad(parts.month)}/${parts.year} ${zeroPad(parts.hour)}:${zeroPad(parts.minute)}`;
}

function formatDatePt(value) {
  const parts = extractDateParts(value);
  if (!parts) {
    return "";
  }

  return `${zeroPad(parts.day)}/${zeroPad(parts.month)}/${parts.year}`;
}

function defaultMeetingDateTimeInput() {
  return toDateTimeLocalValue(new Date());
}

function firstNamesSummary(members) {
  if (!Array.isArray(members) || members.length === 0) {
    return "";
  }

  return members
    .map((member) => String(member.name || "").trim().split(/\s+/)[0])
    .filter(Boolean)
    .join(", ");
}

function isAllowedImage(filename) {
  return /\.(jpg|jpeg|png|gif|webp|jfif)$/i.test(filename || "");
}

function isUniqueConstraintError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  return (
    message.includes("UNIQUE constraint failed") ||
    message.toLowerCase().includes("duplicate key value violates unique constraint") ||
    code === "23505"
  );
}

function safeRedirectPath(nextPath, fallback) {
  if (
    typeof nextPath !== "string" ||
    !nextPath.startsWith("/") ||
    nextPath.startsWith("//")
  ) {
    return fallback;
  }
  return nextPath;
}

// SECAO: escrita de numeros por extenso para documentos formais (atas/PDF).

function numberToPortuguese(value) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    return String(value);
  }

  const units = [
    "zero",
    "um",
    "dois",
    "três",
    "quatro",
    "cinco",
    "seis",
    "sete",
    "oito",
    "nove",
    "dez",
    "onze",
    "doze",
    "treze",
    "quatorze",
    "quinze",
    "dezesseis",
    "dezessete",
    "dezoito",
    "dezenove",
  ];

  const tens = [
    "",
    "",
    "vinte",
    "trinta",
    "quarenta",
    "cinquenta",
    "sessenta",
    "setenta",
    "oitenta",
    "noventa",
  ];

  const hundreds = [
    "",
    "cento",
    "duzentos",
    "trezentos",
    "quatrocentos",
    "quinhentos",
    "seiscentos",
    "setecentos",
    "oitocentos",
    "novecentos",
  ];

  if (number < 20) {
    return units[number];
  }

  if (number < 100) {
    const ten = Math.floor(number / 10);
    const remainder = number % 10;
    return remainder ? `${tens[ten]} e ${numberToPortuguese(remainder)}` : tens[ten];
  }

  if (number === 100) {
    return "cem";
  }

  if (number < 1000) {
    const hundred = Math.floor(number / 100);
    const remainder = number % 100;
    return remainder
      ? `${hundreds[hundred]} e ${numberToPortuguese(remainder)}`
      : hundreds[hundred];
  }

  if (number < 1000000) {
    const thousand = Math.floor(number / 1000);
    const remainder = number % 1000;
    const prefix = thousand === 1 ? "mil" : `${numberToPortuguese(thousand)} mil`;
    if (!remainder) {
      return prefix;
    }
    const connector = remainder < 100 ? " e " : " ";
    return `${prefix}${connector}${numberToPortuguese(remainder)}`;
  }

  return String(number);
}

function formatDateExtenso(value) {
  const parts = extractDateParts(value);
  if (!parts) {
    return "";
  }

  const day = DAYS_EXTENSO[parts.day] || numberToPortuguese(parts.day);
  const month = MONTHS_PT[parts.month - 1] || "";
  const year = numberToPortuguese(parts.year);

  return `${day} dias do mês de ${month} de ${year}`;
}

// SECAO: exportacao de utilitarios compartilhados.

module.exports = {
  APP_TIMEZONE,
  ROUTES,
  MONTHS_PT,
  addFlash,
  consumeFlashes,
  defaultMeetingDateTimeInput,
  ensureCsrfToken,
  extractDateParts,
  firstNamesSummary,
  formatDateExtenso,
  formatDatePt,
  formatDateTimePt,
  isAllowedImage,
  isUniqueConstraintError,
  parseId,
  parseIdArray,
  safeRedirectPath,
  safeUnlink,
  sanitizeFilename,
  toDateTimeLocalValue,
  toSqlDateTime,
  trimToNull,
  urlFor,
  verifyCsrf,
};
