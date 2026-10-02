const asyncArray = require("./asyncArray");
﻿/*
 * ARQUIVO: src/app.js
 * FUNCAO: composicao principal da aplicacao (middlewares, autenticacao, validacoes e rotas HTTP).
 * IMPACTO DE MUDANCAS:
 * - Mudancas em middlewares globais alteram comportamento de todas as rotas (sessao, CSRF, flashes e parsing de formulario).
 * - Mudancas em regras de permissao ou validacao podem abrir acesso indevido ou bloquear fluxos legitimos.
 * - Mudancas nas rotas afetam formularios, links e consumo de dados nos templates.
 */
const fs = require("node:fs");
const path = require("node:path");

const bcrypt = require("bcryptjs");
const cookieSession = require("cookie-session");
const express = require("express");
const multer = require("multer");
const nunjucks = require("nunjucks");

const { config } = require("./config");
const database = require("./database");
const { generateAtaPdf, generateMonthlyReportPdf } = require("./pdf");
const { registerAuthRoutes } = require("./routes/auth");
const { registerReportRoutes } = require("./routes/reports");
const { registerMemberRoutes } = require("./routes/members");
const { registerProjectRoutes } = require("./routes/projects");
const { registerAtaRoutes } = require("./routes/atas");
const { registerPresenceRoutes } = require("./routes/presenca");
const { registerAlmoxRoutes } = require("./routes/almox");
const { registerWritingRoutes } = require("./routes/writing");
const { registerChatRoutes } = require("./routes/chat");
const { requestContextMiddleware, logError, sendApiError } = require("./http");
const {
  validateInventoryPayload: validateInventoryPayloadShared,
  validateCatalogName: validateCatalogNameShared,
} = require("./validators/inventoryValidators");
const { validateWeekGoalForm } = require("./validators/reportValidators");
const {
  canGenerateMonthlyReport,
  buildMonthlyPdfFilename,
} = require("./services/reportService");
const { createNotificationService } = require("./services/notificationService");
const { mapInventoryApiItem } = require("./services/inventoryService");
const {
  isCloudinaryEnabled,
  isRemoteAssetUrl,
  uploadImageFromPath,
  deleteImageByUrl,
} = require("./media");
const {
  addFlash,
  consumeFlashes,
  defaultMeetingDateTimeInput,
  ensureCsrfToken,
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
} = require("./utils");

// SECAO: constantes de dominio usadas por validacoes e comportamento de modulos.

const ALMOX_TABS = new Set([
  "overview",
  "stock",
  "manage",
  "withdraw",
  "borrow",
  "borrowed",
  "requests",
]);
const INVENTORY_ITEM_TYPES = new Set(["stock", "patrimony"]);
const DEFAULT_PROJECT_COLOR = "#0b6bcb";
const REPORTS_TIMEZONE = "America/Sao_Paulo";
const ENABLE_REQUEST_LOGS = String(process.env.REQUEST_LOGS || "").trim() === "1";
const ENABLE_PERFORMANCE_LOGS = String(process.env.PERFORMANCE_LOGS || "").trim() === "1";
const SLOW_REQUEST_MS = Math.max(
  100,
  Number.parseInt(process.env.SLOW_REQUEST_MS || "750", 10) || 750,
);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const valueByType = {};
  parts.forEach((part) => {
    valueByType[part.type] = part.value;
  });
  return {
    year: Number(valueByType.year),
    month: Number(valueByType.month),
    day: Number(valueByType.day),
    weekday: valueByType.weekday,
  };
}

function formatYmd(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonths(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
}

// SECAO: helpers de normalizacao de entrada (query/form).
// Mantem valores padrao quando entrada vier ausente ou invalida.

// DETALHE: Normaliza a aba solicitada para evitar estados invalidos na interface do almoxarifado.

function normalizeAlmoxTab(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ALMOX_TABS.has(normalized) ? normalized : "overview";
}

// DETALHE: Garante que o tipo de item fique restrito aos tipos reconhecidos pelo sistema.

function normalizeInventoryItemType(value) {
  return INVENTORY_ITEM_TYPES.has(value) ? value : "stock";
}

// DETALHE: Valida e padroniza cor hexadecimal; evita salvar valor invalido no banco.

function normalizeProjectColor(value, fallback = DEFAULT_PROJECT_COLOR) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : fallback;
}

// DETALHE: Mantem a quinzena atual ate o fechamento oficial: dia 15 ou ultimo dia do mes.

function getCurrentWeekStartDate() {
  const now = new Date();
  const parts = getDatePartsInTimeZone(now, REPORTS_TIMEZONE);
  const fortnightStartDay = parts.day <= 15 ? 1 : 16;
  return formatYmd(parts.year, parts.month, fortnightStartDay);
}

// DETALHE: Converte data recebida para o inicio da quinzena correspondente.

function normalizeWeekStartDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = getDatePartsInTimeZone(date, REPORTS_TIMEZONE);
  const fortnightStartDay = parts.day <= 15 ? 1 : 16;
  return formatYmd(parts.year, parts.month, fortnightStartDay);
}

// DETALHE: Normaliza status do relatorio e aplica fallback seguro quando vier invalido.

function normalizeReportStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["completed", "in_progress", "blocked"].includes(normalized)
    ? normalized
    : "in_progress";
}

// DETALHE: Monta querystring de filtros preservando contexto de navegacao na tela de relatorios.

function buildReportsQuery({ memberId = null, projectId = null, editId = null } = {}) {
  const params = new URLSearchParams();
  if (memberId) {
    params.set("member_id", String(memberId));
  }
  if (projectId) {
    params.set("project_id", String(projectId));
  }
  if (editId) {
    params.set("edit_id", String(editId));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function getCurrentMonthKeyInSaoPaulo() {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const [year, month] = formatted.split("-");
  return `${year}-${month}`;
}

function normalizeMonthKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : null;
}

// SECAO: fabrica principal da aplicacao Express (middlewares, rotas e tratamento de erro).

// DETALHE: Ponto central de composicao: configura Express, middlewares, regras de acesso e rotas.

async function createApp() {
  (await database.ensureSchema());
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const notificationService = createNotificationService({ database, config });
  const unreadConversationCache = new Map();
  const unreadConversationCacheTtlMs = 5000;
  let inventoryDashboardCache = null;
  const inventoryDashboardCacheTtlMs = 15000;
  let plannerLifecycleLastCheckedAt = 0;
  const plannerLifecycleCheckIntervalMs = 60000;
  let warningCycleLastCheckedAt = 0;
  const warningCycleCheckIntervalMs = 300000;

  function getCachedRequestValue(req, namespace, key, loader) {
    if (!req.localCache) {
      req.localCache = new Map();
    }
    const cacheKey = `${namespace}:${key}`;
    if (req.localCache.has(cacheKey)) {
      return req.localCache.get(cacheKey);
    }
    const value = loader();
    req.localCache.set(cacheKey, value);
    return value;
  }

  async function getRequestUserById(req, id) {
    return getCachedRequestValue(req, "userById", id, () => database.getUserById(id));
  }

  async function getRequestMemberById(req, id) {
    return (await getCachedRequestValue(req, "memberById", id, async () => (await database.getMemberById(id))));
  }

  async function getRequestMemberByName(req, name) {
    return (await getCachedRequestValue(req, "memberByName", name, async () => (await database.getMemberByName(name))));
  }

  async function getRequestProjectById(req, id) {
    return (await getCachedRequestValue(req, "projectById", id, async () => (await database.getProjectById(id))));
  }

  async function listRequestProjectsForMember(req, memberId) {
    return (await getCachedRequestValue(req, "projectsForMember", memberId, async () => (await database.listProjectsForMember(memberId))));
  }

  async function isRequestProjectMember(req, projectId, memberId) {
    return (await getCachedRequestValue(req, "projectMember", `${projectId}:${memberId}`, async () => (await database.isProjectMember(projectId, memberId))));
  }

  async function isRequestProjectCoordinator(req, projectId, memberId) {
    return (await getCachedRequestValue(req, "projectCoordinator", `${projectId}:${memberId}`, async () => (await database.isProjectCoordinator(projectId, memberId))));
  }

  async function countUnreadChatConversationsCached(userId) {
    const cacheKey = String(userId);
    const now = Date.now();
    const cached = unreadConversationCache.get(cacheKey);
    if (cached && now - cached.createdAt < unreadConversationCacheTtlMs) {
      return cached.value;
    }
    if (unreadConversationCache.size > 1000) {
      unreadConversationCache.clear();
    }
    const value = (await database.countUnreadChatConversationsForUser(userId));
    unreadConversationCache.set(cacheKey, { value, createdAt: now });
    return value;
  }

  function invalidateUnreadChatConversationCache(userId) {
    if (userId) {
      unreadConversationCache.delete(String(userId));
    }
  }

  async function getCachedInventoryDashboard() {
    const now = Date.now();
    if (inventoryDashboardCache && now - inventoryDashboardCache.createdAt < inventoryDashboardCacheTtlMs) {
      return inventoryDashboardCache.value;
    }
    const value = (await database.getInventoryDashboardData());
    inventoryDashboardCache = { value, createdAt: now };
    return value;
  }

  function invalidateInventoryDashboardCache() {
    inventoryDashboardCache = null;
  }

  const app = express();
  require("./asyncHttp").installAsyncHandlers(app);
  app.set("trust proxy", 1);
  app.set("view engine", "html");

  app.use("/static", express.static(config.staticDir, {
    maxAge: config.nodeEnv === "production" ? "1d" : 0,
  }));

  app.get("/healthz", (req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  const env = nunjucks.configure(config.viewsDir, {
    autoescape: true,
    express: app,
    noCache: config.nodeEnv !== "production",
  });

  env.addGlobal("urlFor", urlFor);
  env.addGlobal("url_for", urlFor);
  env.addFilter("formatDateTime", formatDateTimePt);
  env.addFilter("formatDate", formatDatePt);
  env.addFilter("dateTimeLocal", toDateTimeLocalValue);
  env.addGlobal("mediaUrl", (value) => {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    if (isRemoteAssetUrl(text)) {
      return text;
    }
    return urlFor("static", { filename: `uploads/${text}` });
  });

    // SECAO: middlewares globais de sessao, parsers e contexto comum para templates/rotas.

app.use(
    cookieSession({
      name: "ata_session",
      keys: [config.sessionSecret],
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: config.sessionIdleMaxAgeMs,
    }),
  );

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(requestContextMiddleware);
  if (ENABLE_REQUEST_LOGS || ENABLE_PERFORMANCE_LOGS) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      res.on("finish", () => {
        const elapsedMs = Date.now() - startedAt;
        const shouldLog = ENABLE_REQUEST_LOGS || elapsedMs >= SLOW_REQUEST_MS;
        if (shouldLog) {
          console.log(
            `[http] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} (${elapsedMs}ms)`,
          );
        }
      });
      next();
    });
  }
  app.use(async (req, res, next) => {
    ensureCsrfToken(req);
    req.flash = (category, message) => addFlash(req, category, message);
    const sessionExpiresAt = Number(req.session?.authExpiresAt || 0);
    if (req.session?.userId && (!sessionExpiresAt || Date.now() >= sessionExpiresAt)) {
      req.session.userId = null;
      req.session.authExpiresAt = null;
      req.flash("info", "Sua sessão expirou. Faça login novamente.");
    }
    req.currentUser = req.session?.userId
      ? (await getRequestUserById(req, req.session.userId))
      : null;
    if (req.currentUser && !req.currentUser.is_active) {
      req.session.userId = null;
      req.session.authExpiresAt = null;
      req.currentUser = null;
      req.flash("info", "Sua conta foi desativada. Faça login com outro usuário.");
    }

    res.locals.currentUser = req.currentUser;
    res.locals.isAdmin = Boolean(req.currentUser?.is_admin);
    res.locals.unreadMessageConversations = req.currentUser
      ? (await countUnreadChatConversationsCached(req.currentUser.id))
      : 0;
    res.locals.currentMember = null;
    res.locals.flashMessages = consumeFlashes(req);
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.title = "";
    res.locals.activeSection = "";
    next();
  });

    // SECAO: upload de arquivos de logo com validacao de tipo e nome sanitizado.

const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, callback) => {
        callback(null, sanitizeFilename(file.originalname));
      },
    }),
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 60,
      fieldSize: 64 * 1024,
    },
    fileFilter: (req, file, callback) => {
      const mimeType = String(file.mimetype || "").toLowerCase();
      if (!isAllowedImage(file.originalname) || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        // DETALHE: Rejeita arquivo invalido sem abortar parsing do multipart,
        // preservando campos de formulario (incluindo csrf_token) em req.body.
        req.uploadError = "Apenas imagens (jpg, jpeg, png, gif, webp, jfif) são permitidas!";
        callback(null, false);
        return;
      }

      callback(null, true);
    },
  });

  // DETALHE: Executa upload de logo e converte erro tecnico em mensagem amigavel para a tela.

  function runLogoUpload(req, res, next) {
    upload.single("logo")(req, res, (error) => {
      if (error) {
        req.uploadError = error.message;
      }
      next();
    });
  }

  // DETALHE: Executa upload de foto de membro e reutiliza mesma validacao de imagem.

  function runMemberPhotoUpload(req, res, next) {
    upload.single("photo")(req, res, (error) => {
      if (error) {
        req.uploadError = error.message;
      }
      next();
    });
  }

  async function persistUploadedImage(req, { folder }) {
    if (!req.file) {
      return null;
    }

    if (!isCloudinaryEnabled()) {
      return req.file.filename;
    }

    const uploaded = await uploadImageFromPath(req.file.path, { folder });
    safeUnlink(req.file.path);
    return uploaded.secureUrl;
  }

  async function deleteStoredImage(value) {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }

    if (isRemoteAssetUrl(text)) {
      try {
        await deleteImageByUrl(text);
      } catch (error) {
        console.error(`Falha ao remover imagem remota: ${text}`, error);
      }
      return;
    }

    safeUnlink(path.join(config.uploadDir, text));
  }

  // DETALHE: Monta URL do almoxarifado preservando aba ativa para redirecionamentos.

  function almoxPath(tab = "overview") {
    return `${urlFor("almox_home")}?tab=${normalizeAlmoxTab(tab)}`;
  }

  // DETALHE: Define para onde redirecionar quando usuario sem permissao tenta acao administrativa.

  function adminDeniedRedirect(req) {
    if (req.path.startsWith("/almoxarifado")) {
      return almoxPath(req.body?.tab || req.query?.tab);
    }

    if (req.path.startsWith("/members")) {
      return urlFor("list_members");
    }

    if (req.path.startsWith("/projects")) {
      return urlFor("list_projects");
    }

    return urlFor("relatorios");
  }

    // SECAO: guardas de acesso (autenticacao, autorizacao e protecao CSRF).

// DETALHE: Middleware de autenticacao: bloqueia acesso anonimo e envia usuario para login.

function requireAuth(req, res, next) {
    if (req.currentUser) {
      return next();
    }

    req.flash("info", "Por favor, faça login para acessar esta página.");
    const nextPath = encodeURIComponent(req.originalUrl || urlFor("relatorios"));
    return res.redirect(`${urlFor("login")}?next=${nextPath}`);
  }

  // DETALHE: Middleware para paginas administrativas com feedback via flash e redirect seguro.

  function requireAdminPage(req, res, next) {
    if (req.currentUser?.is_admin) {
      return next();
    }

    req.flash(
      "warning",
      "Seu perfil não tem permissão para executar esta ação administrativa.",
    );
    return res.redirect(adminDeniedRedirect(req));
  }

  // DETALHE: Middleware para APIs administrativas retornando 403 em JSON.

  function requireAdminApi(req, res, next) {
    if (req.currentUser?.is_admin) {
      return next();
    }

    return res.status(403).json({
      error: "Seu perfil não tem permissão para executar esta ação administrativa.",
    });
  }

  // DETALHE: Resolve membro atual a partir da sessao e cacheia resultado no request.

  async function getCurrentMember(req) {
    if (req.currentMemberResolved) {
      return req.currentMember || null;
    }

    req.currentMemberResolved = true;
    if (!req.currentUser) {
      req.currentMember = null;
      return null;
    }

    if (req.currentUser.member_id) {
      const linkedMember = (await getRequestMemberById(req, req.currentUser.member_id));
      if (linkedMember) {
        req.currentMember = linkedMember;
        if (req.res?.locals) {
          req.res.locals.currentMember = req.currentMember;
        }
        return req.currentMember;
      }
    }

    const fromName = (await getRequestMemberByName(req, req.currentUser.name));
    const fromUsername = (await getRequestMemberByName(req, req.currentUser.username));
    req.currentMember = fromName || fromUsername || null;
    if (req.res?.locals) {
      req.res.locals.currentMember = req.currentMember;
    }
    return req.currentMember;
  }

  // DETALHE: Lista projetos acessiveis de acordo com perfil e vinculo de membro.

  async function listAccessibleProjects(req) {
    if (req.currentUser?.is_admin) {
      return (await database.listProjectsBasic());
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return [];
    }

    return (await listRequestProjectsForMember(req, currentMember.id));
  }

  // DETALHE: Regra de autorizacao para criacao de ata em projeto especifico.

  async function canCreateAtaForProject(req, project) {
    if (!project) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    return (await isRequestProjectMember(req, project.id, currentMember.id));
  }

  // DETALHE: Regra de autorizacao para manutencao de projeto (coordenador/admin).

  async function canManageProject(req, project) {
    if (!project) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    return (await isRequestProjectCoordinator(req, project.id, currentMember.id));
  }

  // DETALHE: Regra de autorizacao para editar/excluir entradas de relatorio.

  async function canManageReportEntry(req, reportEntry) {
    if (!reportEntry?.project) {
      return false;
    }
    return (await canManageProject(req, reportEntry.project));
  }

  // DETALHE: Regra de autorizacao para metas semanais por membro/projeto.

  async function canManageReportGoal(req, { memberId, projectId }) {
    if (!memberId || !projectId) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    if (
      currentMember.id === memberId &&
      (await isRequestProjectMember(req, projectId, currentMember.id))
    ) {
      return true;
    }

    return (await isRequestProjectCoordinator(req, projectId, currentMember.id));
  }

  async function canDeleteCompletedGoalFromOthers(req, goal) {
    if (!goal?.is_completed) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    if (!goal?.id || !goal?.project_id || !goal?.member_id) {
      return false;
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    return (await isRequestProjectCoordinator(req, goal.project_id, currentMember.id));
  }

  async function canDeleteGoalFromExecution(req, goal) {
    if (!goal?.id || !goal?.project_id) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    return (await isRequestProjectCoordinator(req, goal.project_id, currentMember.id));
  }

  // DETALHE: Valida token CSRF para formularios e interrompe fluxo quando invalido.

  function ensureValidCsrf(req, res) {
    if (verifyCsrf(req)) {
      return true;
    }

    req.flash("danger", "A sessão do formulário expirou. Tente novamente.");
    res.redirect(req.get("referer") || urlFor("relatorios"));
    return false;
  }

  // DETALHE: Valida token CSRF para rotas API e responde erro padrao quando invalido.

  function ensureValidApiCsrf(req, res) {
    if (verifyCsrf(req)) {
      return true;
    }

    res.status(403).json({
      error: "CSRF token inválido ou expirado.",
    });
    return false;
  }

    // SECAO: helpers de renderizacao para reduzir repeticao entre telas.

// DETALHE: Wrapper de renderizacao para aplicar titulo/section padrao em todas as views.

function render(res, template, data = {}) {
    res.render(template, {
      title: data.title || "",
      activeSection: data.activeSection || "",
      ...data,
    });
  }

  // DETALHE: Resposta 404 padronizada para recursos inexistentes.

  function notFound(res) {
    return res.status(404).render("errors/404.html", {
      title: "Página Não Encontrada",
      activeSection: "",
    });
  }

  // DETALHE: Renderiza tela de login centralizando defaults de formulario e erros.

  function renderLogin(res, { formData = {}, errors = {} } = {}) {
    return render(res, "login.html", {
      title: "Entrar",
      formData,
      errors,
      next: formData.next || "",
    });
  }

  // DETALHE: Renderiza formulario de membro com dados e mensagens de validacao.

  function renderMemberForm(res, data) {
    return render(res, "members/form.html", {
      title: data.title,
      activeSection: "members",
      formData: data.formData,
      errors: data.errors || {},
      actionLabel: data.actionLabel,
      member: data.member || null,
    });
  }

  // DETALHE: Renderiza formulario de projeto incluindo membros ativos e controle de permissao.

  async function renderProjectForm(res, data) {
    const normalizedFormData = {
      name: "",
      primaryColor: DEFAULT_PROJECT_COLOR,
      memberIds: [],
      coordinatorIds: [],
      logoClear: false,
      ...(data.formData || {}),
    };

    return render(res, "projects/form.html", {
      title: data.title,
      activeSection: "projects",
      formData: normalizedFormData,
      errors: data.errors || {},
      actionLabel: data.actionLabel,
      activeMembers: (await database.listActiveMembers()),
      project: data.project || null,
      canManageProject: Boolean(data.canManageProject),
      canManageCoordinators: Boolean(data.canManageCoordinators),
    });
  }

  // DETALHE: Renderiza formulario de ata conforme projeto selecionado e membros disponiveis.

  async function renderAtaForm(req, res, data) {
    const availableProjects = data.projects || (await listAccessibleProjects(req));
    const availableProjectIds = new Set(availableProjects.map((project) => project.id));
    const selectedProjectId = parseId(data.formData.projectId);
    const selectedProject = selectedProjectId && availableProjectIds.has(selectedProjectId)
      ? (await getRequestProjectById(req, selectedProjectId))
      : null;
    const selectedProjectMembers = selectedProject
      ? selectedProject.active_members
      : [];
    const normalizedFormData = {
      ...data.formData,
      projectId: selectedProjectId || "",
    };

    return render(res, "atas/create_form.html", {
      title: data.title || "Criar Nova Ata",
      activeSection: "atas",
      formData: normalizedFormData,
      errors: data.errors || {},
      projects: availableProjects,
      selectedProject,
      selectedProjectMembers,
    });
  }

  // DETALHE: Renderiza tela de relatorios com filtros, resumo, formulario e lista de entradas.

  async function renderReportPage(req, res, data = {}) {
    if (Date.now() - warningCycleLastCheckedAt >= warningCycleCheckIntervalMs) {
      warningCycleLastCheckedAt = Date.now();
      (await database.applySemiannualMemberWarningCycle());
    }
    const currentMember = (await getCurrentMember(req));
    const currentWeekStart = getCurrentWeekStartDate();
    const selectedNoteWeekStart = normalizeWeekStartDate(req.query.note_week_start) || currentWeekStart;
    const nowSql = toSqlDateTime(new Date());
    if (Date.now() - plannerLifecycleLastCheckedAt >= plannerLifecycleCheckIntervalMs) {
      plannerLifecycleLastCheckedAt = Date.now();
      (await database.refreshPlannerTaskLifecycle({ graceDays: 0 }));
    }
    const membersSummary = (await database.listReportMembersSummary());
    const requestedMemberId = parseId(data.selectedMemberId || req.query.member_id);
    const selectedMemberId =
      requestedMemberId ||
      currentMember?.id ||
      membersSummary.find((member) => member.total_entries > 0)?.id ||
      membersSummary[0]?.id ||
      null;

    const selectedMember =
      selectedMemberId && membersSummary.some((member) => member.id === selectedMemberId)
        ? (await getRequestMemberById(req, selectedMemberId))
        : null;
    const selectedMemberWarningState = selectedMember
      ? (await database.getMemberWarningState(selectedMember.id))
      : null;
    if (selectedMember && selectedMemberWarningState) {
      Object.assign(selectedMember, selectedMemberWarningState);
    }
    const canManageWarnings = Boolean(
      req.currentUser?.id
      && (await database.isUserMemberOfProjectName(req.currentUser.id, "Administrativo")),
    );
    const tutorFortnightNote = (req.currentUser?.role === "tutor" && selectedMember)
      ? (await database.getReportFortnightTutorNote({
        tutorUserId: req.currentUser.id,
        memberId: selectedMember.id,
        weekStart: selectedNoteWeekStart,
      }))
      : null;
    const canWriteOwnFortnightComplement = Boolean(
      selectedMember
      && currentMember?.is_active
      && Number(selectedMember.id) === Number(currentMember.id)
      && req.currentUser?.role !== "tutor",
    );
    const memberFortnightNote = canWriteOwnFortnightComplement
      ? (await database.getReportFortnightMemberNote({
        memberId: selectedMember.id,
        weekStart: selectedNoteWeekStart,
      }))
      : null;
    const defaultTutorUser = canWriteOwnFortnightComplement
      ? ((await database.listUsers()).find((user) => user.role === "tutor") || null)
      : null;
    const isSelectedFortnightClosed = Boolean(selectedMember && selectedNoteWeekStart && (
      String(selectedNoteWeekStart) < String(currentWeekStart)
    ));
    const requestedProjectId = parseId(data.selectedProjectId || req.query.project_id);
    const currentMemberProjectList = currentMember?.is_active
      ? (await listRequestProjectsForMember(req, currentMember.id))
      : [];
    const coordinatorProjectIds = currentMember?.is_active
      ? new Set(
          (await asyncArray.filter(currentMemberProjectList, async (project) => (await isRequestProjectCoordinator(req, project.id, currentMember.id))))
            .map((project) => project.id),
        )
      : new Set();
    const reportProjectOptions = selectedMember
      ? (await listRequestProjectsForMember(req, selectedMember.id)).map((project) => ({
          ...project,
          can_create_for_others: Boolean(
            req.currentUser?.is_admin
            || (currentMember?.is_active && coordinatorProjectIds.has(project.id)),
          ),
        }))
      : [];
    const validProjectIds = new Set(reportProjectOptions.map((project) => project.id));
    const selectedProjectId = requestedProjectId && validProjectIds.has(requestedProjectId)
      ? requestedProjectId
      : null;

    const reportGoals = selectedMember
      ? (await asyncArray.map((await database.listReportWeekGoalsForMember(selectedMember.id, {
          projectId: selectedProjectId || null,
          currentWeekStart,
          nowSql,
          limit: 400,
        })), async (goal) => ({
          ...goal,
          can_manage: (await canManageReportGoal(req, {
            memberId: goal.member_id,
            projectId: goal.project_id,
          })),
          can_delete_completed: (await canDeleteCompletedGoalFromOthers(req, goal)),
          can_delete_from_execution: (await canDeleteGoalFromExecution(req, goal)),
        })))
      : [];
    const pendingGoals = reportGoals.filter((goal) => !goal.is_completed);
    const completedGoals = reportGoals
      .filter((goal) => goal.is_completed)
      .sort((left, right) => (
        String(right.completed_at || right.updated_at || right.due_at || "").localeCompare(
          String(left.completed_at || left.updated_at || left.due_at || ""),
        )
        || right.id - left.id
      ));
    const overduePendingGoals = pendingGoals
      .filter((goal) => goal.is_overdue)
      .sort((left, right) => (
        String(left.due_at || left.week_start).localeCompare(String(right.due_at || right.week_start))
        || left.id - right.id
      ));
    const activePendingGoals = pendingGoals.filter((goal) => !goal.is_overdue);
    const inProgressGoals = activePendingGoals
      .filter((goal) => !goal.is_overdue && goal.week_start === currentWeekStart)
      .sort((left, right) => left.id - right.id);
    const futurePendingGoals = activePendingGoals
      .filter((goal) => !goal.is_overdue && goal.week_start > currentWeekStart)
      .sort((left, right) => (
        left.week_start.localeCompare(right.week_start) || left.id - right.id
      ));
    const canCreateAsCoordinator = Boolean(
      selectedMember && currentMember?.is_active
      && reportProjectOptions.some((project) => coordinatorProjectIds.has(project.id)),
    );
    const createGoalProjectOptions = await (async () => {
      if (!currentMember?.is_active && !req.currentUser?.is_admin) {
        return [];
      }
      const baseProjects = req.currentUser?.is_admin
        ? (await database.listProjectsBasic())
        : currentMemberProjectList;
      return (await asyncArray.map(baseProjects, async (project) => ({
        ...project,
        can_create_for_others: Boolean(
          req.currentUser?.is_admin
          || (currentMember?.is_active && (await isRequestProjectMember(req, project.id, currentMember.id))),
        ),
      })));
    })();
    const canUseAdvancedGoalCreateForm = Boolean(
      req.currentUser?.is_admin
      || (currentMember?.is_active && createGoalProjectOptions.length > 0),
    );
    const canCreateGoalsForSelectedMember = Boolean(
      selectedMember && (
        req.currentUser?.is_admin
        || (currentMember?.is_active && currentMember.id === selectedMember.id)
        || canCreateAsCoordinator
        || (canUseAdvancedGoalCreateForm && createGoalProjectOptions.length > 0)
      ),
    );
    const deletionLogs = selectedMember
      ? (await database.listReportWeekGoalDeletionLogsForMember(selectedMember.id, {
          projectId: selectedProjectId || null,
          limit: 30,
        }))
      : [];
    const taskAuditLogs = selectedMember
      ? (await database.listTaskAuditLogsForMember(selectedMember.id, {
          projectId: selectedProjectId || null,
          limit: 80,
        }))
      : [];
    const goalsSummary = reportGoals.reduce(
      (summary, goal) => {
        summary.total += 1;
        if (goal.is_completed) {
          summary.completed += 1;
        } else if (goal.is_overdue) {
          summary.overdue += 1;
        } else {
          summary.pending += 1;
        }
        summary.projectIds.add(goal.project.id);
        summary.weekStarts.add(goal.week_start);
        return summary;
      },
      {
        total: 0,
        completed: 0,
        overdue: 0,
        pending: 0,
        projectIds: new Set(),
        weekStarts: new Set(),
      },
    );

    const warningEvents = selectedMember ? (await database.listMemberWarningEvents(selectedMember.id)) : [];
    const activeWarningEvents = warningEvents.filter((event) => event.is_warning && !event.is_deleted);

    return render(res, "reports/index.html", {
      title: "Relatórios",
      activeSection: "reports",
      activeAtaTab: "reports",
      selectedMemberId: selectedMember ? selectedMember.id : null,
      selectedProjectId: selectedProjectId || "",
      selectedMember,
      canManageWarnings,
      warningEvents,
      activeWarningEvents,
      membersSummary,
      reportProjectOptions,
      createGoalProjectOptions,
      reportGoals,
      pendingGoals,
      completedGoals,
      deletionLogs,
      taskAuditLogs,
      canUseWritingSpace: Boolean(req.currentUser?.is_admin || req.currentUser?.role === "tutor"),
      writingGeneralEntries: req.currentUser?.is_admin
        ? (await database.listWritingGeneralEntries())
        : [],
      writingTutorPrivateEntries: req.currentUser?.role === "tutor"
        ? (await database.listWritingTutorPrivateEntries(req.currentUser.id))
        : [],
      tutorFortnightNote,
      memberFortnightNote,
      canWriteOwnFortnightComplement,
      defaultTutorUser,
      isSelectedFortnightClosed,
      overduePendingGoals,
      inProgressGoals,
      futurePendingGoals,
      canCreateGoalsForSelectedMember,
      canUseAdvancedGoalCreateForm,
      currentWeekStart,
      selectedNoteWeekStart,
      currentMember,
      goalFormData: {
        projectId: selectedProjectId || "",
        memberId: String(selectedMember?.id || ""),
        memberIds: [],
        activity: "",
        description: "",
        dueAt: "",
        isCompleted: false,
        recurrenceEnabled: false,
        recurrenceIntervalDays: "7",
        recurrenceUnit: "days",
        recurrenceMemberIds: [],
        ...(data.goalFormData || {}),
      },
      goalFormErrors: data.goalFormErrors || {},
      monthlyReportForm: {
        memberId: String(
          data.monthlyReportForm?.memberId
            || selectedMember?.id
            || currentMember?.id
            || "",
        ),
        month: String(
          data.monthlyReportForm?.month || getCurrentMonthKeyInSaoPaulo(),
        ),
      },
      canGenerateMonthlyReportForAny: Boolean(req.currentUser?.is_admin),
      goalsSummary: {
        total: goalsSummary.total,
        completed: goalsSummary.completed,
        overdue: goalsSummary.overdue,
        pending: goalsSummary.pending,
        totalProjects: goalsSummary.projectIds.size,
        totalWeeks: goalsSummary.weekStarts.size,
      },
      currentReportsQuery: buildReportsQuery({
        memberId: selectedMember?.id || null,
        projectId: selectedProjectId || null,
      }),
    });
  }

  // DETALHE: Renderiza dashboard do almoxarifado com estado atual de abas e formularios.

  async function renderAlmox(res, data = {}) {
    const activeTab = normalizeAlmoxTab(data.activeTab);
    const inventoryEditOpenId = parseId(data.inventoryEditOpenId);
    const inventoryEditFormData = data.inventoryEditFormData || {};
    const inventoryEditErrors = data.inventoryEditErrors || {};
    const needsDashboard = activeTab === "overview" || activeTab === "manage";
    const needsAllItems = activeTab === "manage";
    const needsStockItems = activeTab === "stock" || activeTab === "withdraw";
    const needsPatrimonyItems = activeTab === "borrow";
    const needsCatalog = activeTab === "manage";
    const needsRequests = activeTab === "requests";
    const needsLoans = activeTab === "borrowed";
    const rawInventoryItems = needsAllItems ? (await database.listInventoryItems()) : [];
    const stockItems = needsAllItems || needsStockItems
      ? (needsAllItems
          ? rawInventoryItems.filter((item) => item.item_type === "stock")
          : (await database.listInventoryItems({ type: "stock" })))
      : [];
    const patrimonyItems = needsAllItems || needsPatrimonyItems
      ? (needsAllItems
          ? rawInventoryItems.filter((item) => item.item_type === "patrimony")
          : (await database.listInventoryItems({ type: "patrimony" })))
      : [];
    const inventoryItems = rawInventoryItems.map((item) => ({
      ...item,
      edit_form_data: {
        name: item.name,
        itemType: item.item_type,
        categoryId: item.category_id || "",
        categoryName: "",
        locationId: item.location_id || "",
        locationName: "",
        quantity: String(item.amount),
        description: item.description,
        ...(item.id === inventoryEditOpenId ? inventoryEditFormData : {}),
      },
      edit_errors: item.id === inventoryEditOpenId ? inventoryEditErrors : {},
      is_edit_open: item.id === inventoryEditOpenId,
    }));
    const emptyDashboard = {
      summary: {
        user_count: 0,
        item_count: 0,
        stock_item_count: 0,
        patrimony_item_count: 0,
        category_count: 0,
        location_count: 0,
        request_count: 0,
        active_loan_count: 0,
        overdue_loan_count: 0,
        total_units: 0,
        stock_units: 0,
        patrimony_units: 0,
      },
      recent_requests: [],
      recent_loans: [],
      recent_users: [],
    };

    return render(res, "almoxarifado/index.html", {
      title: "Almoxarifado",
      activeSection: "almox",
      activeTab,
      dashboard: needsDashboard ? await getCachedInventoryDashboard() : emptyDashboard,
      inventoryItems,
      stockItems,
      patrimonyItems,
      categories: needsCatalog ? (await database.listInventoryCategories()) : [],
      locations: needsCatalog ? (await database.listInventoryLocations()) : [],
      requests: needsRequests ? (await database.listInventoryRequests()) : [],
      activeLoans: needsLoans ? (await database.listInventoryLoans({ status: "active" })) : [],
      returnedLoans: needsLoans ? (await database.listInventoryLoans({ status: "returned", limit: 12 })) : [],
      overdueLoans: needsLoans ? (await database.listInventoryLoans({ status: "overdue" })) : [],
      itemFormData: {
        name: "",
        itemType: "stock",
        categoryId: "",
        categoryName: "",
        locationId: "",
        locationName: "",
        quantity: "",
        description: "",
        ...(data.itemFormData || {}),
      },
      itemErrors: data.itemErrors || {},
      categoryFormData: {
        name: "",
        ...(data.categoryFormData || {}),
      },
      categoryErrors: data.categoryErrors || {},
      locationFormData: {
        name: "",
        ...(data.locationFormData || {}),
      },
      locationErrors: data.locationErrors || {},
      withdrawFormData: {
        nameOrCode: "",
        quantity: "",
        ...(data.withdrawFormData || {}),
      },
      withdrawErrors: data.withdrawErrors || {},
      loanFormData: {
        nameOrCode: "",
        quantity: "1",
        ...(data.loanFormData || {}),
      },
      loanErrors: data.loanErrors || {},
      loanExtendDefaults: {
        extraDays: "7",
      },
    });
  }

  // DETALHE: Renderiza central de manutencao de usuarios com criacao, vinculo, senha e exclusao.

  async function renderUserMaintenance(res, data = {}) {
    const users = (await database.listUsers());
    const members = (await database.listActiveMembers());
    const projects = (await database.listProjectsWithMembers());
    const adminUsers = users.filter((user) => user.is_admin);
    const commonUsers = users.filter((user) => !user.is_admin);

    return render(res, "users_maintenance/index.html", {
      title: "Manutenção de Usuários",
      activeSection: "user_maintenance",
      users,
      members,
      projects,
      summary: {
        usersTotal: users.length,
        adminsTotal: adminUsers.length,
        commonTotal: commonUsers.length,
        membersTotal: members.length,
        projectsTotal: projects.length,
      },
      userFormData: {
        name: "",
        username: "",
        email: "",
        password: "",
        role: "common",
        memberId: "",
        ...(data.userFormData || {}),
      },
      userErrors: data.userErrors || {},
    });
  }

  // DETALHE: Normaliza payload de inventario vindo de forms web ou API JSON.

  function parseInventoryPayload(source = {}) {
    const quantityValue =
      source.quantity ??
      source.quantidade ??
      source.amount ??
      "";

    return {
      name: String(source.name || source.nome || "").trim(),
      itemType: normalizeInventoryItemType(
        String(source.item_type || source.itemType || source.tipo || "stock")
          .trim()
          .toLowerCase(),
      ),
      categoryId: parseId(source.category_id || source.categoryId || source.categoria_id),
      category: trimToNull(
        source.category_name || source.category || source.categoria_nome || source.categoria,
      ),
      locationId: parseId(source.location_id || source.locationId || source.local_id),
      location: trimToNull(
        source.location_name || source.location || source.local_nome || source.local,
      ),
      quantity: String(quantityValue).trim(),
      description: String(source.description || source.descricao || "").trim(),
    };
  }

  // DETALHE: Valida campos obrigatorios e limites antes de criar/editar item de inventario.

  function validateInventoryPayload(payload) {
    return validateInventoryPayloadShared(payload, INVENTORY_ITEM_TYPES);
  }

  // DETALHE: Valida nome de catalogos auxiliares (categoria/local) com regras comuns.

  function validateCatalogName(name, entityLabel = "nome") {
    return validateCatalogNameShared(name, entityLabel);
  }

  // SECAO: rotas modularizadas por dominio (auth, relatorios, membros e projetos).

  app.use(["/almoxarifado", "/manutencao-usuarios"], (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      invalidateInventoryDashboardCache();
    }
    next();
  });

  const sharedRouteContext = {
    app,
    path,
    config,
    bcrypt,
    database,
    generateMonthlyReportPdf,
    urlFor,
    render,
    renderLogin,
    renderMemberForm,
    renderProjectForm,
    renderAtaForm,
    renderReportPage,
    renderUserMaintenance,
    runMemberPhotoUpload,
    runLogoUpload,
    ensureValidCsrf,
    ensureCsrfToken,
    verifyCsrf,
    safeRedirectPath,
    logError,
    sendApiError,
    mapInventoryApiItem,
    validateWeekGoalForm,
    canGenerateMonthlyReport,
    buildMonthlyPdfFilename,
    syncReportWeekGoalFromPlannerTask: database.syncReportWeekGoalFromPlannerTask,
    notificationService,
    invalidateUnreadChatConversationCache,
    invalidateInventoryDashboardCache,
    canManageProject,
    canCreateAtaForProject,
    canManageReportGoal,
    canDeleteCompletedGoalFromOthers,
    canDeleteGoalFromExecution,
    getCurrentMember,
    getRequestMemberById,
    getRequestProjectById,
    listRequestProjectsForMember,
    isRequestProjectMember,
    isRequestProjectCoordinator,
    getCurrentWeekStartDate,
    getCurrentMonthKeyInSaoPaulo,
    normalizeMonthKey,
    defaultMeetingDateTimeInput,
    buildReportsQuery,
    parseId,
    parseIdArray,
    normalizeProjectColor,
    DEFAULT_PROJECT_COLOR,
    toSqlDateTime,
    trimToNull,
    formatDatePt,
    generateAtaPdf,
    listAccessibleProjects,
    persistUploadedImage,
    deleteStoredImage,
    isUniqueConstraintError,
    safeUnlink,
    notFound,
    requireAuth,
    requireAdminPage,
  };

  registerAuthRoutes(sharedRouteContext);
  registerReportRoutes(sharedRouteContext);
  registerMemberRoutes(sharedRouteContext);
  registerProjectRoutes(sharedRouteContext);
  registerAtaRoutes(sharedRouteContext);
  registerPresenceRoutes(sharedRouteContext);
  registerWritingRoutes(sharedRouteContext);
  registerChatRoutes(sharedRouteContext);

  // SECAO: rotas do almoxarifado modularizadas.

  registerAlmoxRoutes({
    ...sharedRouteContext,
    requireAdminApi,
    ensureValidApiCsrf,
    renderAlmox,
    almoxPath,
    parseInventoryPayload,
    validateInventoryPayload,
    validateCatalogName,
    canCreateAtaForProject,
  });

  // SECAO: fallback de erro (404) e handler global de excecoes (500).

app.use((req, res) => {
    return notFound(res);
  });

  app.use((error, req, res, next) => {
    logError(req, "Erro interno do servidor:", error);
    res.status(500).render("errors/500.html", {
      title: "Erro Interno",
      activeSection: "",
    });
  });

  return app;
}

module.exports = { createApp };

