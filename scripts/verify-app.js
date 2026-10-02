const asyncArray = require("../src/asyncArray");
/*
 * ARQUIVO: scripts/verify-app.js
 * FUNCAO: script de verificacao automatizada para validar fluxos principais do sistema em banco Postgres configurado.
 * IMPACTO DE MUDANCAS:
 * - Alterar assercoes pode ocultar regressao real ou gerar falso positivo no processo de validacao.
 * - O script usa DATABASE_URL do ambiente; execute em uma base de teste dedicada.
 */
const assert = require("node:assert/strict");
const { promisify } = require("node:util");

require("../src/config");

const bcrypt = require("bcryptjs");

const { urlFor } = require("../src/utils");

async function cleanupVerifyArtifacts(database, artifacts) {
  if (!database || !artifacts) {
    return;
  }

  try {
    if (artifacts.createdAtaId) {
      (await database.deleteAta(artifacts.createdAtaId));
    }
  } catch (error) {
    console.error("Falha ao limpar ata de verificacao:", error.message);
  }

  const db = database.getDb();
  const createdItemIds = Array.isArray(artifacts.createdInventoryItemIds)
    ? artifacts.createdInventoryItemIds.filter((id) => Number.isFinite(Number(id)))
    : [];

  (await asyncArray.forEach(createdItemIds, async (itemId) => {
    try {
      (await db.prepare("DELETE FROM inventory_loan WHERE item_id = ?").run(itemId));
      (await db.prepare("DELETE FROM pedido WHERE estoque_id = ?").run(itemId));
      (await db.prepare("DELETE FROM estoque WHERE id = ?").run(itemId));
    } catch (error) {
      console.error(`Falha ao limpar item de verificacao ${itemId}:`, error.message);
    }
  }));

  if (artifacts.createdCategoryId) {
    try {
      (await db.prepare("DELETE FROM inventory_category WHERE id = ?").run(artifacts.createdCategoryId));
    } catch (error) {
      console.error("Falha ao limpar categoria de verificacao:", error.message);
    }
  }

  if (artifacts.createdLocationId) {
    try {
      (await db.prepare("DELETE FROM inventory_location WHERE id = ?").run(artifacts.createdLocationId));
    } catch (error) {
      console.error("Falha ao limpar local de verificacao:", error.message);
    }
  }

  const usernames = Array.isArray(artifacts.verifyUsernames) ? artifacts.verifyUsernames : [];
  (await asyncArray.forEach(usernames, async (username) => {
    const user = (await database.getUserByUsername(username));
    if (!user?.id) {
      return;
    }

    const userId = user.id;
    try {
      (await db.prepare("DELETE FROM notification_email_delivery WHERE recipient_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM chat_message WHERE author_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM chat_conversation_participant WHERE user_id = ?").run(userId));
      (await db.prepare("DELETE FROM chat_conversation WHERE created_by_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM writing_general_entry WHERE author_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM writing_tutor_private_entry WHERE tutor_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM report_fortnight_member_note WHERE author_user_id = ? OR target_tutor_user_id = ?").run(userId, userId));
      (await db.prepare("DELETE FROM report_fortnight_tutor_note WHERE tutor_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM report_week_goal_deletion_log WHERE deleted_by_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM planner_task_completion_log WHERE completed_by_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM planner_task WHERE created_by_user_id = ? OR last_extended_by_user_id = ?").run(userId, userId));
      (await db.prepare("DELETE FROM report_week_goal WHERE created_by_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM report_entry WHERE created_by_user_id = ?").run(userId));
      (await db.prepare("DELETE FROM inventory_loan WHERE user_id = ? OR extended_by_user_id = ? OR returned_by_user_id = ?").run(userId, userId, userId));
      (await db.prepare("DELETE FROM pedido WHERE usuario_id = ?").run(userId));
      (await db.prepare('DELETE FROM "user" WHERE id = ?').run(userId));
    } catch (error) {
      console.error(`Falha ao limpar usuario de verificacao @${username}:`, error.message);
    }
  }));
}

// SECAO: rotina de verificacao ponta a ponta usando a base Postgres configurada.

async function main() {
  if (!/^verify_async_[a-f0-9]{16}$/.test(process.env.PORTAL_TEST_SCHEMA || "")) {
    throw new Error("Execute npm run verify para usar um schema isolado.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Defina DATABASE_URL para executar a verificação no Postgres.");
  }

  const database = require("../src/database");
  const { createApp } = require("../src/app");
  const { generateAtaPdf } = require("../src/pdf");
  const artifacts = {
    verifyUsernames: ["codex_verify_admin", "codex_verify_common", "codex_verify_tutor"],
    createdAtaId: null,
    createdInventoryItemIds: [],
    createdCategoryId: null,
    createdLocationId: null,
  };

  const schema = await require("../src/postgres").query("SELECT current_schema() AS name");
  assert.equal(schema.rows[0].name, process.env.PORTAL_TEST_SCHEMA);
  (await database.ensureSchema());
  try {

    const adminUsername = "codex_verify_admin";
    const adminPassword = "codex123";
    let adminUser = (await database.getUserByUsername(adminUsername));
    if (!adminUser) {
      adminUser = (await database.createUser(
        adminUsername,
        bcrypt.hashSync(adminPassword, 12),
        {
          name: "Codex Verify Admin",
          role: "admin",
        },
      ));
    }

    const commonUsername = "codex_verify_common";
    let commonUser = (await database.getUserByUsername(commonUsername));
    if (!commonUser) {
      commonUser = (await database.createUser(
        commonUsername,
        bcrypt.hashSync("codex456", 12),
        {
          name: "Codex Verify Common",
          role: "common",
        },
      ));
    }
    const tutorUsername = "codex_verify_tutor";
    let tutorUser = (await database.getUserByUsername(tutorUsername));
    if (!tutorUser) {
      tutorUser = (await database.createUser(
        tutorUsername,
        bcrypt.hashSync("codex789", 12),
        {
          name: "Codex Verify Tutor",
          role: "tutor",
        },
      ));
    }

    const app = (await createApp());
    const render = promisify(app.render.bind(app));

    const routeEntries = app._router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path],
      );

    [
      "/",
      "/login",
      "/logout",
      "/services",
      "/home",
      "/members",
      "/projects",
      "/atas/create",
      "/atas/download/:id",
      "/almoxarifado",
      "/almoxarifado/inventory/create",
      "/almoxarifado/inventory/edit/:id",
      "/almoxarifado/inventory/delete/:id",
      "/almoxarifado/inventory/withdraw",
      "/almoxarifado/inventory/borrow",
      "/almoxarifado/loans/return/:id",
      "/almoxarifado/loans/extend/:id",
      "/almoxarifado/categories/create",
      "/almoxarifado/categories/delete/:id",
      "/almoxarifado/locations/create",
      "/almoxarifado/locations/delete/:id",
      "/almoxarifado/api/itens",
      "/almoxarifado/api/itens/:id",
      "/almoxarifado/api/categorias",
      "/almoxarifado/api/categorias/:id",
      "/almoxarifado/api/locais",
      "/almoxarifado/api/locais/:id",
      "/manutencao-usuarios",
      "/manutencao-usuarios/users/create",
      "/manutencao-usuarios/users/delete/:id",
      "/manutencao-usuarios/users/link/:id",
      "/manutencao-usuarios/users/reset-password/:id",
      "/api/project/:project_id/members",
      "/espacos-escrita",
      "/espacos-escrita/geral/create",
      "/espacos-escrita/geral/edit/:id",
      "/espacos-escrita/geral/delete/:id",
      "/espacos-escrita/tutor/create",
      "/espacos-escrita/tutor/edit/:id",
      "/espacos-escrita/tutor/delete/:id",
      "/mensagens",
      "/mensagens/conversas/:id",
      "/mensagens/conversas/create",
      "/mensagens/conversas/:id/mensagens/create",
    ].forEach((routePath) => {
      assert.ok(routeEntries.includes(routePath), `Rota ausente: ${routePath}`);
    });

    assert.equal(adminUser.role, "admin");
    assert.equal(adminUser.is_admin, true);
    assert.equal(commonUser.role, "common");
    assert.equal(commonUser.is_admin, false);
    assert.equal(tutorUser.role, "tutor");
    assert.equal(tutorUser.is_admin, true);

    const csrfToken = "csrf-token-teste";
    const projects = (await database.listProjectsBasic());
    assert.ok(projects.length > 0, "Nenhum projeto encontrado no banco de teste.");
    const project = (await database.getProjectById(projects[0].id));
    assert.ok(project, "Projeto de teste não encontrado.");
    assert.ok(
      project.active_members.length > 0,
      "Projeto de teste não possui membros ativos.",
    );

    const recentAtasBefore = (await database.listRecentAtas(5));
    assert.ok(recentAtasBefore.length > 0, "Nenhuma ata encontrada para teste.");

    await render("login.html", {
      title: "Entrar",
      csrfToken,
      flashMessages: [],
      formData: { username: adminUsername, next: "/services" },
      errors: {},
    });

    await render("services.html", {
      title: "Serviços",
      activeSection: "services",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
    });

    await render("home.html", {
      title: "Atas",
      activeSection: "home",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      recentAtas: recentAtasBefore,
    });

    await render("members/list.html", {
      title: "Membros Ativos",
      activeSection: "members",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      members: (await database.listActiveMembers()),
    });

    await render("projects/list.html", {
      title: "Projetos",
      activeSection: "projects",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      projects: (await database.listProjectsWithMembers()),
    });

    await render("atas/create_form.html", {
      title: "Criar Nova Ata",
      activeSection: "atas",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      formData: {
        projectId: project.id,
        meetingDatetime: "2026-03-29T14:30",
        notes: "Reunião de verificação automatizada da migração para Node.js.",
        presentMemberIds: [project.active_members[0].id],
        justifications: project.active_members[1]
          ? { [project.active_members[1].id]: "Compromisso acadêmico." }
          : {},
      },
      errors: {},
      projects,
      selectedProject: project,
      selectedProjectMembers: project.active_members,
    });

    const categoryName = `Categoria Verificacao ${Date.now()}`;
    const locationName = `Local Verificacao ${Date.now()}`;
    const category = (await database.createInventoryCategory(categoryName));
    const location = (await database.createInventoryLocation(locationName));
    artifacts.createdCategoryId = category?.id || null;
    artifacts.createdLocationId = location?.id || null;
    assert.ok(category?.id, "Falha ao criar categoria de patrimônio.");
    assert.ok(location?.id, "Falha ao criar local de patrimônio.");

    const inventoryName = `Estoque Verificacao ${Date.now()}`;
    const createdItem = (await database.createInventoryItem({
      name: inventoryName,
      itemType: "stock",
      categoryId: category.id,
      locationId: location.id,
      quantity: 7,
      description: "Produto criado durante a verificação automatizada.",
    }));
    assert.ok(createdItem?.id, "Falha ao criar item de estoque para teste.");
    artifacts.createdInventoryItemIds.push(createdItem?.id || null);
    assert.equal(createdItem.item_type, "stock");
    assert.equal(createdItem.category, category.name);
    assert.equal(createdItem.location, location.name);

    const withdrawal = (await database.withdrawInventoryItem({
      nameOrCode: String(createdItem.id),
      quantity: 2,
      userId: adminUser.id,
    }));
    assert.equal(withdrawal.success, true, "Falha ao registrar retirada de estoque.");

    const patrimonyName = `Patrimonio Verificacao ${Date.now()}`;
    const patrimonyItem = (await database.createInventoryItem({
      name: patrimonyName,
      itemType: "patrimony",
      categoryId: category.id,
      locationId: location.id,
      quantity: 3,
      description: "Patrimônio criado para teste automatizado de empréstimo.",
    }));
    assert.ok(patrimonyItem?.id, "Falha ao criar item patrimonial para teste.");
    artifacts.createdInventoryItemIds.push(patrimonyItem?.id || null);
    assert.equal(patrimonyItem.item_type, "patrimony");

    const invalidStockBorrow = (await database.borrowInventoryItem({
      nameOrCode: String(createdItem.id),
      quantity: 1,
      userId: adminUser.id,
    }));
    assert.equal(
      invalidStockBorrow.success,
      false,
      "Material de estoque não deveria entrar em empréstimo.",
    );

    const invalidPatrimonyWithdraw = (await database.withdrawInventoryItem({
      nameOrCode: String(patrimonyItem.id),
      quantity: 1,
      userId: adminUser.id,
    }));
    assert.equal(
      invalidPatrimonyWithdraw.success,
      false,
      "Patrimônio não deveria sair pela rota de retirada.",
    );

    const loan = (await database.borrowInventoryItem({
      nameOrCode: String(patrimonyItem.id),
      quantity: 1,
      userId: adminUser.id,
    }));
    assert.equal(loan.success, true, "Falha ao registrar empréstimo patrimonial.");
    assert.equal(loan.loan.status, "active");

    const extension = (await database.extendInventoryLoan({
      loanId: loan.loan.id,
      extraDays: 5,
      actorUserId: adminUser.id,
    }));
    assert.equal(extension.success, true, "Falha ao prorrogar empréstimo.");

    const activeLoans = (await database.listInventoryLoans({ status: "active" }));
    assert.ok(
      activeLoans.some(
        (entry) =>
          entry.id === loan.loan.id &&
          entry.user_id === adminUser.id &&
          entry.item_name === patrimonyName,
      ),
      "Lista de materiais emprestados não registrou o patrimônio de teste.",
    );

    const returnLoan = (await database.returnInventoryLoan({
      loanId: loan.loan.id,
      actoruserId: adminUser.id,
    }));
    assert.equal(returnLoan.success, true, "Falha ao registrar devolução.");

    const dashboard = (await database.getInventoryDashboardData());
    assert.ok(
      dashboard.summary.item_count >= 1,
      "Resumo do almoxarifado não contabilizou itens.",
    );
    assert.ok(
      dashboard.summary.category_count >= 1,
      "Resumo do almoxarifado não contabilizou categorias.",
    );
    assert.ok(
      dashboard.summary.location_count >= 1,
      "Resumo do almoxarifado não contabilizou locais.",
    );
    assert.ok(
      dashboard.summary.request_count >= 1,
      "Resumo do almoxarifado não contabilizou retiradas.",
    );
    assert.ok(
      dashboard.summary.patrimony_item_count >= 1,
      "Resumo do almoxarifado não contabilizou patrimônio.",
    );

    const requests = (await database.listInventoryRequests());
    assert.ok(
      requests.some(
        (request) =>
          request.usuario_id === adminUser.id &&
          request.nome_item_estoque === inventoryName,
      ),
      "Histórico de retiradas não registrou a movimentação de teste.",
    );

    const returnedLoans = (await database.listInventoryLoans({ status: "returned" }));
    assert.ok(
      returnedLoans.some(
        (entry) =>
          entry.id === loan.loan.id &&
          entry.returned_at &&
          entry.item_name === patrimonyName,
      ),
      "Histórico de devoluções não registrou o empréstimo de teste.",
    );

    await render("almoxarifado/index.html", {
      title: "Almoxarifado",
      activeSection: "almox",
      activeTab: "overview",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      dashboard,
      users: (await database.listUsers()),
      inventoryItems: (await database.listInventoryItems()),
      stockItems: (await database.listInventoryItems({ type: "stock" })),
      patrimonyItems: (await database.listInventoryItems({ type: "patrimony" })),
      categories: (await database.listInventoryCategories()),
      locations: (await database.listInventoryLocations()),
      requests,
      activeLoans: (await database.listInventoryLoans({ status: "active" })),
      returnedLoans,
      overdueLoans: (await database.listInventoryLoans({ status: "overdue" })),
      userFormData: { name: "", username: "", password: "", role: "common" },
      userErrors: {},
      itemFormData: {
        name: "",
        itemType: "stock",
        categoryId: "",
        categoryName: "",
        locationId: "",
        locationName: "",
        quantity: "",
        description: "",
      },
      itemErrors: {},
      categoryFormData: { name: "" },
      categoryErrors: {},
      locationFormData: { name: "" },
      locationErrors: {},
      withdrawFormData: { nameOrCode: "", quantity: "" },
      withdrawErrors: {},
      loanFormData: { nameOrCode: "", quantity: "1" },
      loanErrors: {},
      loanExtendDefaults: { extraDays: "7" },
    });

    await render("almoxarifado/index.html", {
      title: "Almoxarifado",
      activeSection: "almox",
      activeTab: "withdraw",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      dashboard,
      users: (await database.listUsers()),
      inventoryItems: (await database.listInventoryItems()),
      stockItems: (await database.listInventoryItems({ type: "stock" })),
      patrimonyItems: (await database.listInventoryItems({ type: "patrimony" })),
      categories: (await database.listInventoryCategories()),
      locations: (await database.listInventoryLocations()),
      requests,
      activeLoans: (await database.listInventoryLoans({ status: "active" })),
      returnedLoans,
      overdueLoans: (await database.listInventoryLoans({ status: "overdue" })),
      userFormData: { name: "", username: "", password: "", role: "common" },
      userErrors: {},
      itemFormData: {
        name: "",
        itemType: "stock",
        categoryId: "",
        categoryName: "",
        locationId: "",
        locationName: "",
        quantity: "",
        description: "",
      },
      itemErrors: {},
      categoryFormData: { name: "" },
      categoryErrors: {},
      locationFormData: { name: "" },
      locationErrors: {},
      withdrawFormData: { nameOrCode: createdItem.name, quantity: "1" },
      withdrawErrors: {},
      loanFormData: { nameOrCode: patrimonyItem.name, quantity: "1" },
      loanErrors: {},
      loanExtendDefaults: { extraDays: "7" },
    });

    await render("errors/404.html", {
      title: "Página Não Encontrada",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      activeSection: "",
    });

    await render("errors/500.html", {
      title: "Erro Interno",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      activeSection: "",
    });

    const createdAta = (await database.createAta({
      projectId: project.id,
      meetingDateTime: "2026-03-29 14:30:00",
      notes: "Reunião de verificação automatizada da migração para Node.js.",
      presentMemberIds: [project.active_members[0].id],
      justifications: project.active_members[1]
        ? { [project.active_members[1].id]: "Compromisso acadêmico." }
        : {},
    }));

    assert.ok(createdAta?.id, "Falha ao criar ata na base de teste.");
    artifacts.createdAtaId = createdAta?.id || null;

    const loadedAta = (await database.getAtaById(createdAta.id));
    assert.ok(loadedAta, "Falha ao recarregar a ata criada.");
    assert.equal(loadedAta.project.id, project.id);
    assert.ok(Array.isArray(loadedAta.present_members));
    assert.ok(Array.isArray(loadedAta.absent_members));

    const pdf = await generateAtaPdf(loadedAta);
    assert.ok(Buffer.isBuffer(pdf), "PDF não foi gerado em formato Buffer.");
    assert.ok(pdf.length > 1000, "PDF gerado parece inválido.");

    assert.equal(urlFor("services"), "/services");
    assert.equal(urlFor("home"), "/home");
    assert.equal(urlFor("almox_home"), "/almoxarifado");
    assert.equal(urlFor("create_ata", { project_id: project.id }), `/atas/create/for/${project.id}`);

    console.log("Verificação concluída com sucesso.");
  } finally {
    (await cleanupVerifyArtifacts(database, artifacts));
  }
}

main().catch((error) => {
  console.error("Falha na verificação da aplicação:", error);
  process.exitCode = 1;
}).finally(() => require("../src/postgres").closePool());
