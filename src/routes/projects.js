const asyncArray = require("../asyncArray");
/*
 * ARQUIVO: src/routes/projects.js
 * FUNCAO: registra rotas de listagem, criacao, edicao e exclusao de projetos.
 * IMPACTO DE MUDANCAS:
 * - Alterar vinculo de membros/coordenadores muda permissoes no restante do sistema.
 * - Alterar fluxo de logo/cor impacta exibicao em listagens e relatorios.
 */
function registerProjectRoutes(ctx) {
  const {
    app,
    requireAuth,
    runLogoUpload,
    ensureValidCsrf,
    parseId,
    parseIdArray,
    database,
    notFound,
    render,
    renderProjectForm,
    normalizeProjectColor,
    DEFAULT_PROJECT_COLOR,
    canCreateAtaForProject,
    getCurrentMember,
    getRequestProjectById,
    listRequestProjectsForMember,
    isRequestProjectCoordinator,
    persistUploadedImage,
    deleteStoredImage,
    isUniqueConstraintError,
    safeUnlink,
    urlFor,
    logError,
  } = ctx;

  function canAssignMembersToProject(req, project) {
    return Boolean(req.currentUser && project);
  }

  async function isCoordinatorInAnyProject(req) {
    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    const memberProjects = (await listRequestProjectsForMember(req, currentMember.id));
    return (await asyncArray.some(memberProjects, async (project) => (await isRequestProjectCoordinator(req, project.id, currentMember.id))));
  }

  async function canManageCoordinatorAssignments(req, project = null) {
    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = (await getCurrentMember(req));
    if (!currentMember?.is_active) {
      return false;
    }

    if (project) {
      return (await isRequestProjectCoordinator(req, project.id, currentMember.id));
    }

    return (await isCoordinatorInAnyProject(req));
  }

app.get("/projects", requireAuth, async (req, res) => {
    const projects = (await asyncArray.map((await database.listProjectsWithMembers()), async (project) => ({
      ...project,
      can_manage: true,
      can_assign_members: canAssignMembersToProject(req, project),
      can_create_ata_shortcut: (await canCreateAtaForProject(req, project)),
    })));
    const showProjectActions = projects.some((project) => project.can_create_ata_shortcut || project.can_assign_members);

    return render(res, "projects/list.html", {
      title: "Projetos",
      activeSection: "projects",
      projects,
      showProjectActions,
    });
  });

  // DETALHE: Rota GET /projects/add: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/projects/add", requireAuth, async (req, res) => {
    return (await renderProjectForm(res, {
      title: "Adicionar Projeto",
      actionLabel: "Adicionar",
      formData: {
        name: "",
        primaryColor: DEFAULT_PROJECT_COLOR,
        memberIds: [],
        coordinatorIds: [],
        logoClear: false,
      },
      errors: {},
      canManageProject: true,
      canManageCoordinators: (await canManageCoordinatorAssignments(req)),
    }));
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/projects/add",
    requireAuth,
    runLogoUpload,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return;
      }

      const canManageCoordinators = (await canManageCoordinatorAssignments(req));
      const memberIds = parseIdArray(req.body.members);
      const requestedCoordinatorIds = parseIdArray(req.body.coordinators);
      const coordinatorIds = canManageCoordinators ? requestedCoordinatorIds : [];
      const formData = {
        name: String(req.body.name || "").trim(),
        primaryColor: normalizeProjectColor(req.body.primary_color),
        memberIds,
        coordinatorIds,
        logoClear: false,
      };
      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

      const errors = {};

      if (!formData.name) {
        errors.name = ["Nome do projeto é obrigatório."];
      } else if (formData.name.length < 3 || formData.name.length > 150) {
        errors.name = ["Nome do projeto deve ter entre 3 e 150 caracteres."];
      }

      if (req.uploadError) {
        errors.logo = [req.uploadError];
      }

      const validMemberIds = new Set(
        (await database.listActiveMembers()).map((member) => member.id),
      );
      const invalidMemberIds = memberIds.filter(
        (memberId) => !validMemberIds.has(memberId),
      );
      if (memberIds.length === 0) {
        errors.members = ["Selecione ao menos um membro para o projeto."];
      } else if (invalidMemberIds.length > 0) {
        errors.members = ["Há membros inválidos na seleção."];
      }

      const coordinatorOutsideProject = coordinatorIds.filter(
        (memberId) => !memberIds.includes(memberId),
      );
      if (coordinatorOutsideProject.length > 0) {
        errors.coordinators = ["Todo coordenador também precisa estar marcado como membro."];
      } else if (canManageCoordinators && memberIds.length > 0 && coordinatorIds.length === 0) {
        errors.coordinators = ["Selecione ao menos um coordenador para o projeto."];
      }

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return (await renderProjectForm(res, {
          title: "Adicionar Projeto",
          actionLabel: "Adicionar",
          formData,
          errors,
          canManageProject: true,
          canManageCoordinators,
        }));
      }

      let storedLogo = null;
      try {
        storedLogo = await persistUploadedImage(req, { folder: "pet-c3/projects" });
        const project = (await database.createProject({
          name: formData.name,
          logo: storedLogo || null,
          primaryColor: formData.primaryColor,
          memberIds,
          coordinatorIds,
        }));
        req.flash("success", `Projeto "${project.name}" adicionado com sucesso!`);
        return res.redirect(urlFor("list_projects"));
      } catch (error) {
        if (storedLogo) {
          await deleteStoredImage(storedLogo);
        } else if (req.file) {
          safeUnlink(req.file.path);
        }

        if (isUniqueConstraintError(error)) {
          errors.name = ["Já existe um projeto com este nome."];
        } else {
          logError(req, "Erro ao adicionar projeto:", error);
          req.flash("danger", `Erro ao adicionar projeto: ${error.message}`);
        }

        return (await renderProjectForm(res, {
          title: "Adicionar Projeto",
          actionLabel: "Adicionar",
          formData,
          errors,
          canManageProject: true,
          canManageCoordinators,
        }));
      }
    },
  );

  // DETALHE: Rota GET /projects/edit/:id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/projects/edit/:id", requireAuth, async (req, res) => {
    const project = (await getRequestProjectById(req, parseId(req.params.id)));
    if (!project) {
      return notFound(res);
    }

    const canManageMetadata = true;
    const canManageCoordinators = (await canManageCoordinatorAssignments(req, project));

    return (await renderProjectForm(res, {
      title: "Editar Projeto",
      actionLabel: "Salvar Alterações",
      formData: {
        name: project.name,
        primaryColor: project.primary_color || DEFAULT_PROJECT_COLOR,
        memberIds: project.active_member_ids,
        coordinatorIds: project.coordinator_member_ids,
        logoClear: false,
      },
      errors: {},
      project,
      canManageProject: canManageMetadata,
      canManageCoordinators,
    }));
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/projects/edit/:id",
    requireAuth,
    runLogoUpload,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return;
      }

      const projectId = parseId(req.params.id);
      const project = (await getRequestProjectById(req, projectId));
      if (!project) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return notFound(res);
      }

      const canManageMetadata = true;
      const canManageCoordinators = (await canManageCoordinatorAssignments(req, project));

      const memberIds = parseIdArray(req.body.members);
      const requestedCoordinatorIds = parseIdArray(req.body.coordinators);
      const coordinatorIds = canManageCoordinators
        ? requestedCoordinatorIds
        : project.coordinator_member_ids.filter((memberId) => memberIds.includes(memberId));
      const formData = {
        name: String(req.body.name || "").trim(),
        primaryColor: normalizeProjectColor(req.body.primary_color, project.primary_color),
        memberIds,
        coordinatorIds,
        logoClear: Boolean(req.body["logo-clear"]),
      };
      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

      const errors = {};

      if (!formData.name) {
        errors.name = ["Nome do projeto é obrigatório."];
      } else if (formData.name.length < 3 || formData.name.length > 150) {
        errors.name = ["Nome do projeto deve ter entre 3 e 150 caracteres."];
      }

      if (req.uploadError) {
        errors.logo = [req.uploadError];
      }

      const validMemberIds = new Set(
        (await database.listActiveMembers()).map((member) => member.id),
      );
      const invalidMemberIds = memberIds.filter(
        (memberId) => !validMemberIds.has(memberId),
      );
      if (memberIds.length === 0) {
        errors.members = ["Selecione ao menos um membro para o projeto."];
      } else if (invalidMemberIds.length > 0) {
        errors.members = ["Há membros inválidos na seleção."];
      }

      const coordinatorOutsideProject = coordinatorIds.filter(
        (memberId) => !memberIds.includes(memberId),
      );
      if (coordinatorOutsideProject.length > 0) {
        errors.coordinators = ["Todo coordenador também precisa estar marcado como membro."];
      } else if (canManageCoordinators && memberIds.length > 0 && coordinatorIds.length === 0) {
        errors.coordinators = ["Selecione ao menos um coordenador para o projeto."];
      }

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return (await renderProjectForm(res, {
          title: "Editar Projeto",
          actionLabel: "Salvar Alterações",
          formData,
          errors,
          project,
          canManageProject: canManageMetadata,
          canManageCoordinators,
        }));
      }

      let logo = project.logo;
      let uploadedIsNew = false;
      let uploadedLogo = null;

      try {
        if (req.file) {
          uploadedLogo = await persistUploadedImage(req, { folder: "pet-c3/projects" });
          logo = uploadedLogo;
          uploadedIsNew = logo !== project.logo;
        } else if (formData.logoClear) {
          logo = null;
        }

        const updated = (await database.updateProject(projectId, {
          name: formData.name,
          logo,
          primaryColor: formData.primaryColor,
          memberIds,
          coordinatorIds,
        }));
        if (project.logo && logo !== project.logo) {
          await deleteStoredImage(project.logo);
        }
        req.flash("success", `Projeto "${updated.name}" atualizado com sucesso!`);
        return res.redirect(urlFor("list_projects"));
      } catch (error) {
        if (uploadedLogo && uploadedIsNew) {
          await deleteStoredImage(uploadedLogo);
        } else if (req.file) {
          safeUnlink(req.file.path);
        }

        if (isUniqueConstraintError(error)) {
          errors.name = ["Já existe um projeto com este nome."];
        } else {
          logError(req, "Erro ao editar projeto:", error);
          req.flash("danger", `Erro ao editar projeto: ${error.message}`);
        }

        return (await renderProjectForm(res, {
          title: "Editar Projeto",
          actionLabel: "Salvar Alterações",
          formData,
          errors,
          project: {
            ...project,
            logo,
            primary_color: formData.primaryColor,
          },
          canManageProject: canManageMetadata,
          canManageCoordinators,
        }));
      }
    },
  );

  // DETALHE: Rota POST /projects/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/projects/delete/:id", requireAuth, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const projectId = parseId(req.params.id);
    const project = (await getRequestProjectById(req, projectId));
    if (!project) {
      return notFound(res);
    }

    if (!req.currentUser?.is_admin) {
      req.flash(
        "warning",
        "Somente administradores podem remover projetos.",
      );
      return res.redirect(urlFor("list_projects"));
    }

    try {
      (await database.deleteProject(projectId));
      if (project.logo) {
        await deleteStoredImage(project.logo);
      }
      req.flash(
        "success",
        `Projeto "${project.name}" e suas atas associadas foram excluídos com sucesso!`,
      );
    } catch (error) {
      logError(req, "Erro ao excluir projeto:", error);
      req.flash("danger", `Erro ao excluir projeto: ${error.message}`);
    }

    return res.redirect(urlFor("list_projects"));
  });
}

module.exports = { registerProjectRoutes };
