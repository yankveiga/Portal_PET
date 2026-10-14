const PDFDocument = require("pdfkit");

const MM_TO_PT = 72 / 25.4;
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const SHEET_MARGIN_MM = 5;
const BADGE_GAP_MM = 2.5;

const CODE39 = Object.freeze({
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "$": "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
});

function mmToPt(value) {
  return Number(value) * MM_TO_PT;
}

function parsePositiveNumber(value) {
  const normalized = String(value || "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value) {
  const normalized = String(value || "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeBadgeForm(body = {}) {
  const firstCodeText = String(body.first_code || "").trim();
  const lastCodeText = String(body.last_code || "").trim();
  const totalText = String(body.total_badges || "").trim();
  const badgesPerPageText = String(body.badges_per_page || "1").trim();

  return {
    firstCode: /^\d+$/.test(firstCodeText) ? Number(firstCodeText) : null,
    lastCode: /^\d+$/.test(lastCodeText) ? Number(lastCodeText) : null,
    totalBadges: /^\d+$/.test(totalText) ? Number(totalText) : null,
    badgesPerPage: /^\d+$/.test(badgesPerPageText) ? Number(badgesPerPageText) : null,
    badgeWidthMm: parsePositiveNumber(body.badge_width_mm ?? body.badge_width_cm),
    badgeHeightMm: parsePositiveNumber(body.badge_height_mm ?? body.badge_height_cm),
    barcodeWidthMm: parsePositiveNumber(body.barcode_width_mm ?? body.barcode_width_cm),
    barcodeHeightMm: parsePositiveNumber(body.barcode_height_mm ?? body.barcode_height_cm),
    barcodeXMm: parseNonNegativeNumber(body.barcode_x_mm ?? body.barcode_x_cm),
    barcodeYMm: parseNonNegativeNumber(body.barcode_y_mm ?? body.barcode_y_cm),
  };
}

function validateBadgeForm(formData, file) {
  const errors = {};
  if (!file) {
    errors.baseImage = ["Envie a imagem modelo do cracha."];
  }
  if (!formData.firstCode) {
    errors.firstCode = ["Informe o primeiro codigo numerico."];
  }
  if (!formData.lastCode && !formData.totalBadges) {
    errors.lastCode = ["Informe o ultimo codigo ou a quantidade."];
  }
  if (formData.lastCode && formData.firstCode && formData.lastCode < formData.firstCode) {
    errors.lastCode = ["O ultimo codigo deve ser maior ou igual ao primeiro."];
  }
  if (formData.totalBadges && formData.totalBadges > 1000) {
    errors.totalBadges = ["Gere no maximo 1000 crachas por vez."];
  }
  if (!formData.badgesPerPage) {
    errors.badgesPerPage = ["Informe quantos crachas devem ir em cada pagina."];
  } else if (formData.badgesPerPage > 20) {
    errors.badgesPerPage = ["Use no maximo 20 crachas por pagina."];
  }
  [
    ["badgeWidthMm", "Largura do cracha"],
    ["badgeHeightMm", "Altura do cracha"],
    ["barcodeWidthMm", "Largura do codigo"],
    ["barcodeHeightMm", "Altura do codigo"],
  ].forEach(([key, label]) => {
    if (!formData[key]) {
      errors[key] = [`${label} deve ser maior que zero.`];
    }
  });
  if (formData.barcodeXMm === null) {
    errors.barcodeXMm = ["X deve ser zero ou maior."];
  }
  if (formData.barcodeYMm === null) {
    errors.barcodeYMm = ["Y deve ser zero ou maior."];
  }
  if (
    formData.badgeWidthMm &&
    formData.badgeHeightMm &&
    formData.barcodeWidthMm &&
    formData.barcodeHeightMm &&
    formData.barcodeXMm !== null &&
    formData.barcodeYMm !== null
  ) {
    if (formData.barcodeXMm + formData.barcodeWidthMm > formData.badgeWidthMm) {
      errors.barcodeXMm = ["O codigo de barras passa da largura do cracha."];
    }
    if (formData.barcodeYMm + formData.barcodeHeightMm > formData.badgeHeightMm) {
      errors.barcodeYMm = ["O codigo de barras passa da altura do cracha."];
    }
    if (formData.badgesPerPage > 1) {
      const layout = calculateBadgeLayout(formData);
      if (!layout.fitsOne) {
        errors.badgeWidthMm = ["Este cracha nao cabe em uma pagina A4 com essas medidas."];
      } else if (formData.badgesPerPage > layout.capacity) {
        errors.badgesPerPage = [
          `Com ${formData.badgeWidthMm} x ${formData.badgeHeightMm} mm, cabem no maximo ${layout.capacity} cracha(s) por pagina A4 sem sobrepor.`,
        ];
      }
    }
  }
  return errors;
}

function calculateBadgeLayout(formData) {
  const badgesPerPage = Math.max(1, Number(formData.badgesPerPage || 1));
  const useSheetPage = badgesPerPage > 1;
  const pageWidthMm = useSheetPage ? A4_WIDTH_MM : formData.badgeWidthMm;
  const pageHeightMm = useSheetPage ? A4_HEIGHT_MM : formData.badgeHeightMm;
  const marginMm = useSheetPage ? SHEET_MARGIN_MM : 0;
  const gapMm = useSheetPage ? BADGE_GAP_MM : 0;
  const usableWidthMm = pageWidthMm - marginMm * 2;
  const usableHeightMm = pageHeightMm - marginMm * 2;
  const columns = Math.max(0, Math.floor((usableWidthMm + gapMm) / (formData.badgeWidthMm + gapMm)));
  const rows = Math.max(0, Math.floor((usableHeightMm + gapMm) / (formData.badgeHeightMm + gapMm)));
  const capacity = Math.max(0, columns * rows);
  const usablePerPage = useSheetPage ? Math.min(badgesPerPage, capacity) : 1;

  return {
    useSheetPage,
    pageWidthMm,
    pageHeightMm,
    pageWidth: mmToPt(pageWidthMm),
    pageHeight: mmToPt(pageHeightMm),
    badgeWidth: mmToPt(formData.badgeWidthMm),
    badgeHeight: mmToPt(formData.badgeHeightMm),
    margin: mmToPt(marginMm),
    gap: mmToPt(gapMm),
    columns,
    rows,
    capacity,
    usablePerPage,
    fitsOne: capacity >= 1,
  };
}

function buildCodeList({ firstCode, lastCode, totalBadges }) {
  const total = totalBadges || (lastCode - firstCode + 1);
  return Array.from({ length: total }, (_, index) => String(firstCode + index));
}

function countCode39Modules(text) {
  const encoded = `*${text.toUpperCase()}*`;
  return encoded.split("").reduce((total, char, index) => {
    const pattern = CODE39[char];
    if (!pattern) {
      throw new Error(`Codigo "${text}" contem caracteres invalidos para Code39.`);
    }
    const charModules = pattern.split("").reduce((sum, part) => sum + (part === "w" ? 3 : 1), 0);
    return total + charModules + (index === encoded.length - 1 ? 0 : 1);
  }, 0);
}

function drawCode39(doc, text, x, y, width, height) {
  const encoded = `*${text.toUpperCase()}*`;
  const fontSize = Math.min(12, Math.max(8, height * 0.22));
  const labelHeight = fontSize + 4;
  const barHeight = Math.max(8, height - labelHeight);
  const quietZone = Math.min(width * 0.02, 6);
  const narrow = (width - quietZone * 2) / countCode39Modules(text);
  const wide = narrow * 3;
  let cursorX = x + quietZone;

  doc.save();
  doc.rect(x, y, width, height).fill("#ffffff");
  doc.fillColor("#000000");

  encoded.split("").forEach((char, charIndex) => {
    const pattern = CODE39[char];
    pattern.split("").forEach((part, index) => {
      const segmentWidth = part === "w" ? wide : narrow;
      if (index % 2 === 0) {
        doc.rect(cursorX, y, segmentWidth, barHeight).fill("#000000");
      }
      cursorX += segmentWidth;
    });
    if (charIndex !== encoded.length - 1) {
      cursorX += narrow;
    }
  });

  doc
    .font("Helvetica")
    .fontSize(fontSize)
    .fillColor("#000000")
    .text(text, x, y + barHeight + 1, {
      width,
      align: "center",
      lineBreak: false,
    });
  doc.restore();
}

function generateBadgesPdf({ baseImageBuffer, formData }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const layout = calculateBadgeLayout(formData);
    const codes = buildCodeList(formData);
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: {
        Title: `Crachas ${codes[0]}-${codes[codes.length - 1]}`,
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    codes.forEach((code, index) => {
      const pageIndex = Math.floor(index / layout.usablePerPage);
      const indexOnPage = index % layout.usablePerPage;
      if (indexOnPage === 0) {
        doc.addPage({ size: [layout.pageWidth, layout.pageHeight], margin: 0 });
      }

      const column = indexOnPage % layout.columns;
      const row = Math.floor(indexOnPage / layout.columns);
      const x = layout.margin + column * (layout.badgeWidth + layout.gap);
      const y = layout.margin + row * (layout.badgeHeight + layout.gap);

      doc.image(baseImageBuffer, x, y, { width: layout.badgeWidth, height: layout.badgeHeight });
      drawCode39(
        doc,
        code,
        x + mmToPt(formData.barcodeXMm),
        y + mmToPt(formData.barcodeYMm),
        mmToPt(formData.barcodeWidthMm),
        mmToPt(formData.barcodeHeightMm),
      );
    });

    doc.end();
  });
}

module.exports = {
  generateBadgesPdf,
  normalizeBadgeForm,
  validateBadgeForm,
};
