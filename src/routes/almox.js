/*
 * ARQUIVO: src/routes/almox.js
 * FUNCAO: registra rotas web e API interna do almoxarifado.
 * IMPACTO DE MUDANCAS:
 * - Alterar validacoes de estoque pode gerar inconsistencias de quantidade.
 * - Alterar respostas JSON impacta scripts/frontend que dependem dessas APIs.
 */
function registerAlmoxRoutes(ctx) {
  const {
    app,
    bcrypt,
    requireAuth,
    requireAdminPage,
    requireAdminApi,
    ensureValidCsrf,
    ensureValidApiCsrf,
    parseId,
    database,
    renderAlmox,
    renderUserMaintenance,
    almoxPath,
    urlFor,
    parseInventoryPayload,
    validateInventoryPayload,
    validateCatalogName,
    isUniqueConstraintError,
    canManageProject,
    canCreateAtaForProject,
    logError,
    sendApiError,
    mapInventoryApiItem,
  } = ctx;
  const databaseAsync = require("../databaseAsync");

  function userMaintenancePath(anchor = "user-access-list") {
    const suffix = anchor ? `#${anchor}` : "";
    return `${urlFor("user_maintenance")}${suffix}`;
  }

  function isValidEmail(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) {
      return false;
    }
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  }

app.get("/almoxarifado", requireAuth, async (req, res) => {
    return (await renderAlmox(res, {
      activeTab: req.query.tab,
    }));
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/manutencao-usuarios/users/create",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userFormData = {
        name: String(req.body.name || "").trim(),
        username: String(req.body.username || "").trim(),
        email: String(req.body.email || "").trim().toLowerCase(),
        password: "",
        role: String(req.body.role || "common").trim().toLowerCase(),
        memberId: String(req.body.member_id || "").trim(),
      };
      const rawPassword = String(req.body.password || "");
      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

      const userErrors = {};

      if (!userFormData.name) {
        userErrors.name = ["O nome completo é obrigatório."];
      } else if (userFormData.name.length < 3 || userFormData.name.length > 120) {
        userErrors.name = ["O nome deve ter entre 3 e 120 caracteres."];
      }

      if (!userFormData.username) {
        userErrors.username = ["O nome de usuário é obrigatório."];
      } else if (!/^[a-zA-Z0-9._-]{3,40}$/.test(userFormData.username)) {
        userErrors.username = [
          "Use de 3 a 40 caracteres com letras, números, ponto, traço ou sublinhado.",
        ];
      }

      if (!rawPassword) {
        userErrors.password = ["A senha é obrigatória."];
      } else if (rawPassword.length < 6) {
        userErrors.password = ["A senha deve ter pelo menos 6 caracteres."];
      }

      if (userFormData.email && !isValidEmail(userFormData.email)) {
        userErrors.email = ["Informe um e-mail válido."];
      }

      if (!["admin", "tutor", "common"].includes(userFormData.role)) {
        userFormData.role = "common";
      }

      const memberId = parseId(userFormData.memberId);
      if (userFormData.memberId && !memberId) {
        userErrors.memberId = ["Selecione um membro válido."];
      } else if (memberId) {
        const member = (await database.getMemberById(memberId));
        if (!member || !member.is_active) {
          userErrors.memberId = ["Selecione um membro ativo válido."];
        }
      }

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(userErrors).length > 0) {
        return (await renderUserMaintenance(res, {
          userFormData,
          userErrors,
        }));
      }

      try {
        const passwordHash = await bcrypt.hash(rawPassword, 12);
        const createdUser = (await database.createUser(userFormData.username, passwordHash, {
          name: userFormData.name,
          email: userFormData.email || null,
          role: userFormData.role,
          memberId: memberId || null,
        }));

        req.flash(
          "success",
          `Usuário "${createdUser.username}" criado com sucesso como ${
            createdUser.role === "common"
              ? "comum"
              : createdUser.role === "tutor"
                ? "tutor"
                : "administrador"
          }.`,
        );
        return res.redirect(userMaintenancePath());
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          if (String(error.constraint || "").toLowerCase().includes("email")) {
            userErrors.email = ["Já existe um usuário com este e-mail."];
          } else {
            userErrors.username = ["Já existe um usuário com esse nome de acesso."];
          }
        } else {
          logError(req, "Erro ao criar usuário:", error);
          req.flash("danger", `Erro ao criar usuário: ${error.message}`);
        }

        return (await renderUserMaintenance(res, {
          userFormData,
          userErrors,
        }));
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/manutencao-usuarios/users/link/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para vinculação.");
        return res.redirect(userMaintenancePath());
      }

      const user = (await database.getUserById(userId));
      if (!user) {
        req.flash("warning", "Usuário não encontrado.");
        return res.redirect(userMaintenancePath());
      }

      const memberIdRaw = String(req.body.member_id || "").trim();
      const memberId = parseId(memberIdRaw);
      if (memberIdRaw && !memberId) {
        req.flash("warning", "Selecione um membro válido.");
        return res.redirect(userMaintenancePath());
      }

      if (memberId) {
        const member = (await database.getMemberById(memberId));
        if (!member || !member.is_active) {
          req.flash("warning", "Selecione um membro ativo válido.");
          return res.redirect(userMaintenancePath());
        }
      }

      try {
        const updatedUser = (await database.setUserMemberLink(userId, memberId || null));
        if (updatedUser?.member_name) {
          req.flash(
            "success",
            `Usuário @${updatedUser.username} vinculado ao membro ${updatedUser.member_name}.`,
          );
        } else {
          req.flash(
            "success",
            `Vínculo de membro removido do usuário @${user.username}.`,
          );
        }
      } catch (error) {
        logError(req, "Erro ao vincular usuário ao membro:", error);
        req.flash("danger", `Erro ao vincular usuário: ${error.message}`);
      }

      return res.redirect(userMaintenancePath());
    },
  );

  app.post(
    "/manutencao-usuarios/users/reset-password/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para redefinição de senha.");
        return res.redirect(userMaintenancePath());
      }

      const user = (await database.getUserById(userId));
      if (!user) {
        req.flash("warning", "Usuário não encontrado.");
        return res.redirect(userMaintenancePath());
      }

      const rawPassword = String(req.body.new_password || "");
      if (!rawPassword || rawPassword.length < 6) {
        req.flash("warning", "A nova senha deve ter pelo menos 6 caracteres.");
        return res.redirect(userMaintenancePath());
      }

      try {
        const passwordHash = await bcrypt.hash(rawPassword, 12);
        (await database.updateUserPassword(userId, passwordHash));
        req.flash("success", `Senha de @${user.username} redefinida com sucesso.`);
      } catch (error) {
        logError(req, "Erro ao redefinir senha de usuário:", error);
        req.flash("danger", `Erro ao redefinir senha: ${error.message}`);
      }

      return res.redirect(userMaintenancePath());
    },
  );

  app.post(
    "/manutencao-usuarios/users/email/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para atualização de e-mail.");
        return res.redirect(userMaintenancePath());
      }

      const user = (await database.getUserById(userId));
      if (!user) {
        req.flash("warning", "Usuário não encontrado.");
        return res.redirect(userMaintenancePath());
      }

      const email = String(req.body.email || "").trim().toLowerCase();
      if (email && !isValidEmail(email)) {
        req.flash("warning", "Informe um e-mail válido.");
        return res.redirect(userMaintenancePath());
      }

      try {
        const updated = (await database.updateUserEmail(userId, email || null));
        if (!updated) {
          req.flash("warning", "Usuário não encontrado.");
          return res.redirect(userMaintenancePath());
        }
        if (updated.email) {
          req.flash("success", `E-mail de @${updated.username} atualizado com sucesso.`);
        } else {
          req.flash("success", `E-mail de @${updated.username} removido.`);
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          req.flash("warning", "Este e-mail já está em uso por outro usuário.");
        } else {
          logError(req, "Erro ao atualizar e-mail do usuário:", error);
          req.flash("danger", `Erro ao atualizar e-mail: ${error.message}`);
        }
      }

      return res.redirect(userMaintenancePath());
    },
  );

  app.post(
    "/manutencao-usuarios/users/delete/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para exclusão.");
        return res.redirect(userMaintenancePath());
      }

      if (req.currentUser?.id === userId) {
        req.flash("warning", "Você não pode excluir seu próprio usuário.");
        return res.redirect(userMaintenancePath());
      }

      try {
        const result = (await database.deleteUser(userId));
        if (!result?.deleted) {
          if (result?.reason === "not_found") {
            req.flash("warning", "Usuário não encontrado.");
          } else if (result?.reason === "has_history") {
            req.flash(
              "warning",
              "Não é possível excluir usuário com histórico de retiradas ou empréstimos.",
            );
          } else {
            req.flash("warning", "Não foi possível excluir o usuário.");
          }
          return res.redirect(userMaintenancePath());
        }

        req.flash("success", `Usuário @${result.user.username} desativado com sucesso.`);
      } catch (error) {
        logError(req, "Erro ao excluir usuário:", error);
        req.flash("danger", `Erro ao excluir usuário: ${error.message}`);
      }

      return res.redirect(userMaintenancePath());
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/inventory/create",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const parsed = parseInventoryPayload(req.body);
      const itemFormData = {
        name: parsed.name,
        itemType: parsed.itemType,
        categoryId: parsed.categoryId || "",
        categoryName: parsed.category || "",
        locationId: parsed.locationId || "",
        locationName: parsed.location || "",
        quantity: parsed.quantity,
        description: parsed.description,
      };
      const { errors: itemErrors, normalized } = validateInventoryPayload(parsed);

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(itemErrors).length > 0) {
        return (await renderAlmox(res, {
          activeTab,
          itemFormData,
          itemErrors,
        }));
      }

      try {
        const createdItem = (await database.createInventoryItem({
          name: normalized.name,
          itemType: normalized.itemType,
          category: normalized.category,
          categoryId: normalized.categoryId,
          location: normalized.location,
          locationId: normalized.locationId,
          quantity: normalized.quantity,
          description: normalized.description,
        }));

        req.flash(
          "success",
          `Material "${createdItem.name}" (${createdItem.item_type === "patrimony" ? "patrimônio" : "estoque"}) adicionado com sucesso.`,
        );
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        logError(req, "Erro ao adicionar item ao estoque:", error);
        req.flash("danger", `Erro ao adicionar item: ${error.message}`);
        return (await renderAlmox(res, {
          activeTab,
          itemFormData,
          itemErrors,
        }));
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/categories/create",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const { normalized, errors } = validateCatalogName(
        req.body.name,
        "nome da categoria",
      );

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return (await renderAlmox(res, {
          activeTab,
          categoryFormData: { name: normalized },
          categoryErrors: errors,
        }));
      }

      try {
        const category = (await database.createInventoryCategory(normalized));
        req.flash("success", `Categoria "${category.name}" criada com sucesso.`);
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          errors.name = ["Já existe uma categoria com esse nome."];
        } else {
          logError(req, "Erro ao criar categoria:", error);
          req.flash("danger", `Erro ao criar categoria: ${error.message}`);
        }

        return (await renderAlmox(res, {
          activeTab,
          categoryFormData: { name: normalized },
          categoryErrors: errors,
        }));
      }
    },
  );

  app.post(
    "/almoxarifado/inventory/edit/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const itemId = parseId(req.params.id);
      if (!itemId) {
        req.flash("warning", "Material inválido para edição.");
        return res.redirect(almoxPath(activeTab));
      }

      const existingItem = (await database.getInventoryItemById(itemId));
      if (!existingItem) {
        req.flash("warning", "Material não encontrado.");
        return res.redirect(almoxPath(activeTab));
      }

      const parsed = parseInventoryPayload(req.body);
      const inventoryEditFormData = {
        name: parsed.name,
        itemType: parsed.itemType,
        categoryId: parsed.categoryId || "",
        categoryName: parsed.category || "",
        locationId: parsed.locationId || "",
        locationName: parsed.location || "",
        quantity: parsed.quantity,
        description: parsed.description,
      };
      const { errors: inventoryEditErrors, normalized } = validateInventoryPayload(parsed);

      if (Object.keys(inventoryEditErrors).length > 0) {
        return (await renderAlmox(res, {
          activeTab,
          inventoryEditOpenId: itemId,
          inventoryEditFormData,
          inventoryEditErrors,
        }));
      }

      try {
        const updatedItem = (await database.updateInventoryItem(itemId, {
          name: normalized.name,
          itemType: normalized.itemType,
          category: normalized.category,
          categoryId: normalized.categoryId,
          location: normalized.location,
          locationId: normalized.locationId,
          quantity: normalized.quantity,
          description: normalized.description,
        }));

        if (!updatedItem) {
          req.flash("warning", "Material não encontrado.");
          return res.redirect(almoxPath(activeTab));
        }

        req.flash(
          "success",
          `Material "${updatedItem.name}" atualizado como ${
            updatedItem.item_type === "patrimony" ? "patrimônio" : "estoque"
          }.`,
        );
        return res.redirect(`${almoxPath(activeTab)}#almox-edit-item-${itemId}`);
      } catch (error) {
        logError(req, "Erro ao editar item do almoxarifado:", error);
        req.flash("danger", `Erro ao editar material: ${error.message}`);
        return (await renderAlmox(res, {
          activeTab,
          inventoryEditOpenId: itemId,
          inventoryEditFormData,
          inventoryEditErrors,
        }));
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/categories/delete/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        req.flash("warning", "Categoria inválida.");
        return res.redirect(almoxPath("manage"));
      }

      try {
        const deleted = (await database.deleteInventoryCategory(categoryId));
        if (!deleted) {
          req.flash("warning", "Categoria não encontrada.");
        } else {
          req.flash("success", `Categoria "${deleted.name}" removida com sucesso.`);
        }
      } catch (error) {
        logError(req, "Erro ao remover categoria:", error);
        req.flash("danger", `Erro ao remover categoria: ${error.message}`);
      }

      return res.redirect(almoxPath("manage"));
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/locations/create",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const { normalized, errors } = validateCatalogName(
        req.body.name,
        "nome do local",
      );

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return (await renderAlmox(res, {
          activeTab,
          locationFormData: { name: normalized },
          locationErrors: errors,
        }));
      }

      try {
        const location = (await database.createInventoryLocation(normalized));
        req.flash("success", `Local "${location.name}" criado com sucesso.`);
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          errors.name = ["Já existe um local com esse nome."];
        } else {
          logError(req, "Erro ao criar local:", error);
          req.flash("danger", `Erro ao criar local: ${error.message}`);
        }

        return (await renderAlmox(res, {
          activeTab,
          locationFormData: { name: normalized },
          locationErrors: errors,
        }));
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/locations/delete/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        req.flash("warning", "Local inválido.");
        return res.redirect(almoxPath("manage"));
      }

      try {
        const deleted = (await database.deleteInventoryLocation(locationId));
        if (!deleted) {
          req.flash("warning", "Local não encontrado.");
        } else {
          req.flash("success", `Local "${deleted.name}" removido com sucesso.`);
        }
      } catch (error) {
        logError(req, "Erro ao remover local:", error);
        req.flash("danger", `Erro ao remover local: ${error.message}`);
      }

      return res.redirect(almoxPath("manage"));
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/inventory/delete/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        req.flash("warning", "Produto inválido para exclusão.");
        return res.redirect(almoxPath(req.body.tab || "stock"));
      }

      try {
        const deletedItem = (await database.deleteInventoryItem(itemId));

        if (!deletedItem) {
          req.flash("warning", "Produto não encontrado.");
        } else {
          req.flash(
            "success",
            `Produto "${deletedItem.name}" removido do almoxarifado com sucesso.`,
          );
        }
      } catch (error) {
        logError(req, "Erro ao excluir item do estoque:", error);
        req.flash("danger", `Erro ao excluir item: ${error.message}`);
      }

      return res.redirect(almoxPath(req.body.tab || "stock"));
    },
  );

  // DETALHE: Rota POST /almoxarifado/inventory/withdraw: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/almoxarifado/inventory/withdraw", requireAuth, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const activeTab = "withdraw";
    const withdrawFormData = {
      nameOrCode: String(req.body.name_or_code || "").trim(),
      quantity: String(req.body.quantity || "").trim(),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const withdrawErrors = {};
    const quantity = Number(withdrawFormData.quantity);

    if (!withdrawFormData.nameOrCode) {
      withdrawErrors.nameOrCode = ["Informe o nome exato ou o ID do produto."];
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      withdrawErrors.quantity = ["Informe uma quantidade inteira maior que zero."];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(withdrawErrors).length > 0) {
      return (await renderAlmox(res, {
        activeTab,
        withdrawFormData,
        withdrawErrors,
      }));
    }

    const result = (await database.withdrawInventoryItem({
      nameOrCode: withdrawFormData.nameOrCode,
      quantity,
      userId: req.currentUser.id,
    }));

    if (!result.success) {
      return (await renderAlmox(res, {
        activeTab,
        withdrawFormData,
        withdrawErrors: {
          form: [result.message],
        },
      }));
    }

    req.flash("success", result.message);
    return res.redirect(almoxPath("withdraw"));
  });

  // DETALHE: Rota POST /almoxarifado/inventory/borrow: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/almoxarifado/inventory/borrow", requireAuth, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const activeTab = "borrow";
    const loanFormData = {
      nameOrCode: String(req.body.name_or_code || "").trim(),
      quantity: String(req.body.quantity || "").trim(),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const loanErrors = {};
    const quantity = Number(loanFormData.quantity);

    if (!loanFormData.nameOrCode) {
      loanErrors.nameOrCode = ["Informe o nome exato ou o ID do patrimônio."];
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      loanErrors.quantity = ["Informe uma quantidade inteira maior que zero."];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(loanErrors).length > 0) {
      return (await renderAlmox(res, {
        activeTab,
        loanFormData,
        loanErrors,
      }));
    }

    const result = (await database.borrowInventoryItem({
      nameOrCode: loanFormData.nameOrCode,
      quantity,
      userId: req.currentUser.id,
    }));

    if (!result.success) {
      return (await renderAlmox(res, {
        activeTab,
        loanFormData,
        loanErrors: {
          form: [result.message],
        },
      }));
    }

    req.flash("success", result.message);
    return res.redirect(almoxPath("borrowed"));
  });

  // DETALHE: Rota POST /almoxarifado/loans/return/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/almoxarifado/loans/return/:id", requireAuth, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const loanId = parseId(req.params.id);
    if (!loanId) {
      req.flash("warning", "Empréstimo inválido.");
      return res.redirect(almoxPath("borrowed"));
    }

    const loan = (await database.getInventoryLoanById(loanId));
    if (!loan) {
      req.flash("warning", "Empréstimo não encontrado.");
      return res.redirect(almoxPath("borrowed"));
    }

    if (!req.currentUser.is_admin && loan.user_id !== req.currentUser.id) {
      req.flash(
        "warning",
        "Você só pode registrar a devolução dos empréstimos feitos no seu usuário.",
      );
      return res.redirect(almoxPath("borrowed"));
    }

    const result = (await database.returnInventoryLoan({
      loanId,
      actorUserId: req.currentUser.id,
    }));

    if (!result.success) {
      req.flash("warning", result.message);
      return res.redirect(almoxPath("borrowed"));
    }

    req.flash("success", result.message);
    return res.redirect(almoxPath("borrowed"));
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/loans/extend/:id",
    requireAuth,
    requireAdminPage,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const loanId = parseId(req.params.id);
      const extraDays = Number(req.body.extra_days);

      if (!loanId) {
        req.flash("warning", "Empréstimo inválido.");
        return res.redirect(almoxPath("borrowed"));
      }

      if (!Number.isInteger(extraDays) || extraDays <= 0 || extraDays > 90) {
        req.flash(
          "warning",
          "Informe uma prorrogação válida entre 1 e 90 dias.",
        );
        return res.redirect(almoxPath("borrowed"));
      }

      const result = (await database.extendInventoryLoan({
        loanId,
        extraDays,
        actorUserId: req.currentUser.id,
      }));

      if (!result.success) {
        req.flash("warning", result.message);
        return res.redirect(almoxPath("borrowed"));
      }

      req.flash("success", result.message);
      return res.redirect(almoxPath("borrowed"));
    },
  );

  // DETALHE: Rota GET /almoxarifado/api/itens: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/almoxarifado/api/itens", requireAuth, async (req, res, next) => {
    try {
      const itemType = String(req.query.type || "").trim().toLowerCase();
      const items = await databaseAsync.listInventoryItems({ type: itemType || null });
      return res.json(items.map(mapInventoryApiItem));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/almoxarifado/api/dashboard", requireAuth, async (req, res, next) => {
    try {
      return res.json(await databaseAsync.getInventoryDashboardData());
    } catch (error) {
      return next(error);
    }
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/api/itens",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const parsed = parseInventoryPayload(req.body);
      const { errors, normalized } = validateInventoryPayload(parsed);
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados inválidos.", errors);
      }

      try {
        const item = (await database.createInventoryItem({
          name: normalized.name,
          itemType: normalized.itemType,
          category: normalized.category,
          categoryId: normalized.categoryId,
          location: normalized.location,
          locationId: normalized.locationId,
          quantity: normalized.quantity,
          description: normalized.description,
        }));
        return res.status(201).json(item);
      } catch (error) {
        logError(req, "Erro ao criar item via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.put(
    "/almoxarifado/api/itens/:id",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        return sendApiError(req, res, 400, "Item inválido.");
      }

      const parsed = parseInventoryPayload(req.body);
      const { errors, normalized } = validateInventoryPayload(parsed);
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados inválidos.", errors);
      }

      try {
        const updated = (await database.updateInventoryItem(itemId, {
          name: normalized.name,
          itemType: normalized.itemType,
          category: normalized.category,
          categoryId: normalized.categoryId,
          location: normalized.location,
          locationId: normalized.locationId,
          quantity: normalized.quantity,
          description: normalized.description,
        }));

        if (!updated) {
          return sendApiError(req, res, 404, "Item não encontrado.");
        }

        return res.json(updated);
      } catch (error) {
        logError(req, "Erro ao atualizar item via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.delete(
    "/almoxarifado/api/itens/:id",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        return sendApiError(req, res, 400, "Item inválido.");
      }

      try {
        const deleted = (await database.deleteInventoryItem(itemId));
        if (!deleted) {
          return sendApiError(req, res, 404, "Item não encontrado.");
        }

        return res.json({
          mensagem: "Item removido com sucesso.",
          item: deleted,
        });
      } catch (error) {
        logError(req, "Erro ao remover item via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Rota GET /almoxarifado/api/categorias: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/almoxarifado/api/categorias", requireAuth, async (req, res) => {
    return res.json(
      (await database.listInventoryCategories()).map((category) => ({
        id: category.id,
        nome: category.name,
      })),
    );
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/api/categorias",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome da categoria",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados inválidos.", errors);
      }

      try {
        const category = (await database.createInventoryCategory(normalized));
        return res.status(201).json({ id: category.id, nome: category.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Categoria já cadastrada.");
        }
        logError(req, "Erro ao criar categoria via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.put(
    "/almoxarifado/api/categorias/:id",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        return sendApiError(req, res, 400, "Categoria inválida.");
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome da categoria",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados inválidos.", errors);
      }

      try {
        const category = (await database.updateInventoryCategory(categoryId, normalized));
        if (!category) {
          return sendApiError(req, res, 404, "Categoria não encontrada.");
        }

        return res.json({ id: category.id, nome: category.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Categoria já cadastrada.");
        }
        logError(req, "Erro ao atualizar categoria via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.delete(
    "/almoxarifado/api/categorias/:id",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        return sendApiError(req, res, 400, "Categoria inválida.");
      }

      try {
        const deleted = (await database.deleteInventoryCategory(categoryId));
        if (!deleted) {
          return sendApiError(req, res, 404, "Categoria não encontrada.");
        }

        return res.json({
          mensagem: "Categoria removida com sucesso.",
          categoria: { id: deleted.id, nome: deleted.name },
        });
      } catch (error) {
        logError(req, "Erro ao remover categoria via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Rota GET /almoxarifado/api/locais: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/almoxarifado/api/locais", requireAuth, async (req, res) => {
    return res.json(
      (await database.listInventoryLocations()).map((location) => ({
        id: location.id,
        nome: location.name,
      })),
    );
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/api/locais",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome do local",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados inválidos.", errors);
      }

      try {
        const location = (await database.createInventoryLocation(normalized));
        return res.status(201).json({ id: location.id, nome: location.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Local já cadastrado.");
        }
        logError(req, "Erro ao criar local via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.put(
    "/almoxarifado/api/locais/:id",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        return sendApiError(req, res, 400, "Local inválido.");
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome do local",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados inválidos.", errors);
      }

      try {
        const location = (await database.updateInventoryLocation(locationId, normalized));
        if (!location) {
          return sendApiError(req, res, 404, "Local não encontrado.");
        }

        return res.json({ id: location.id, nome: location.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Local já cadastrado.");
        }
        logError(req, "Erro ao atualizar local via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.delete(
    "/almoxarifado/api/locais/:id",
    requireAuth,
    requireAdminApi,
    async (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        return sendApiError(req, res, 400, "Local inválido.");
      }

      try {
        const deleted = (await database.deleteInventoryLocation(locationId));
        if (!deleted) {
          return sendApiError(req, res, 404, "Local não encontrado.");
        }

        return res.json({
          mensagem: "Local removido com sucesso.",
          local: { id: deleted.id, nome: deleted.name },
        });
      } catch (error) {
        logError(req, "Erro ao remover local via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

    // SECAO: endpoints auxiliares para preencher formularios dinamicos no frontend.

// DETALHE: Rota GET /api/project/:project_id/members: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/api/project/:project_id/members", requireAuth, async (req, res) => {
    const projectId = parseId(req.params.project_id);
    const project = projectId ? (await database.getProjectById(projectId)) : null;

    if (!project) {
      return sendApiError(req, res, 404, "Projeto não encontrado.");
    }

    if (!(await canCreateAtaForProject(req, project)) && !(await canManageProject(req, project))) {
      return sendApiError(req, res, 403, "Você não tem acesso aos membros deste projeto.");
    }

    return res.json({
      members: project.active_members.map((member) => ({
        id: member.id,
        name: member.name,
      })),
    });
  });
}

module.exports = { registerAlmoxRoutes };
