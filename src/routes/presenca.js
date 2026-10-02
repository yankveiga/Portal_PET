const asyncArray = require("../asyncArray");
﻿const fs = require("node:fs");
const multer = require("multer");
const ExcelJS = require("exceljs");
const {
  generateBadgesPdf,
  normalizeBadgeForm,
  validateBadgeForm,
} = require("../badges");

// Padroniza cabecalhos de CSV para comparar nomes com ou sem acento/espaco.
function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Le um CSV simples respeitando aspas, virgulas internas e quebras de linha.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(cell);
      if (row.some((value) => String(value || "").trim())) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => String(value || "").trim())) {
    rows.push(row);
  }
  return rows;
}

// Busca o primeiro valor disponivel entre nomes de coluna aceitos.
function getCsvValue(row, headers, acceptedNames) {
  for (const name of acceptedNames) {
    const index = headers.indexOf(name);
    if (index >= 0) {
      return String(row[index] || "").trim();
    }
  }
  return "";
}

// Escapa valores na exportacao CSV para nao quebrar linhas ou colunas.
function escapeCsvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Gera nome seguro para download, sem acentos ou caracteres problemáticos.
function sanitizeDownloadName(value) {
  return String(value || "presenca")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "presenca";
}

// Monta a planilha XLSX geral com uma coluna por evento.
async function buildPresenceWorkbook({ events, rows }) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(["CRACHA", "NOME", "CPF", "E-MAIL", ...events.map((_, index) => `EVENTO_${index + 1}`)]);
  rows.forEach((row) => {
    worksheet.addRow([
      row.badge_code,
      row.name,
      row.cpf,
      row.email,
      ...events.map((event) => (row.presenceByEventId[event.id] ? "X" : "")),
    ]);
  });
  worksheet.getRow(1).font = { bold: true };
  worksheet.columns.forEach((column, index) => {
    column.width = index === 1 ? 34 : (index === 3 ? 30 : 14);
  });
  return workbook;
}

// Normaliza dados do formulario de atividade antes de validar/salvar.
function normalizeEventForm(body = {}) {
  return {
    name: String(body.name || "").trim(),
    eventDate: String(body.event_date || "").trim() || null,
    isActive: String(body.is_active || "") === "1",
  };
}

// Normaliza dados do ouvinte antes de validar/salvar.
function normalizeAttendeeForm(body = {}) {
  return {
    name: String(body.name || "").trim(),
    cpf: String(body.cpf || "").trim(),
    email: String(body.email || "").trim(),
    badgeCode: String(body.badge_code || "").trim(),
  };
}

// Valida os campos minimos de uma atividade.
function validateEventForm(formData) {
  const errors = {};
  if (!formData.name) {
    errors.name = ["Nome do evento é obrigatório."];
  }
  return errors;
}

// Valida os campos minimos de um ouvinte.
function validateAttendeeForm(formData) {
  const errors = {};
  if (!formData.name) {
    errors.name = ["Nome é obrigatório."];
  }
  if (!formData.badgeCode) {
    errors.badgeCode = ["Crachá é obrigatório."];
  }
  return errors;
}

// Reconstroi a query string mantendo o evento selecionado e filtros extras.
function buildEventQuery(eventId, extra = {}) {
  const params = new URLSearchParams();
  if (eventId) {
    params.set("event_id", String(eventId));
  }
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.set(key, String(value));
    }
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

// Resolve qual evento deve aparecer selecionado ao abrir telas de presenca.
async function resolveSelectedEvent(database, requestedEventId) {
  const events = (await database.listEvents());
  const selectedEvent = requestedEventId
    ? (await database.getEventById(requestedEventId))
    : (events.find((event) => event.is_active) || events[0] || null);
  return { events, selectedEvent };
}

// Converte linhas do CSV em ouvintes, marcando erros e duplicados.
function mapCsvRows({ rows, existingAttendees }) {
  const headers = (rows.shift() || []).map(normalizeHeader);
  const existingByBadge = new Map(
    existingAttendees.map((attendee) => [String(attendee.badge_code || "").trim(), attendee]),
  );
  const seenInFile = new Set();
  return rows.map((row, index) => {
    const attendee = {
      name: getCsvValue(row, headers, ["nome", "name"]),
      cpf: getCsvValue(row, headers, ["cpf"]),
      email: getCsvValue(row, headers, ["email", "e_mail"]),
      badgeCode: getCsvValue(row, headers, ["cracha", "badge", "badge_code", "codigo"]),
    };
    const errors = [];
    if (!attendee.name) {
      errors.push("nome ausente");
    }
    if (!attendee.badgeCode) {
      errors.push("crachá ausente");
    }
    const duplicateInFile = attendee.badgeCode && seenInFile.has(attendee.badgeCode);
    if (duplicateInFile) {
      errors.push("crachá repetido no CSV");
    }
    if (attendee.badgeCode) {
      seenInFile.add(attendee.badgeCode);
    }
    const existing = attendee.badgeCode ? existingByBadge.get(attendee.badgeCode) : null;
    return {
      line: index + 2,
      attendee,
      existingId: existing?.id || null,
      status: errors.length ? "error" : (existing ? "duplicate" : "new"),
      errors,
    };
  });
}

// Registra todas as rotas do modulo Presenca no app principal.
function registerPresenceRoutes(ctx) {
  const {
    app,
    config,
    database,
    requireAuth,
    requireAdminPage,
    ensureValidCsrf,
    ensureCsrfToken,
    verifyCsrf,
    render,
    parseId,
    urlFor,
    logError,
    sendApiError,
  } = ctx;

  // Upload temporario de CSV para importacao de ouvintes.
  const csvUpload = multer({
    dest: config.uploadDir,
    limits: {
      fileSize: 2 * 1024 * 1024,
      files: 1,
      fields: 20,
    },
    fileFilter: (req, file, callback) => {
      const filename = String(file.originalname || "").toLowerCase();
      const mime = String(file.mimetype || "").toLowerCase();
      if (filename.endsWith(".csv") || mime.includes("csv") || mime === "text/plain") {
        callback(null, true);
        return;
      }
      req.uploadError = "Envie um arquivo CSV válido.";
      callback(null, false);
    },
  });

  // Upload em memoria da imagem usada para gerar crachas em PDF.
  const badgeImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 12 * 1024 * 1024,
      files: 1,
      fields: 20,
    },
    fileFilter: (req, file, callback) => {
      const filename = String(file.originalname || "").toLowerCase();
      const mime = String(file.mimetype || "").toLowerCase();
      if (
        /\.(png|jpg|jpeg)$/i.test(filename) &&
        ["image/png", "image/jpeg"].includes(mime)
      ) {
        callback(null, true);
        return;
      }
      req.uploadError = "Envie uma imagem PNG ou JPG valida.";
      callback(null, false);
    },
  });

  // Renderiza a tela de atividades cadastradas.
  async function renderEvents(req, res, data = {}) {
    return render(res, "presenca/eventos.html", {
      title: "Eventos",
      activeSection: "presenca",
      activePresenceTab: "eventos",
      events: (await database.listEvents()),
      eventFormData: data.eventFormData || {
        name: "",
        event_date: "",
        is_active: true,
      },
      eventErrors: data.eventErrors || {},
    });
  }

  // Renderiza a tela de ouvintes, mantendo evento selecionado e busca.
  async function renderAttendees(req, res, data = {}) {
    const selectedEventId = parseId(data.eventId || req.query.event_id);
    const { events, selectedEvent } = (await resolveSelectedEvent(database, selectedEventId));
    const query = String(data.searchQuery ?? req.query.q ?? "");
    const attendees = (await database.listAttendees({ query }));
    return render(res, "presenca/ouvintes.html", {
      title: "Ouvintes",
      activeSection: "presenca",
      activePresenceTab: "ouvintes",
      events,
      selectedEvent,
      attendees,
      searchQuery: query,
      attendeeFormData: data.attendeeFormData || {
        name: "",
        cpf: "",
        email: "",
        badge_code: "",
      },
      attendeeErrors: data.attendeeErrors || {},
      importPreview: data.importPreview || null,
      importSummary: data.importSummary || null,
    });
  }

  // Renderiza a tela de check-in por cracha/codigo.
  async function renderCheckin(req, res) {
    const selectedEventId = parseId(req.query.event_id);
    const { events, selectedEvent } = (await resolveSelectedEvent(database, selectedEventId));
    return render(res, "presenca/checkin.html", {
      title: "Check-in",
      activeSection: "presenca",
      activePresenceTab: "checkin",
      events,
      selectedEvent,
    });
  }

  // Renderiza o gerador de crachas usado pela administracao.
  function renderBadgeGenerator(req, res, data = {}) {
    return render(res, "presenca/crachas.html", {
      title: "Gerador de Crachas",
      activeSection: "presenca",
      activePresenceTab: "crachas",
      badgeFormData: data.badgeFormData || {
        first_code: "100001",
        last_code: "100150",
        total_badges: "",
        badge_width_cm: "11",
        badge_height_cm: "13",
        barcode_width_cm: "5.32",
        barcode_height_cm: "1.94",
        barcode_x_cm: "2.84",
        barcode_y_cm: "8.73",
      },
      badgeErrors: data.badgeErrors || {},
    });
  }

  // Rotas de leitura das telas do modulo.
  app.get("/presenca", requireAuth, (req, res) => res.redirect(urlFor("presenca_checkin")));
  app.get("/presenca/eventos", requireAuth, renderEvents);
  app.get("/presenca/ouvintes", requireAuth, renderAttendees);
  app.get("/presenca/check-in", requireAuth, renderCheckin);
  app.get("/presenca/crachas", requireAuth, requireAdminPage, renderBadgeGenerator);

  // Gera o PDF de crachas a partir da imagem enviada e dos parametros do formulario.
  app.post(
    "/presenca/crachas/gerar",
    requireAuth,
    requireAdminPage,
    badgeImageUpload.single("base_image"),
    async (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const formData = normalizeBadgeForm(req.body);
      const errors = validateBadgeForm(formData, req.file);
      if (req.uploadError) {
        errors.baseImage = [req.uploadError];
      }
      if (Object.keys(errors).length) {
        return renderBadgeGenerator(req, res, {
          badgeFormData: req.body,
          badgeErrors: errors,
        });
      }

      try {
        const pdfBuffer = await generateBadgesPdf({
          baseImageBuffer: req.file.buffer,
          formData,
        });
        const lastCode = formData.lastCode || (formData.firstCode + formData.totalBadges - 1);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="crachas_${formData.firstCode}_${lastCode}.pdf"`,
        );
        return res.send(pdfBuffer);
      } catch (error) {
        logError(req, "Erro ao gerar PDF de crachas:", error);
        req.flash("danger", error.message || "Erro ao gerar PDF de crachas.");
        return renderBadgeGenerator(req, res, { badgeFormData: req.body });
      }
    },
  );

  // Cria uma nova atividade de presenca.
  app.post("/presenca/eventos/criar", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const formData = normalizeEventForm(req.body);
    const errors = validateEventForm(formData);
    if (Object.keys(errors).length) {
      return (await renderEvents(req, res, { eventFormData: req.body, eventErrors: errors }));
    }
    const event = (await database.createEvent(formData));
    req.flash("success", "Evento criado com sucesso.");
    return res.redirect(`${urlFor("presenca_eventos")}#event-${event.id}`);
  });

  // Edita nome, data e status ativo/inativo de uma atividade.
  app.post("/presenca/eventos/:id/editar", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const eventId = parseId(req.params.id);
    if (!(await database.getEventById(eventId))) {
      req.flash("danger", "Evento não encontrado.");
      return res.redirect(urlFor("presenca_eventos"));
    }
    const formData = normalizeEventForm(req.body);
    const errors = validateEventForm(formData);
    if (Object.keys(errors).length) {
      req.flash("danger", "Nome do evento é obrigatório.");
      return res.redirect(urlFor("presenca_eventos"));
    }
    (await database.updateEvent({ id: eventId, ...formData }));
    req.flash("success", "Evento atualizado.");
    return res.redirect(`${urlFor("presenca_eventos")}#event-${eventId}`);
  });

  // Remove uma atividade e seus vinculos de presenca.
  app.post("/presenca/eventos/:id/excluir", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    (await database.deleteEvent(parseId(req.params.id)));
    req.flash("success", "Evento excluído.");
    return res.redirect(urlFor("presenca_eventos"));
  });

  // Cria um ouvinte e, se houver evento selecionado, ja vincula os dois.
  app.post("/presenca/ouvintes/criar", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const eventId = parseId(req.body.event_id);
    const formData = normalizeAttendeeForm(req.body);
    const errors = validateAttendeeForm(formData);
    if (Object.keys(errors).length) {
      return (await renderAttendees(req, res, {
        eventId,
        attendeeFormData: req.body,
        attendeeErrors: errors,
      }));
    }
    try {
      const attendee = (await database.createAttendee(formData));
      if (eventId) {
        (await database.attachAttendeeToEvent({ eventId, attendeeId: attendee.id }));
      }
      req.flash("success", eventId ? "Ouvinte cadastrado e vinculado ao evento." : "Ouvinte cadastrado.");
    } catch (error) {
      req.flash("danger", `Erro ao adicionar ouvinte: ${error.message}`);
    }
    return res.redirect(`${urlFor("presenca_ouvintes")}${buildEventQuery(eventId)}`);
  });

  // Edita os dados cadastrais de um ouvinte.
  app.post("/presenca/ouvintes/:id/editar", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const attendee = (await database.getAttendeeById(parseId(req.params.id)));
    if (!attendee) {
      req.flash("danger", "Ouvinte não encontrado.");
      return res.redirect(urlFor("presenca_ouvintes"));
    }
    const formData = normalizeAttendeeForm(req.body);
    const errors = validateAttendeeForm(formData);
    if (Object.keys(errors).length) {
      req.flash("danger", "Nome e crachá são obrigatórios.");
      return res.redirect(urlFor("presenca_ouvintes"));
    }
    try {
      (await database.updateAttendee({ id: attendee.id, ...formData }));
      req.flash("success", "Ouvinte atualizado.");
    } catch (error) {
      req.flash("danger", `Erro ao atualizar ouvinte: ${error.message}`);
    }
    return res.redirect(`${urlFor("presenca_ouvintes")}#attendee-${attendee.id}`);
  });

  // Exclui um ouvinte cadastrado.
  app.post("/presenca/ouvintes/:id/excluir", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const attendee = (await database.getAttendeeById(parseId(req.params.id)));
    if (!attendee) {
      req.flash("danger", "Ouvinte não encontrado.");
      return res.redirect(urlFor("presenca_ouvintes"));
    }
    try {
      (await database.deleteAttendee(attendee.id));
      req.flash("success", "Ouvinte excluído.");
    } catch (error) {
      req.flash("danger", error.message);
    }
    return res.redirect(urlFor("presenca_ouvintes"));
  });

  // Vincula um ouvinte existente a uma atividade.
  app.post("/presenca/ouvintes/:id/vincular", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const attendeeId = parseId(req.params.id);
    const eventId = parseId(req.body.event_id);
    if (!(await database.getEventById(eventId))) {
      req.flash("danger", "Selecione um evento válido.");
      return res.redirect(urlFor("presenca_ouvintes"));
    }
    try {
      (await database.attachAttendeeToEvent({ eventId, attendeeId }));
      req.flash("success", "Ouvinte vinculado ao evento.");
    } catch (error) {
      req.flash("danger", error.message);
    }
    return res.redirect(`${urlFor("presenca_ouvintes")}${buildEventQuery(eventId)}#attendee-${attendeeId}`);
  });

  // Mostra uma previa da importacao CSV antes de gravar no banco.
  app.post(
    "/presenca/ouvintes/importar/preview",
    requireAuth,
    requireAdminPage,
    csvUpload.single("csv_file"),
    async (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }
      const eventId = parseId(req.body.event_id);
      const event = eventId ? (await database.getEventById(eventId)) : null;
      if (req.uploadError) {
        req.flash("danger", req.uploadError);
        return res.redirect(`${urlFor("presenca_ouvintes")}${buildEventQuery(event?.id)}`);
      }
      let csvText = String(req.body.csv_text || "").trim();
      if (req.file) {
        csvText = fs.readFileSync(req.file.path, "utf8");
        fs.unlinkSync(req.file.path);
      }
      if (!csvText) {
        req.flash("danger", "Envie um CSV ou cole os dados antes de importar.");
        return res.redirect(`${urlFor("presenca_ouvintes")}${buildEventQuery(event?.id)}`);
      }
      const rows = parseCsv(csvText);
      if (rows.length < 2) {
        req.flash("danger", "O CSV precisa ter cabeçalho e pelo menos uma linha de dados.");
        return res.redirect(`${urlFor("presenca_ouvintes")}${buildEventQuery(event?.id)}`);
      }
      const previewRows = mapCsvRows({
        rows,
        existingAttendees: (await database.listAttendees()),
      });
      const summary = previewRows.reduce(
        (acc, row) => {
          acc.total += 1;
          acc[row.status] += 1;
          return acc;
        },
        { total: 0, new: 0, duplicate: 0, error: 0 },
      );
      return (await renderAttendees(req, res, {
        eventId: event?.id || null,
        importPreview: {
          rows: previewRows,
          payloadJson: JSON.stringify(previewRows.filter((row) => row.status !== "error")),
          summary,
        },
      }));
    },
  );

  // Confirma a importacao CSV, criando novos ouvintes ou atualizando duplicados.
  app.post("/presenca/ouvintes/importar/confirmar", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const eventId = parseId(req.body.event_id);
    const event = eventId ? (await database.getEventById(eventId)) : null;
    let rows = [];
    try {
      rows = JSON.parse(String(req.body.import_payload_json || "[]"));
    } catch (_error) {
      rows = [];
    }
    const duplicateMode = String(req.body.duplicate_mode || "") === "update" ? "update" : "ignore";
    const summary = { total: rows.length, imported: 0, updated: 0, skipped: 0, errors: 0 };
    (await asyncArray.forEach(rows, async (row) => {
      const attendee = row.attendee || {};
      if (!attendee.name || !attendee.badgeCode) {
        summary.errors += 1;
        return;
      }
      try {
        if (row.existingId) {
          if (duplicateMode === "update") {
            (await database.updateAttendee({ id: row.existingId, ...attendee }));
            if (event) {
              (await database.attachAttendeeToEvent({ eventId: event.id, attendeeId: row.existingId }));
            }
            summary.updated += 1;
          } else {
            if (event) {
              (await database.attachAttendeeToEvent({ eventId: event.id, attendeeId: row.existingId }));
            }
            summary.skipped += 1;
          }
          return;
        }
        const created = (await database.createAttendee(attendee));
        if (event) {
          (await database.attachAttendeeToEvent({ eventId: event.id, attendeeId: created.id }));
        }
        summary.imported += 1;
      } catch (_error) {
        summary.errors += 1;
      }
    }));
    return (await renderAttendees(req, res, {
      eventId: event?.id || null,
      importSummary: summary,
    }));
  });

  // Endpoint usado pelo check-in para registrar presenca via cracha.
  app.post("/presenca/registrar", requireAuth, async (req, res) => {
    if (!verifyCsrf(req)) {
      const nextToken = ensureCsrfToken(req);
      return sendApiError(req, res, 403, "CSRF token inválido ou expirado.", { csrfToken: nextToken });
    }
    try {
      const result = (await database.registerEventAttendance({
        eventId: parseId(req.body.event_id || req.body.evento),
        badgeCode: req.body.badge_code || req.body.cracha,
        checkedInByUserId: req.currentUser?.id || null,
        method: "scan",
      }));
      return res.status(result.success ? 200 : 422).json(result);
    } catch (error) {
      logError(req, "Erro ao registrar presença:", error);
      return sendApiError(req, res, 500, "Erro interno ao registrar presença.");
    }
  });

  // Exporta a lista de presenca de uma atividade especifica em CSV.
  app.get("/presenca/eventos/:id/exportar.csv", requireAuth, async (req, res) => {
    const event = (await database.getEventById(parseId(req.params.id)));
    if (!event) {
      req.flash("danger", "Evento não encontrado.");
      return res.redirect(urlFor("presenca_ouvintes"));
    }
    const attendees = (await database.listEventAttendees(event.id));
    const header = ["CRACHA", "NOME", "CPF", "EMAIL", "PRESENTE", "REGISTRADO_EM"];
    const lines = [header.join(",")];
    attendees.forEach((attendee) => {
      lines.push([
        attendee.badge_code,
        attendee.name,
        attendee.cpf,
        attendee.email,
        attendee.is_present ? "sim" : "nao",
        attendee.checked_in_at || "",
      ].map(escapeCsvValue).join(","));
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="presenca_evento_${event.id}.csv"`);
    return res.send(`\uFEFF${lines.join("\r\n")}`);
  });

  // Exporta a matriz geral de presenca em XLSX, com uma coluna por atividade.
  app.get("/presenca/exportar-geral.xlsx", requireAuth, async (req, res) => {
    try {
      const events = (await database.listPresenceMatrixEvents());
      const rows = (await database.listPresenceMatrixRows());
      const workbook = await buildPresenceWorkbook({ events, rows });
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeDownloadName("planilha_presenca_geral")}.xlsx"`);
      return res.send(Buffer.from(buffer));
    } catch (error) {
      logError(req, "Erro ao exportar planilha geral de presença:", error);
      req.flash("danger", "Erro ao exportar planilha geral.");
      return res.redirect(urlFor("presenca_eventos"));
    }
  });
}

module.exports = { registerPresenceRoutes };


