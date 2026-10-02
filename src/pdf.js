/*
 * ARQUIVO: src/pdf.js
 * FUNCAO: gera o PDF de atas (cabecalho, texto e layout final com PDFKit).
 * IMPACTO DE MUDANCAS:
 * - Ajustes de layout podem cortar conteudo, quebrar paginacao ou desalinhamento visual no documento final.
 * - Mudancas em campos exibidos devem manter consistencia com dados persistidos em banco.
 */
const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const { config } = require("./config");
const { extractDateParts, formatDateExtenso } = require("./utils");

// SECAO: composicao visual do cabecalho institucional do PDF de ata.

function drawHeader(doc, ata) {
  const logoPath = path.join(config.uploadDir, "FURG.png");
  const topY = 35;

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, doc.page.width / 2 - 25, topY, {
      fit: [50, 50],
      align: "center",
    });
  }

  doc
    .font("Helvetica")
    .fontSize(10)
    .text("UNIVERSIDADE FEDERAL DO RIO GRANDE – FURG", 72, 95, {
      align: "center",
    })
    .text("CENTRO DE CIÊNCIAS COMPUTACIONAIS", {
      align: "center",
    })
    .text("PET – Ciências Computacionais – C3", {
      align: "center",
    })
    .moveDown(0.25)
    .font("Helvetica-Bold")
    .text(`ATA ${formatDateForTitle(ata.meeting_datetime)}`, {
      align: "center",
    });

  doc.moveDown(2);
}

// SECAO: utilitarios de texto para titulo e descricoes de presenca/ausencia.

function formatDateForTitle(value) {
  const parts = extractDateParts(value);
  if (!parts) {
    return "";
  }
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;
}

function buildPresentText(members) {
  const names = members.map((member) => member.name).sort((a, b) => a.localeCompare(b));

  if (names.length === 0) {
    return "sem a presença de integrantes registrados";
  }

  if (names.length === 1) {
    return `com o seguinte presente: ${names[0]}`;
  }

  return `com os seguintes presentes: ${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

function buildAbsentText(ata) {
  const withJustification = [];
  const withoutJustification = [];

  ata.absent_members.forEach((member) => {
    const justification = ata.absent_justifications_dict[member.id];
    if (justification && justification.trim()) {
      withJustification.push(`${member.name} (Motivo: ${justification.trim()})`);
    } else {
      withoutJustification.push(member.name);
    }
  });

  let text = "";

  if (withJustification.length > 0) {
    text += `Estiveram ausentes com justificativa: ${withJustification.join(", ")}. `;
  }

  if (withoutJustification.length === 1) {
    text += `Estiveram ausentes sem justificativa: ${withoutJustification[0]}.`;
  } else if (withoutJustification.length > 1) {
    text += `Estiveram ausentes sem justificativa: ${withoutJustification
      .slice(0, -1)
      .join(", ")} e ${withoutJustification[withoutJustification.length - 1]}.`;
  }

  return text.trim() || "Nenhum membro ausente.";
}

// SECAO: montagem completa do documento PDF (layout, conteudo e stream de saida).

function generateAtaPdf(ata) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: 140,
        bottom: 56,
        left: 85,
        right: 56,
      },
      info: {
        Title: `Ata Reunião PET Ciências Computacionais - ${ata.project.name}`,
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawHeader(doc, ata);

    const intro = `Aos ${formatDateExtenso(ata.meeting_datetime)}, reuniram-se os integrantes do PET Ciências Computacionais ${buildPresentText(ata.present_members)}. ${buildAbsentText(ata)}`;

    doc
      .font("Times-Roman")
      .fontSize(12)
      .text(intro, {
        align: "justify",
        indent: 35,
        lineGap: 6,
      })
      .moveDown();

    if (ata.notes && ata.notes.trim()) {
      ata.notes
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          doc.text(line, {
            align: "justify",
            indent: 35,
            lineGap: 6,
          });
        });
    } else {
      doc.text("Nenhuma anotação registrada.", {
        align: "justify",
        indent: 35,
        lineGap: 6,
      });
    }

    doc.moveDown();
    doc.text(
      `Posteriormente, foi lavrada a presente ata, que será lida e aprovada em próxima reunião. Rio Grande, aos ${formatDateExtenso(ata.meeting_datetime)}.`,
      {
        align: "justify",
        indent: 35,
        lineGap: 6,
      },
    );

    doc.end();
  });
}

function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-");
  const monthNumber = Number(month);
  const yearNumber = Number(year);
  const monthsPt = [
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

  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return monthKey || "";
  }

  if (!Number.isInteger(yearNumber)) {
    return monthKey || "";
  }

  return `${monthsPt[monthNumber - 1]} de ${yearNumber}`;
}

function groupGoalsByProject(goals) {
  const byProject = new Map();
  goals.forEach((goal) => {
    const key = goal.project?.id || -1;
    if (!byProject.has(key)) {
      byProject.set(key, {
        projectName: goal.project?.name || "Projeto não informado",
        goals: [],
      });
    }
    byProject.get(key).goals.push(goal);
  });
  return Array.from(byProject.values()).sort((a, b) =>
    a.projectName.localeCompare(b.projectName, "pt-BR"),
  );
}

function generateMonthlyReportPdfLegacy({
  member,
  monthKey,
  goals,
  memberFortnightNotes = [],
  generatedByName = null,
}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `Relatório Mensal - ${member.name} - ${monthKey}`,
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(18).text("Relatório Mensal de Atividades", {
      align: "left",
    });
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(11);
    doc.text(`Membro: ${member.name}`);
    doc.text(`Mês de referência: ${formatMonthLabel(monthKey)}`);
    doc.text(`Total de metas no mês: ${goals.length}`);
    doc.text(`Complementos da quinzena no mês: ${memberFortnightNotes.length}`);
    if (generatedByName) {
      doc.text(`Gerado por: ${generatedByName}`);
    }
    doc.text(`Gerado em: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`);
    doc.moveDown();

    if (!goals.length && !memberFortnightNotes.length) {
      doc.font("Helvetica-Oblique").text("Nenhuma informação encontrada para o período selecionado.");
      doc.end();
      return;
    }

    if (goals.length) {
      const grouped = groupGoalsByProject(goals);
      grouped.forEach((projectGroup) => {
        if (doc.y > 720) {
          doc.addPage();
        }

        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .text(projectGroup.projectName, { underline: true });
        doc.moveDown(0.35);

        projectGroup.goals.forEach((goal, index) => {
          const statusLabel = goal.is_completed
            ? (goal.completed_late ? "Concluída com atraso" : "Concluída")
            : "Em aberto";
          const weekLabel = goal.week_start || "-";
          const activityLabel = goal.completed_late
            ? `ATRASADA - ${goal.activity || "Sem atividade"}`
            : (goal.activity || "Sem atividade");
          doc
            .font("Helvetica-Bold")
            .fontSize(11)
            .text(`${index + 1}. ${activityLabel}`);
          doc
            .font("Helvetica")
            .fontSize(10.5)
            .text(`Status: ${statusLabel} | Semana: ${weekLabel}`);
          if (goal.description && goal.description.trim()) {
            doc.text(`Descrição: ${goal.description.trim()}`);
          } else {
            doc.text("Descrição: (sem descrição)");
          }
          if (goal.completed_at) {
            doc.text(`Concluída em: ${goal.completed_at}`);
          }
          doc.moveDown(0.5);
        });
        doc.moveDown(0.4);
      });
    }

    if (memberFortnightNotes.length) {
      if (doc.y > 640) {
        doc.addPage();
      }
      doc
        .font("Helvetica-Bold")
        .fontSize(13)
        .text("Complementos da Quinzena", { underline: true });
      doc.moveDown(0.35);

      memberFortnightNotes.forEach((note, index) => {
        if (doc.y > 730) {
          doc.addPage();
        }
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .text(`${index + 1}. Semana ${note.week_start || "-"}`);
        doc
          .font("Helvetica")
          .fontSize(10.5)
          .text(`Autor: ${note.author_name || note.author_username || "Membro"}`);
        doc.text(`Texto: ${String(note.content || "").trim() || "(sem conteúdo)"}`);
        doc.moveDown(0.5);
      });
    }

    doc.end();
  });
}

const MONTH_ABBR_PT = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

const MONTHLY_REPORT_COLORS = {
  navy: "#173A5E",
  blue: "#245A86",
  blueSoft: "#EAF2F8",
  card: "#F7FAFC",
  cardBorder: "#DDE8F0",
  text: "#243447",
  muted: "#6B7C8F",
  greenBg: "#DDF4E6",
  greenText: "#176534",
  amberBg: "#FFF1D6",
  amberText: "#8A4B00",
  grayBg: "#E9EEF3",
  grayText: "#425466",
};

function parseMonthlyDateParts(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] == null ? null : Number(match[4]);
  const minute = match[5] == null ? null : Number(match[5]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { year, month, day, hour, minute };
}

function formatShortDateTimePt(value) {
  const parts = parseMonthlyDateParts(value);
  if (!parts) {
    return String(value || "-");
  }

  const dateLabel = `${String(parts.day).padStart(2, "0")} ${MONTH_ABBR_PT[parts.month - 1]} ${parts.year}`;
  if (parts.hour == null || parts.minute == null) {
    return dateLabel;
  }
  return `${dateLabel} · ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function formatMonthDatePt(year, month, day) {
  return `${String(day).padStart(2, "0")} ${MONTH_ABBR_PT[month - 1]} ${year}`;
}

function getMonthParts(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      lastDay: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
    };
  }

  return {
    year,
    month,
    lastDay: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

function getGoalFortnight(goal) {
  const parts = parseMonthlyDateParts(goal.week_start);
  if (!parts) {
    return "second";
  }
  return parts.day <= 15 ? "first" : "second";
}

function getMonthlyStatusMeta(goal) {
  if (goal.is_completed) {
    return {
      label: goal.completed_late ? "Concluída com atraso" : "Concluída",
      bg: goal.completed_late ? MONTHLY_REPORT_COLORS.amberBg : MONTHLY_REPORT_COLORS.greenBg,
      text: goal.completed_late ? MONTHLY_REPORT_COLORS.amberText : MONTHLY_REPORT_COLORS.greenText,
    };
  }

  if (goal.task_state === "missed") {
    return {
      label: "Não entregue",
      bg: MONTHLY_REPORT_COLORS.amberBg,
      text: MONTHLY_REPORT_COLORS.amberText,
    };
  }

  return {
    label: "Em aberto",
    bg: MONTHLY_REPORT_COLORS.grayBg,
    text: MONTHLY_REPORT_COLORS.grayText,
  };
}

function splitMonthlyGoalsByFortnight(goals) {
  const result = { first: [], second: [] };
  goals.forEach((goal) => {
    result[getGoalFortnight(goal)].push(goal);
  });

  Object.values(result).forEach((items) => {
    items.sort((a, b) => (
      String(a.week_start || "").localeCompare(String(b.week_start || ""))
      || String(a.project?.name || "").localeCompare(String(b.project?.name || ""), "pt-BR")
      || String(a.activity || "").localeCompare(String(b.activity || ""), "pt-BR")
      || Number(a.id || 0) - Number(b.id || 0)
    ));
  });
  return result;
}

function groupMonthlyGoalsByWeekStart(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = item.week_start || "Sem semana";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  });
  return Array.from(groups.entries()).map(([weekStart, goals]) => ({ weekStart, goals }));
}

function monthlyReportContentBottom(doc) {
  return doc.page.height - doc.page.margins.bottom - 24;
}

function drawMonthlyPageHeader(doc, { member, monthKey }) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;

  doc.save();
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(MONTHLY_REPORT_COLORS.blue)
    .text("PET CIÊNCIAS COMPUTACIONAIS", left, 58, { width });
  doc
    .fillColor(MONTHLY_REPORT_COLORS.navy)
    .font("Helvetica-Bold")
    .fontSize(26)
    .text("Relatório mensal de atividades", left, 82, { width });
  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor(MONTHLY_REPORT_COLORS.muted)
    .text(`${member.name || "Integrante não informado"}   ·   ${formatMonthLabel(monthKey)}`, left, 118, { width });
  doc.restore();
  doc.y = 156;
}

function addMonthlyReportPage(doc, context) {
  drawMonthlyFooter(doc, context.pageNumber, context.footerGeneratedLabel);
  context.pageNumber += 1;
  doc.addPage();
  drawMonthlyPageHeader(doc, context);
}

function ensureMonthlySpace(doc, neededHeight, context) {
  if (doc.y + neededHeight > monthlyReportContentBottom(doc)) {
    addMonthlyReportPage(doc, context);
  }
}

function drawMonthlySummaryBox(doc, x, y, width, label, value) {
  doc.save();
  doc.rect(x, y, width, 56).fillAndStroke("#F4F8FB", "#DCE8F0");
  doc
    .font("Helvetica-Bold")
    .fontSize(17)
    .fillColor(MONTHLY_REPORT_COLORS.navy)
    .text(String(value), x + 12, y + 9, { width: width - 24, align: "center" });
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(MONTHLY_REPORT_COLORS.muted)
    .text(label, x + 12, y + 34, { width: width - 24, align: "center" });
  doc.restore();
}

function drawMonthlySummary(doc, { goals, memberFortnightNotes }) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 0;
  const boxWidth = width / 3;
  const completedGoals = goals.filter((goal) => goal.is_completed).length;
  const summaryY = doc.y;

  drawMonthlySummaryBox(doc, left, doc.y, boxWidth, "Total de metas", goals.length);
  doc.y = summaryY;
  drawMonthlySummaryBox(doc, left + boxWidth + gap, doc.y, boxWidth, "Concluídas", completedGoals);
  doc.y = summaryY;
  drawMonthlySummaryBox(doc, left + (boxWidth + gap) * 2, doc.y, boxWidth, "Complementos", memberFortnightNotes.length);
  doc.y = summaryY + 76;
}

function drawMonthlyFortnightBand(doc, title, rangeLabel) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;

  doc.save();
  doc.rect(left, y, width, 34).fill(MONTHLY_REPORT_COLORS.navy);
  doc
    .font("Helvetica-Bold")
    .fontSize(12.5)
    .fillColor("#FFFFFF")
    .text(title, left + 14, y + 9, { width: width * 0.45 });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#DDEBF7")
    .text(rangeLabel, left + width * 0.5, y + 10, { width: width * 0.46, align: "right" });
  doc.restore();
  doc.y = y + 46;
}

function drawMonthlyWeekGroupTitle(doc, weekStart) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .fillColor(MONTHLY_REPORT_COLORS.blue)
    .text(`Semana: ${formatShortDateTimePt(weekStart)}`, left, doc.y, { width });
  doc.y += 16;
}

function measureMonthlyGoalCardHeight(doc, goal, width) {
  const description = String(goal.description || "").trim() || "Sem descrição registrada.";
  const innerWidth = width - 28;
  const descriptionHeight = doc
    .font("Helvetica")
    .fontSize(9.5)
    .heightOfString(description, { width: innerWidth, lineGap: 2 });
  const titleHeight = doc
    .font("Helvetica-Bold")
    .fontSize(11.5)
    .heightOfString(goal.activity || "Sem atividade", { width: innerWidth - 110 });
  return Math.max(122, 92 + titleHeight + descriptionHeight);
}

function drawMonthlyStatusPill(doc, x, y, status) {
  const textWidth = doc.font("Helvetica-Bold").fontSize(8.5).widthOfString(status.label);
  const pillWidth = Math.min(118, Math.max(74, textWidth + 18));

  doc.save();
  doc.roundedRect(x - pillWidth, y, pillWidth, 20, 10).fill(status.bg);
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor(status.text)
    .text(status.label, x - pillWidth + 9, y + 5, { width: pillWidth - 18, align: "center" });
  doc.restore();
}

function drawMonthlyGoalCard(doc, goal) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const height = measureMonthlyGoalCardHeight(doc, goal, width);
  const y = doc.y;
  const status = getMonthlyStatusMeta(goal);
  const description = String(goal.description || "").trim() || "Sem descrição registrada.";

  doc.save();
  doc.roundedRect(left, y, width, height, 10).fillAndStroke(MONTHLY_REPORT_COLORS.card, MONTHLY_REPORT_COLORS.cardBorder);
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(MONTHLY_REPORT_COLORS.blue)
    .text(goal.project?.name || "Projeto não informado", left + 14, y + 14, { width: width - 28 });
  drawMonthlyStatusPill(doc, left + width - 14, y + 12, status);
  doc
    .font("Helvetica-Bold")
    .fontSize(11.5)
    .fillColor(MONTHLY_REPORT_COLORS.text)
    .text(goal.activity || "Sem atividade", left + 14, y + 34, { width: width - 138, lineGap: 1 });

  const detailY = Math.max(doc.y + 8, y + 62);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MONTHLY_REPORT_COLORS.muted)
    .text(`Semana: ${formatShortDateTimePt(goal.week_start)}`, left + 14, detailY, { width: (width - 28) / 2 });
  doc.text(
    `Conclusão: ${goal.completed_at ? formatShortDateTimePt(goal.completed_at) : "Não concluída"}`,
    left + 14 + (width - 28) / 2,
    detailY,
    { width: (width - 28) / 2, align: "right" },
  );
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(MONTHLY_REPORT_COLORS.text)
    .text(description, left + 14, detailY + 20, { width: width - 28, lineGap: 2 });
  doc.restore();
  doc.y = y + height + 12;
}

function drawMonthlyEmptyMessage(doc) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.roundedRect(left, doc.y, width, 42, 8).fillAndStroke("#F8FAFC", "#E3EBF2");
  doc
    .font("Helvetica-Oblique")
    .fontSize(10)
    .fillColor(MONTHLY_REPORT_COLORS.muted)
    .text("Nenhuma atividade registrada neste período", left + 14, doc.y + 14, { width: width - 28 });
  doc.restore();
  doc.y += 56;
}

function drawMonthlyFortnightSection(doc, context, { title, rangeLabel, goals }) {
  ensureMonthlySpace(doc, 92, context);
  drawMonthlyFortnightBand(doc, title, rangeLabel);

  if (!goals.length) {
    drawMonthlyEmptyMessage(doc);
    return;
  }

  groupMonthlyGoalsByWeekStart(goals).forEach((group) => {
    ensureMonthlySpace(doc, 44, context);
    drawMonthlyWeekGroupTitle(doc, group.weekStart);
    group.goals.forEach((goal) => {
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      ensureMonthlySpace(doc, measureMonthlyGoalCardHeight(doc, goal, width), context);
      drawMonthlyGoalCard(doc, goal);
    });
  });
}

function measureMonthlyNoteCardHeight(doc, note, width) {
  const content = String(note.content || "").trim() || "Sem conteúdo registrado.";
  return 72 + doc.font("Helvetica").fontSize(9.5).heightOfString(content, { width: width - 28, lineGap: 2 });
}

function drawMonthlyNoteCard(doc, note) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const height = measureMonthlyNoteCardHeight(doc, note, width);
  const y = doc.y;

  doc.save();
  doc.roundedRect(left, y, width, height, 10).fillAndStroke("#FBFCFE", MONTHLY_REPORT_COLORS.cardBorder);
  doc
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .fillColor(MONTHLY_REPORT_COLORS.blue)
    .text(`Complemento da semana ${formatShortDateTimePt(note.week_start)}`, left + 14, y + 14, { width: width - 28 });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MONTHLY_REPORT_COLORS.muted)
    .text(`Autor: ${note.author_name || note.author_username || "Membro"}`, left + 14, y + 34, { width: width - 28 });
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(MONTHLY_REPORT_COLORS.text)
    .text(String(note.content || "").trim() || "Sem conteúdo registrado.", left + 14, y + 54, {
      width: width - 28,
      lineGap: 2,
    });
  doc.restore();
  doc.y = y + height + 12;
}

function drawMonthlyNotesSection(doc, context, memberFortnightNotes) {
  if (!memberFortnightNotes.length) {
    return;
  }

  ensureMonthlySpace(doc, 72, context);
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(MONTHLY_REPORT_COLORS.navy)
    .text("Complementos da quinzena", left, doc.y, { width });
  doc.y += 20;

  memberFortnightNotes
    .slice()
    .sort((a, b) => String(a.week_start || "").localeCompare(String(b.week_start || "")))
    .forEach((note) => {
      ensureMonthlySpace(doc, measureMonthlyNoteCardHeight(doc, note, width), context);
      drawMonthlyNoteCard(doc, note);
    });
}

function drawMonthlyFooter(doc, pageNumber, footerGeneratedLabel) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.page.height - doc.page.margins.bottom - 12;

  doc.save();
  doc
    .moveTo(left, y - 10)
    .lineTo(left + width, y - 10)
    .strokeColor("#E0E8EF")
    .lineWidth(1)
    .stroke();
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MONTHLY_REPORT_COLORS.muted)
    .text(footerGeneratedLabel, left, y, { width: width * 0.72, lineBreak: false });
  doc.text(`Página ${pageNumber}`, left, y, { width, align: "right", lineBreak: false });
  doc.restore();
}

function generateMonthlyReportPdf({
  member,
  monthKey,
  goals,
  memberFortnightNotes = [],
  generatedByName = null,
}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `Relatório Mensal - ${member.name} - ${monthKey}`,
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const generatedAtLabel = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const footerGeneratedLabel = generatedByName
      ? `Gerado por ${generatedByName} · ${generatedAtLabel}`
      : `Gerado em ${generatedAtLabel}`;
    const context = { member, monthKey, generatedAtLabel, footerGeneratedLabel, pageNumber: 1 };
    const monthParts = getMonthParts(monthKey);
    const goalsByFortnight = splitMonthlyGoalsByFortnight(goals);

    drawMonthlyPageHeader(doc, context);
    drawMonthlySummary(doc, { goals, memberFortnightNotes, generatedByName });
    drawMonthlyFortnightSection(doc, context, {
      title: "1ª quinzena",
      rangeLabel: `${formatMonthDatePt(monthParts.year, monthParts.month, 1)} a ${formatMonthDatePt(monthParts.year, monthParts.month, 15)}`,
      goals: goalsByFortnight.first,
    });
    drawMonthlyFortnightSection(doc, context, {
      title: "2ª quinzena",
      rangeLabel: `${formatMonthDatePt(monthParts.year, monthParts.month, 16)} a ${formatMonthDatePt(monthParts.year, monthParts.month, monthParts.lastDay)}`,
      goals: goalsByFortnight.second,
    });
    drawMonthlyNotesSection(doc, context, memberFortnightNotes);
    drawMonthlyFooter(doc, context.pageNumber, footerGeneratedLabel);
    doc.end();
  });
}

// SECAO: exportacao publica do gerador de PDF para uso nas rotas.

module.exports = {
  generateAtaPdf,
  generateMonthlyReportPdf,
};
