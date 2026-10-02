const asyncArray = require("../asyncArray");
﻿/*
 * ARQUIVO: src/routes/auth.js
 * FUNCAO: registra rotas de autenticacao, navegacao inicial e presenca.
 * IMPACTO DE MUDANCAS:
 * - Alterar campos/validacao de login afeta sessao de todos os usuarios.
 * - Alterar retorno JSON de presenca impacta o frontend que consome a API.
 */
const databaseAsync = require("../databaseAsync");

function buildPlannerQuery({
  view = "member",
  projectId = null,
  memberId = null,
  month = null,
  day = null,
  returnAnchor = null,
  hideCreate = false,
  embedded = false,
} = {}) {
  const params = new URLSearchParams();
  params.set("view", view === "project" ? "project" : "member");
  if (projectId) {
    params.set("project_id", String(projectId));
  }
  if (memberId) {
    params.set("member_id", String(memberId));
  }
  if (month) {
    params.set("month", String(month));
  }
  if (day) {
    params.set("day", String(day));
  }
  if (returnAnchor === "report-member-selector" || returnAnchor === "report-goals-panel") {
    params.set("return_anchor", returnAnchor);
  }
  if (hideCreate) {
    params.set("hide_create", "1");
  }
  if (embedded) {
    params.set("embedded", "1");
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function registerAuthRoutes(ctx) {
  const {
    app,
    config,
    bcrypt,
    database,
    urlFor,
    render,
    renderLogin,
    renderUserMaintenance,
    requireAuth,
    requireAdminPage,
    canManageProject,
    getCurrentMember,
    getRequestMemberById,
    getRequestProjectById,
    isRequestProjectMember,
    listAccessibleProjects,
    ensureValidCsrf,
    ensureCsrfToken,
    safeRedirectPath,
    parseId,
    getCurrentWeekStartDate,
    toSqlDateTime,
    trimToNull,
    logError,
    syncReportWeekGoalFromPlannerTask,
  } = ctx;
  const loginDefaultPath = "/relatorios";

  async function canDeletePlannerTask(req, task) {
    if (!task) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    if (Number(task.assigned_member_id) === Number(currentMember.id)) {
      return true;
    }

    return (await canManageProject(req, task.project));
  }

  async function canCompletePlannerTask(req, task) {
    return (await canDeletePlannerTask(req, task));
  }

  async function canCreatePlannerTaskForMember(req, project, memberId) {
    if (!project || !memberId) {
      return false;
    }

    if ((await canManageProject(req, project))) {
      return true;
    }

    const currentMember = (await getCurrentMember(req));
    return Boolean(
      currentMember?.is_active
      && Number(currentMember.id) === Number(memberId)
      && (await isRequestProjectMember(req, project.id, currentMember.id)),
    );
  }

  function parseQueueMemberIds(rawValue) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const seen = new Set();
    const queue = [];
    values.forEach((value) => {
      const parsed = parseId(value);
      if (!parsed || seen.has(parsed)) {
        return;
      }
      seen.add(parsed);
      queue.push(parsed);
    });
    return queue;
  }

  function addDaysToSqlDateTime(sqlDateTime, days) {
    const text = String(sqlDateTime || "").trim();
    const match = text.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!match) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const date = new Date(Date.UTC(year, month, day, hour, minute, second));
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }

  function addIntervalToSqlDateTime(sqlDateTime, amount, unit) {
    const text = String(sqlDateTime || "").trim();
    const match = text.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!match) {
      return null;
    }

    const every = Number(amount || 0);
    if (!Number.isInteger(every) || every < 1) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const date = new Date(Date.UTC(year, month, day, hour, minute, second));

    if (unit === "weeks") {
      date.setUTCDate(date.getUTCDate() + (every * 7));
    } else if (unit === "months") {
      date.setUTCMonth(date.getUTCMonth() + every);
    } else {
      date.setUTCDate(date.getUTCDate() + every);
    }

    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }

  function normalizePlannerStatus(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "in_progress" || raw === "done" || raw === "todo") {
      return raw;
    }
    return "todo";
  }

  function normalizePlannerRecurrenceUnit(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "weeks" || raw === "months") {
      return raw;
    }
    return "days";
  }

app.get("/login", (req, res) => {
    if (req.currentUser) {
      return res.redirect(loginDefaultPath);
    }

    return renderLogin(res, {
      formData: {
        username: "",
        next: String(req.query.next || ""),
      },
      errors: {},
    });
  });

  // DETALHE: Rota POST /login: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/login", async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    if (req.currentUser) {
      return res.redirect(loginDefaultPath);
    }

    const formData = {
      username: String(req.body.username || "").trim(),
      next: String(req.body.next || ""),
    };
    const password = String(req.body.password || "");
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const errors = {};

    if (!formData.username) {
      errors.username = ["Nome de usuário é obrigatório."];
    }

    if (!password) {
      errors.password = ["Senha é obrigatória."];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(errors).length > 0) {
      return renderLogin(res, { formData, errors });
    }

    const user = (await database.getUserByUsername(formData.username));

    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      req.flash("danger", "Usuário ou senha inválidos.");
      const nextQuery = formData.next
        ? `?next=${encodeURIComponent(formData.next)}`
        : "";
      return res.redirect(`${urlFor("login")}${nextQuery}`);
    }

    req.session.userId = user.id;
    req.session.authExpiresAt = Date.now() + config.sessionIdleMaxAgeMs;
    req.flash("success", "Login realizado com sucesso!");

    const nextPath = safeRedirectPath(
      req.body.next,
      loginDefaultPath,
    );
    return res.redirect(nextPath);
  });

  // DETALHE: Rota GET /logout: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/logout", requireAuth, (req, res) => {
    req.session = {
      authExpiresAt: null,
      flashes: [
        {
          category: "info",
          message: "Você saiu da sua conta.",
        },
      ],
    };
    ensureCsrfToken(req);
    return res.redirect(urlFor("login"));
  });

  // DETALHE: Rota GET /: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/", requireAuth, (req, res) => {
    return res.redirect(loginDefaultPath);
  });

    // SECAO: rotas gerais de navegacao (services/home/presenca).

// DETALHE: Rota GET /services: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/services", requireAuth, (req, res) => {
    return res.redirect(loginDefaultPath);
  });

  // DETALHE: Rota GET /manutencao-usuarios: hub administrativo para membros, projetos e usuarios de acesso.

  app.get("/manutencao-usuarios", requireAuth, requireAdminPage, async (req, res) => {
    return (await renderUserMaintenance(res));
  });

  // DETALHE: Rota GET /home: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/home", requireAuth, async (req, res, next) => {
    const tab = req.query.tab || "home";
    let recentAtas;
    try {
      recentAtas = (await asyncArray.map((await databaseAsync.listRecentAtas(5)), async (ata) => ({
        ...ata,
        canDelete: (await canManageProject(req, ata.project)),
      })));
    } catch (error) {
      return next(error);
    }

    return render(res, "home.html", {
      title: "Atas",
      activeSection: "atas",
      activeAtaTab: tab,
      recentAtas,
    });
  });

  // DETALHE: Rota GET /planner: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/planner", requireAuth, async (req, res, next) => {
    const currentMember = (await getCurrentMember(req));
    const isAdmin = Boolean(req.currentUser?.is_admin);
    const requestedView = String(req.query.view || "").trim().toLowerCase();
    const viewMode = requestedView === "project" ? "project" : "member";
    const requestedReturnAnchor = String(req.query.return_anchor || "").trim();
    const plannerReturnAnchor = requestedReturnAnchor === "report-member-selector"
      ? "report-member-selector"
      : "report-goals-panel";
    const hidePlannerCreate = String(req.query.hide_create || "").trim() === "1";
    const plannerEmbedded = String(req.query.embedded || "").trim() === "1";
    const accessibleProjects = (await listAccessibleProjects(req));
    const accessibleProjectIds = new Set(accessibleProjects.map((project) => project.id));
    const fullAccessibleProjects = (await database.listProjectsWithMembersByIds(
      accessibleProjects.map((project) => project.id),
    ));
    const fullAccessibleProjectsById = new Map(
      fullAccessibleProjects.map((project) => [Number(project.id), project]),
    );
    const requestedProjectId = parseId(req.query.project_id);
    const selectedProject = requestedProjectId && accessibleProjectIds.has(requestedProjectId)
      ? fullAccessibleProjectsById.get(Number(requestedProjectId)) || null
      : (accessibleProjects[0] ? fullAccessibleProjectsById.get(Number(accessibleProjects[0].id)) || null : null);
    const selectedProjectId = selectedProject?.id || null;

    let selectedMember = null;
    const requestedMemberId = parseId(req.query.member_id);
    if (isAdmin) {
      selectedMember = requestedMemberId
        ? (await getRequestMemberById(req, requestedMemberId))
        : (currentMember || null);
      if (!selectedMember) {
        selectedMember = (await database.listActiveMembers())[0] || null;
      }
    } else {
      selectedMember = currentMember || null;
    }

    const selectedMemberId = selectedMember?.id || null;
    const memberOptions = isAdmin
      ? (await database.listActiveMembers())
      : (selectedMember ? [selectedMember] : []);
    const memberViewMode = viewMode === "member";
    const effectiveViewMode = memberViewMode ? "member" : "project";
    const nowDate = new Date();
    const currentMonthKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
    }).format(nowDate);
    const requestedMonthKey = String(req.query.month || "").trim();
    const plannerMonth = /^\d{4}-\d{2}$/.test(requestedMonthKey)
      ? requestedMonthKey
      : currentMonthKey;
    const [yearText, monthText] = plannerMonth.split("-");
    const monthYear = Number(yearText);
    const monthIndex = Number(monthText) - 1;
    const monthStart = new Date(Date.UTC(monthYear, monthIndex, 1));
    const monthEnd = new Date(Date.UTC(monthYear, monthIndex + 1, 0));
    const plannerDueFrom = `${plannerMonth}-01 00:00:00`;
    const nextMonthForQuery = new Date(Date.UTC(monthYear, monthIndex + 1, 1));
    const plannerDueTo = `${nextMonthForQuery.getUTCFullYear()}-${String(nextMonthForQuery.getUTCMonth() + 1).padStart(2, "0")}-01 00:00:00`;
    let baseTasks;
    try {
      baseTasks = effectiveViewMode === "project"
      ? (selectedProjectId ? await databaseAsync.listPlannerTasks({
          projectId: selectedProjectId,
          includeCompleted: false,
          dueFrom: plannerDueFrom,
          dueTo: plannerDueTo,
        }) : [])
      : (selectedMemberId ? await databaseAsync.listPlannerTasks({
          memberId: selectedMemberId,
          includeCompleted: false,
          dueFrom: plannerDueFrom,
          dueTo: plannerDueTo,
        }) : []);
    } catch (error) {
      return next(error);
    }
    const visibleTasks = isAdmin
      ? baseTasks
      : baseTasks.filter((task) => accessibleProjectIds.has(task.project_id));

    const nowIso = toSqlDateTime(new Date());
    const plannerTasks = visibleTasks
      .filter((task) => !task.is_completed)
      .map((task) => ({
      ...task,
      is_overdue: !task.is_completed && database.isReportDueOverdue(task.due_at, nowIso),
      }));
    const firstWeekday = monthStart.getUTCDay(); // 0 = domingo
    const daysInMonth = monthEnd.getUTCDate();
    const prevMonthEnd = new Date(Date.UTC(monthYear, monthIndex, 0));
    const daysInPrevMonth = prevMonthEnd.getUTCDate();
    const tasksByDay = {};
    plannerTasks
      .slice()
      .sort((a, b) => String(a.due_at || "").localeCompare(String(b.due_at || "")))
      .forEach((task) => {
        const dayKey = String(task.due_at || "").slice(0, 10);
        if (!dayKey) {
          return;
        }
        if (!tasksByDay[dayKey]) {
          tasksByDay[dayKey] = [];
        }
        tasksByDay[dayKey].push(task);
      });
    const cells = [];
    const totalCells = 42;
    for (let i = 0; i < totalCells; i += 1) {
      const dayOffset = i - firstWeekday;
      let cellYear = monthYear;
      let cellMonth = monthIndex;
      let dayNumber = dayOffset + 1;
      let inCurrentMonth = true;
      if (dayOffset < 0) {
        inCurrentMonth = false;
        cellMonth = monthIndex - 1;
        if (cellMonth < 0) {
          cellMonth = 11;
          cellYear -= 1;
        }
        dayNumber = daysInPrevMonth + dayOffset + 1;
      } else if (dayOffset >= daysInMonth) {
        inCurrentMonth = false;
        cellMonth = monthIndex + 1;
        if (cellMonth > 11) {
          cellMonth = 0;
          cellYear += 1;
        }
        dayNumber = dayOffset - daysInMonth + 1;
      }
      const dateKey = `${String(cellYear).padStart(4, "0")}-${String(cellMonth + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
      const dayTasks = tasksByDay[dateKey] || [];
      cells.push({
        dateKey,
        dayNumber,
        inCurrentMonth,
        isToday: dateKey === nowIso.slice(0, 10),
        tasks: dayTasks.slice(0, 2),
        taskCount: dayTasks.length,
      });
    }
    const selectedDayQuery = String(req.query.day || "").trim();
    const defaultSelectedDay = (() => {
      const todayKey = nowIso.slice(0, 10);
      if (todayKey.startsWith(`${plannerMonth}-`)) {
        return todayKey;
      }
      const firstDayWithTasks = Object.keys(tasksByDay)
        .filter((day) => day.startsWith(`${plannerMonth}-`))
        .sort()[0];
      return firstDayWithTasks || `${plannerMonth}-01`;
    })();
    const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(selectedDayQuery)
      ? selectedDayQuery
      : defaultSelectedDay;
    const selectedDayTasks = (await asyncArray.map((tasksByDay[selectedDay] || []), async (task) => ({
      ...task,
      can_delete: (await canDeletePlannerTask(req, task)),
      can_complete: (await canCompletePlannerTask(req, task)),
      can_manage: (await canManageProject(req, task.project)),
    })));
    const prevMonthDate = new Date(Date.UTC(monthYear, monthIndex - 1, 1));
    const nextMonthDate = new Date(Date.UTC(monthYear, monthIndex + 1, 1));
    const prevMonthKey = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextMonthKey = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const plannerMonthLabel = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      month: "long",
      year: "numeric",
    }).format(new Date(`${plannerMonth}-01T12:00:00Z`));

    const currentMemberId = currentMember?.is_active ? currentMember.id : null;
    const creatableProjects = (await asyncArray.filter((await asyncArray.map(fullAccessibleProjects, async (project) => (
        (await canManageProject(req, project))
        || (currentMemberId && (await isRequestProjectMember(req, project.id, currentMemberId)))
      ))), async (project) => ({
        ...project,
        can_create_for_others: (await canManageProject(req, project)),
      })));
    const creatableProjectIds = new Set(creatableProjects.map((project) => project.id));

    const plannerFormState = req.session?.plannerFormState || null;
    if (req.session?.plannerFormState) {
      req.session.plannerFormState = null;
    }
    const formData = {
      projectId: String(req.query.create_project_id || ""),
      memberId: "",
      title: "",
      description: "",
      dueAt: "",
      recurrenceEnabled: false,
      recurrenceIntervalDays: "7",
      recurrenceUnit: "days",
      recurrenceMemberIds: [],
      ...(plannerFormState?.formData || {}),
    };
    if (!formData.memberId && effectiveViewMode === "member" && selectedMemberId) {
      formData.memberId = String(selectedMemberId);
    } else if (!formData.memberId && currentMemberId) {
      formData.memberId = String(currentMemberId);
    }

    const preferredProjectForMember = effectiveViewMode === "member" && selectedMemberId
      ? (creatableProjects.find((project) => (
        project.active_members || []
      ).some((member) => member.id === selectedMemberId)) || null)
      : null;
    const requestedCreateProjectId = parseId(formData.projectId)
      || selectedProjectId
      || preferredProjectForMember?.id
      || null;
    const selectedCreateProject = requestedCreateProjectId && creatableProjectIds.has(requestedCreateProjectId)
      ? creatableProjects.find((project) => project.id === requestedCreateProjectId) || null
      : (creatableProjects[0] || null);
    const selectedCreateProjectId = selectedCreateProject?.id || null;
    const createMemberOptions = selectedCreateProject
      ? (
        (await canManageProject(req, selectedCreateProject))
          ? (selectedCreateProject.active_members || [])
          : (currentMemberId && (await isRequestProjectMember(req, selectedCreateProject.id, currentMemberId))
            ? (selectedCreateProject.active_members || []).filter((member) => member.id === currentMemberId)
            : [])
      )
      : [];
    const createMemberIds = new Set(createMemberOptions.map((member) => member.id));
    if (!formData.projectId && selectedCreateProjectId) {
      formData.projectId = String(selectedCreateProjectId);
    }
    if (formData.memberId) {
      const parsedFormMemberId = parseId(formData.memberId);
      if (!parsedFormMemberId || !createMemberIds.has(parsedFormMemberId)) {
        formData.memberId = "";
      }
    }
    const recurrenceMemberIds = parseQueueMemberIds(formData.recurrenceMemberIds)
      .filter((memberId) => createMemberIds.has(memberId));
    formData.recurrenceMemberIds = recurrenceMemberIds.map((memberId) => String(memberId));

    const reportParams = new URLSearchParams();
    if (selectedMemberId) {
      reportParams.set("member_id", String(selectedMemberId));
    }
    if (selectedProjectId) {
      reportParams.set("project_id", String(selectedProjectId));
    }
    const reportQuery = reportParams.toString() ? `?${reportParams.toString()}` : "";
    const plannerCurrentLink = `${urlFor("planner")}${buildPlannerQuery({
      view: effectiveViewMode,
      projectId: selectedProjectId,
      memberId: selectedMemberId,
      month: plannerMonth,
      day: selectedDay,
      returnAnchor: plannerReturnAnchor,
      hideCreate: hidePlannerCreate,
      embedded: plannerEmbedded,
    })}`;

    return render(res, "planner/index.html", {
      title: "Planner",
      activeSection: "planner",
      embeddedLayout: plannerEmbedded,
      plannerViewMode: effectiveViewMode,
      selectedProject,
      selectedMember,
      plannerTasks,
      plannerMonth,
      plannerMonthLabel,
      currentMonthKey,
      todayDateKey: nowIso.slice(0, 10),
      prevMonthKey,
      nextMonthKey,
      calendarWeekdays: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"],
      calendarCells: cells,
      selectedDay,
      selectedDayTasks,
      plannerStatusOptions: [
        { value: "todo", label: "A Fazer" },
        { value: "in_progress", label: "Em Execução" },
        { value: "done", label: "Realizado" },
      ],
      projectOptions: accessibleProjects,
      memberOptions,
      canCreatePlannerTask: creatableProjects.length > 0,
      createProjectOptions: creatableProjects,
      createMemberOptions,
      hidePlannerCreate,
      plannerFormData: formData,
      plannerFormErrors: plannerFormState?.errors || {},
      plannerPanelTheme: effectiveViewMode === "project"
        ? "project"
        : "member",
      plannerPanelColor: selectedProject?.primary_color || "#0f766e",
      plannerMinDateTime: `${getCurrentWeekStartDate()}T00:00`,
      plannerQuery: buildPlannerQuery({
        view: effectiveViewMode,
        projectId: selectedProjectId,
        memberId: selectedMemberId,
        month: plannerMonth,
        day: selectedDay,
        returnAnchor: plannerReturnAnchor,
        hideCreate: hidePlannerCreate,
        embedded: plannerEmbedded,
      }),
      reportMemberLink: `/relatorios${reportQuery}#report-member-selector`,
      reportGoalsLink: `/relatorios${reportQuery}#report-goals-panel`,
      reportCloseLink: `/relatorios${reportQuery}#${plannerReturnAnchor}`,
      plannerReturnAnchor,
      plannerCurrentLink,
    });
  });

  // DETALHE: Rota POST /planner/tasks/create: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/planner/tasks/create", requireAuth, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const currentMember = (await getCurrentMember(req));
    const fallbackQuery = buildPlannerQuery({
      view: req.body.view_mode,
      projectId: parseId(req.body.return_project_id),
      memberId: parseId(req.body.return_member_id) || currentMember?.id || null,
      month: String(req.body.return_month || ""),
      day: String(req.body.return_day || ""),
      returnAnchor: String(req.body.return_anchor || ""),
      hideCreate: String(req.body.return_hide_create || "").trim() === "1",
      embedded: String(req.body.return_embedded || "").trim() === "1",
    });
    const formData = {
      projectId: String(req.body.project_id || ""),
      memberId: String(req.body.member_id || ""),
      title: String(req.body.title || "").trim(),
      description: String(req.body.description || "").trim(),
      dueAt: String(req.body.due_at || "").trim(),
      recurrenceEnabled: String(req.body.recurrence_enabled || "") === "1",
      recurrenceIntervalDays: String(req.body.recurrence_interval_days || "7").trim(),
      recurrenceUnit: normalizePlannerRecurrenceUnit(req.body.recurrence_unit),
      recurrenceMemberIds: parseQueueMemberIds(req.body.recurrence_member_ids).map((id) => String(id)),
    };
    const errors = {};
    const projectId = parseId(formData.projectId);
    const memberId = parseId(formData.memberId);
    const scopeMemberId = parseId(req.body.return_member_id) || null;
    const project = projectId ? (await getRequestProjectById(req, projectId)) : null;

    if (!project) {
      errors.projectId = ["Selecione um projeto válido."];
    }

    const recurrenceIntervalDays = Number(formData.recurrenceIntervalDays);
    const recurrenceEnabled = Boolean(formData.recurrenceEnabled);
    const recurrenceUnit = normalizePlannerRecurrenceUnit(formData.recurrenceUnit);
    let recurrenceQueue = [];

    if (project && recurrenceEnabled) {
      const projectMemberIds = new Set(
        (project.active_members || []).map((member) => Number(member.id)),
      );
      recurrenceQueue = parseQueueMemberIds(formData.recurrenceMemberIds)
        .filter((id) => projectMemberIds.has(id));
      if (!recurrenceQueue.length && memberId && projectMemberIds.has(memberId)) {
        recurrenceQueue = [memberId];
      }
      if (!(await canManageProject(req, project))) {
        const ownMemberId = currentMember?.id || null;
        recurrenceQueue = ownMemberId && recurrenceQueue.includes(ownMemberId)
          ? [ownMemberId]
          : [];
      }
      if (!recurrenceQueue.length) {
        errors.memberId = ["Selecione pelo menos um membro da fila de recorrência."];
      }
      if (!Number.isInteger(recurrenceIntervalDays) || recurrenceIntervalDays < 1 || recurrenceIntervalDays > 60) {
        errors.recurrenceIntervalDays = ["Intervalo de recorrência deve ser entre 1 e 60 dias."];
      }
    } else if (!memberId) {
      errors.memberId = ["Selecione o membro da tarefa."];
    } else if (project && !(await isRequestProjectMember(req, project.id, memberId))) {
      errors.memberId = ["O membro selecionado não pertence ao projeto escolhido."];
    } else if (project && !(await canCreatePlannerTaskForMember(req, project, memberId))) {
      errors.memberId = ["Você só pode criar tarefas para si mesmo, exceto se for coordenador do projeto."];
    } else {
      const ownMemberId = currentMember?.id || null;
      const canCreateForOthers = project && (await canManageProject(req, project));
      if (!canCreateForOthers && scopeMemberId && memberId && scopeMemberId !== memberId) {
        errors.memberId = ["Crie tarefas para outro membro apenas no perfil dele em Relatórios."];
      } else if (!canCreateForOthers && !scopeMemberId && ownMemberId && memberId && ownMemberId !== memberId) {
        errors.memberId = ["Crie tarefas para outro membro apenas no perfil dele em Relatórios."];
      }
    }

    const title = trimToNull(formData.title);
    if (!title) {
      errors.title = ["Título da tarefa é obrigatório."];
    } else if (title.length > 180) {
      errors.title = ["Título da tarefa deve ter no máximo 180 caracteres."];
    }

    const description = trimToNull(formData.description);
    if (!description) {
      errors.description = ["Descrição da tarefa é obrigatória."];
    } else if (description.length < 10 || description.length > 2000) {
      errors.description = ["Descrição da tarefa deve ter entre 10 e 2000 caracteres."];
    }

    const dueAt = toSqlDateTime(formData.dueAt);
    const currentWeekStart = getCurrentWeekStartDate();
    const nowSql = toSqlDateTime(new Date());
    const nowMinuteSql = nowSql ? `${String(nowSql).slice(0, 16)}:00` : null;
    if (!dueAt) {
      errors.dueAt = ["Informe data e horário válidos para a tarefa."];
    } else {
      const dueDateKey = String(dueAt).slice(0, 10);
      if (dueDateKey < currentWeekStart) {
        errors.dueAt = ["Use uma data dentro da quinzena atual."];
      }
    }

    if (Object.keys(errors).length > 0) {
      req.session.plannerFormState = {
        formData,
        errors,
      };
      req.flash("danger", "Não foi possível criar a tarefa do Planner. Revise os campos.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    try {
      const initialStatus = dueAt && nowMinuteSql && dueAt <= nowMinuteSql
        ? "in_progress"
        : "todo";
      const assignedMemberId = recurrenceEnabled && recurrenceQueue.length
        ? recurrenceQueue[0]
        : memberId;
      const recurrenceNextIndex = recurrenceEnabled && recurrenceQueue.length > 1
        ? 1
        : 0;
      const createdTask = (await database.createPlannerTask({
        projectId: project.id,
        assignedMemberId,
        createdByUserId: req.currentUser.id,
        title,
        description: description || "",
        status: initialStatus,
        priority: "medium",
        label: null,
        dueAt,
        recurrenceIntervalDays: recurrenceEnabled ? recurrenceIntervalDays : null,
        recurrenceUnit: recurrenceEnabled ? recurrenceUnit : null,
        recurrenceEvery: recurrenceEnabled ? recurrenceIntervalDays : null,
        recurrenceMemberQueue: recurrenceEnabled ? recurrenceQueue : null,
        recurrenceNextIndex: recurrenceEnabled ? recurrenceNextIndex : null,
      }));
      if (createdTask) {
        (await syncReportWeekGoalFromPlannerTask(createdTask, {
          createdByUserId: req.currentUser.id,
        }));
      }
      req.flash("success", "Tarefa do Planner criada com sucesso.");
      return res.redirect(
        `${urlFor("planner")}${buildPlannerQuery({
          view: "project",
          projectId: project.id,
          memberId: assignedMemberId,
          month: String(req.body.return_month || ""),
          day: String(req.body.return_day || ""),
          returnAnchor: String(req.body.return_anchor || ""),
          hideCreate: String(req.body.return_hide_create || "").trim() === "1",
          embedded: String(req.body.return_embedded || "").trim() === "1",
        })}`,
      );
    } catch (error) {
      logError(req, "Erro ao criar tarefa do Planner:", error);
      req.flash("danger", `Erro ao criar tarefa do Planner: ${error.message}`);
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }
  });

  // DETALHE: Rota POST /planner/tasks/:id/complete: conclui tarefa e gera proxima recorrencia quando aplicavel.

  app.post("/planner/tasks/:id/complete", requireAuth, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const taskId = parseId(req.params.id);
    const fallbackQuery = buildPlannerQuery({
      view: String(req.body.view_mode || ""),
      projectId: parseId(req.body.return_project_id),
      memberId: parseId(req.body.return_member_id),
      month: String(req.body.return_month || ""),
      day: String(req.body.return_day || ""),
      returnAnchor: String(req.body.return_anchor || ""),
      hideCreate: String(req.body.return_hide_create || "").trim() === "1",
      embedded: String(req.body.return_embedded || "").trim() === "1",
    });

    if (!taskId) {
      req.flash("danger", "Tarefa inválida para conclusão.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    const task = (await database.getPlannerTaskById(taskId));
    if (!task) {
      req.flash("danger", "Tarefa do Planner não encontrada.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    if (!(await canCompletePlannerTask(req, task))) {
      req.flash("danger", "Você não tem permissão para concluir esta tarefa.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    if (task.is_completed) {
      req.flash("info", "Esta tarefa já está concluída.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    try {
      const completedAt = toSqlDateTime(new Date());
      const taskIsMissed = task.workflow_state === "missed"
        && database.isReportDueOverdue(task.due_at, completedAt);
      const completedTask = taskIsMissed
        || database.isReportDueOverdue(task.due_at, completedAt)
        ? (await database.markPlannerTaskDoneLate({
          id: task.id,
          actorUserId: req.currentUser.id,
          completedAt,
        }))
        : (await database.updatePlannerTaskCompletion({
          id: task.id,
          isCompleted: true,
          completedAt,
          updatedAt: completedAt,
          actorUserId: req.currentUser.id,
        }));
      if (completedTask) {
        (await syncReportWeekGoalFromPlannerTask(completedTask, {
          createdByUserId: req.currentUser.id,
        }));
      }
      (await database.createPlannerTaskCompletionLog({
        taskId: task.id,
        projectId: task.project_id,
        assignedMemberId: task.assigned_member_id,
        completedByUserId: req.currentUser.id,
        title: task.title,
        description: task.description,
        status: "done",
        priority: task.priority || "medium",
        label: task.label || null,
        dueAt: task.due_at,
        completedAt,
      }));

      const queue = Array.isArray(task.recurrence_member_queue)
        ? task.recurrence_member_queue
        : [];
      const recurrenceEvery = Number(task.recurrence_every || task.recurrence_interval_days || 0);
      const recurrenceUnit = normalizePlannerRecurrenceUnit(task.recurrence_unit || "days");
      if (recurrenceEvery > 0 && queue.length > 0) {
        const currentIndex = Number(task.recurrence_next_index || 0);
        const nextQueueIndex = currentIndex % queue.length;
        const nextAssigneeId = queue[nextQueueIndex];
        const nextDueAtRaw = addIntervalToSqlDateTime(task.due_at, recurrenceEvery, recurrenceUnit)
          || addDaysToSqlDateTime(task.due_at, recurrenceEvery)
          || task.due_at;
        const nowSql = toSqlDateTime(new Date());
        const nowMinuteSql = nowSql ? `${String(nowSql).slice(0, 16)}:00` : null;
        const nextDueAt = nextDueAtRaw && nowMinuteSql && nextDueAtRaw < nowMinuteSql
          ? nowMinuteSql
          : nextDueAtRaw;
        const nextStatus = nextDueAt && nowMinuteSql && nextDueAt <= nowMinuteSql
          ? "in_progress"
          : "todo";
        const upcomingIndex = (nextQueueIndex + 1) % queue.length;

        const nextTask = (await database.createPlannerTask({
          projectId: task.project_id,
          assignedMemberId: nextAssigneeId,
          createdByUserId: req.currentUser.id,
          title: task.title,
          description: task.description,
          status: nextStatus,
          priority: task.priority || "medium",
          label: task.label || null,
          dueAt: nextDueAt,
          recurrenceIntervalDays: recurrenceEvery,
          recurrenceUnit,
          recurrenceEvery,
          recurrenceMemberQueue: queue,
          recurrenceNextIndex: upcomingIndex,
        }));
        if (nextTask) {
          (await syncReportWeekGoalFromPlannerTask(nextTask, {
            createdByUserId: req.currentUser.id,
          }));
        }
      }

      req.flash("success", "Tarefa concluída com sucesso.");
    } catch (error) {
      logError(req, "Erro ao concluir tarefa do Planner:", error);
      req.flash("danger", `Erro ao concluir tarefa do Planner: ${error.message}`);
    }

    return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
  });

  // DETALHE: Rota POST /planner/tasks/:id/status: altera bucket (A Fazer/Em Execução/Realizado).
  app.post("/planner/tasks/:id/status", requireAuth, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const taskId = parseId(req.params.id);
    const fallbackQuery = buildPlannerQuery({
      view: String(req.body.view_mode || ""),
      projectId: parseId(req.body.return_project_id),
      memberId: parseId(req.body.return_member_id),
      month: String(req.body.return_month || ""),
      day: String(req.body.return_day || ""),
      returnAnchor: String(req.body.return_anchor || ""),
      hideCreate: String(req.body.return_hide_create || "").trim() === "1",
      embedded: String(req.body.return_embedded || "").trim() === "1",
    });
    const nextStatus = normalizePlannerStatus(req.body.status);

    if (!taskId) {
      req.flash("danger", "Tarefa inválida para atualizar status.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    const task = (await database.getPlannerTaskById(taskId));
    if (!task) {
      req.flash("danger", "Tarefa do Planner não encontrada.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }
    if (!(await canManageProject(req, task.project)) && Number(task.assigned_member_id) !== Number((await getCurrentMember(req))?.id)) {
      req.flash("danger", "Você não tem permissão para mover esta tarefa.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    try {
      const updatedAt = toSqlDateTime(new Date());
      const taskIsMissed = task.workflow_state === "missed"
        && database.isReportDueOverdue(task.due_at, updatedAt);
      if (taskIsMissed && nextStatus !== "done") {
        req.flash("warning", "Tarefa atrasada: apenas conclusão com atraso ou extensão de prazo.");
        return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
      }
      const wasCompleted = Boolean(task.is_completed);
      const updatedTask = (
        nextStatus === "done"
        && (
          taskIsMissed
          || database.isReportDueOverdue(task.due_at, updatedAt)
        )
      )
        ? (await database.markPlannerTaskDoneLate({
          id: task.id,
          actorUserId: req.currentUser.id,
          completedAt: updatedAt,
        }))
        : (await database.updatePlannerTaskStatus({
          id: task.id,
          status: nextStatus,
          updatedAt,
          actorUserId: req.currentUser.id,
        }));
      if (updatedTask) {
        (await syncReportWeekGoalFromPlannerTask(updatedTask, {
          createdByUserId: req.currentUser.id,
        }));
      }
      if (updatedTask?.is_completed && !wasCompleted) {
        (await database.createPlannerTaskCompletionLog({
          taskId: updatedTask.id,
          projectId: updatedTask.project_id,
          assignedMemberId: updatedTask.assigned_member_id,
          completedByUserId: req.currentUser.id,
          title: updatedTask.title,
          description: updatedTask.description,
          status: updatedTask.status,
          priority: updatedTask.priority || "medium",
          label: updatedTask.label || null,
          dueAt: updatedTask.due_at,
          completedAt: updatedTask.completed_at || updatedAt,
        }));
      }
      req.flash("success", "Status da tarefa atualizado.");
    } catch (error) {
      logError(req, "Erro ao atualizar status da tarefa do Planner:", error);
      req.flash("danger", `Erro ao atualizar status da tarefa: ${error.message}`);
    }

    return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
  });

  // DETALHE: Rota POST /planner/tasks/:id/delete: remove tarefa quando usuario tem permissao no projeto.

  app.post("/planner/tasks/:id/delete", requireAuth, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const taskId = parseId(req.params.id);
    const fallbackQuery = buildPlannerQuery({
      view: String(req.body.view_mode || ""),
      projectId: parseId(req.body.return_project_id),
      memberId: parseId(req.body.return_member_id),
      month: String(req.body.return_month || ""),
      day: String(req.body.return_day || ""),
      returnAnchor: String(req.body.return_anchor || ""),
      hideCreate: String(req.body.return_hide_create || "").trim() === "1",
      embedded: String(req.body.return_embedded || "").trim() === "1",
    });

    if (!taskId) {
      req.flash("danger", "Tarefa inválida para exclusão.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    const task = (await database.getPlannerTaskById(taskId));
    if (!task) {
      req.flash("danger", "Tarefa do Planner não encontrada.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    if (!(await canDeletePlannerTask(req, task))) {
      req.flash("danger", "Você não tem permissão para excluir esta tarefa.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    try {
      const linkedGoal = (await database.getReportWeekGoalByPlannerTaskId(task.id));
      if (linkedGoal) {
        if (linkedGoal.is_completed) {
          (await database.deleteReportWeekGoalWithAudit(linkedGoal.id, req.currentUser.id));
        } else {
          (await database.deleteReportWeekGoal(linkedGoal.id));
        }
      }
      (await database.deletePlannerTask(task.id, {
        actorUserId: req.currentUser.id,
        reportGoalId: linkedGoal?.id || null,
      }));
      if (linkedGoal) {
        req.flash("success", "Tarefa do Planner e meta vinculada no relatório foram removidas.");
      } else {
        req.flash("success", "Tarefa do Planner excluída com sucesso.");
      }
    } catch (error) {
      logError(req, "Erro ao excluir tarefa do Planner:", error);
      req.flash("danger", `Erro ao excluir tarefa do Planner: ${error.message}`);
    }

    return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
  });



}

module.exports = { registerAuthRoutes };

