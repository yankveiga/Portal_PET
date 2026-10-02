/*
 * ARQUIVO: src/routes/atas.js
 * FUNCAO: registra rotas de criacao, download e exclusao de atas.
 * IMPACTO DE MUDANCAS:
 * - Alterar validacoes de formulario pode bloquear criacao legitima de atas.
 * - Alterar montagem de participantes/justificativas afeta auditoria de reunioes.
 */
function registerAtaRoutes(ctx) {
  const {
    app,
    requireAuth,
    ensureValidCsrf,
    parseId,
    parseIdArray,
    toSqlDateTime,
    trimToNull,
    defaultMeetingDateTimeInput,
    formatDatePt,
    generateAtaPdf,
    database,
    notFound,
    urlFor,
    canManageProject,
    canCreateAtaForProject,
    listAccessibleProjects,
    renderAtaForm,
    logError,
  } = ctx;

app.get("/atas/create", requireAuth, async (req, res) => {
    const availableProjects = (await listAccessibleProjects(req));
    return (await renderAtaForm(req, res, {
      title: "Criar Nova Ata",
      formData: {
        projectId: "",
        meetingDatetime: defaultMeetingDateTimeInput(),
        notes: "",
        presentMemberIds: [],
        justifications: {},
      },
      errors: {},
      projects: availableProjects,
    }));
  });

  // DETALHE: Rota GET /atas/create/for/:project_id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/atas/create/for/:project_id", requireAuth, async (req, res) => {
    const projectId = parseId(req.params.project_id);
    const project = (await database.getProjectById(projectId));
    if (!project) {
      return notFound(res);
    }

    if (!(await canCreateAtaForProject(req, project))) {
      req.flash(
        "warning",
        "Você só pode criar atas para projetos nos quais está vinculado como membro.",
      );
      return res.redirect(urlFor("create_ata"));
    }

    return (await renderAtaForm(req, res, {
      title: "Criar Nova Ata",
      formData: {
        projectId: String(projectId),
        meetingDatetime: defaultMeetingDateTimeInput(),
        notes: "",
        presentMemberIds: [],
        justifications: {},
      },
      errors: {},
      projects: (await listAccessibleProjects(req)),
    }));
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    ["/atas/create", "/atas/create/for/:project_id"],
    requireAuth,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const formData = {
        projectId: String(req.body.project || req.body.projectId || ""),
        meetingDatetime: String(req.body.meeting_datetime || "").trim(),
        notes: String(req.body.notes || ""),
        presentMemberIds: parseIdArray(req.body.present_members),
        justifications: {},
      };

      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

      const errors = {};
      const projectId = parseId(formData.projectId);
      const project = projectId ? (await database.getProjectById(projectId)) : null;

      if (!project) {
        errors.project = ["É necessário selecionar um projeto válido."];
      } else if (!(await canCreateAtaForProject(req, project))) {
        errors.project = [
          "Você só pode criar atas para projetos nos quais está vinculado como membro.",
        ];
      }

      const meetingDateTime = toSqlDateTime(formData.meetingDatetime);
      if (!meetingDateTime) {
        errors.meeting_datetime = ["Data e hora são obrigatórias."];
      }

      if (!formData.notes.trim()) {
        errors.notes = ["É necessário registrar o que foi tratado."];
      } else if (formData.notes.trim().length < 10) {
        errors.notes = ["O campo deve ter pelo menos 10 caracteres."];
      }

      let validProjectMemberIds = new Set();
      let activeProjectMembers = [];
      if (project) {
        validProjectMemberIds = new Set(project.members.map((member) => member.id));
        activeProjectMembers = project.active_members;
      }

      const invalidPresentMembers = formData.presentMemberIds.filter(
        (memberId) => !validProjectMemberIds.has(memberId),
      );
      if (invalidPresentMembers.length > 0 && project) {
        errors.present_members = [
          `Os seguintes membros selecionados não pertencem ao projeto "${project.name}".`,
        ];
      }

      activeProjectMembers.forEach((member) => {
        const fieldName = `justification_${member.id}`;
        const justification = trimToNull(req.body[fieldName]);
        if (justification) {
          formData.justifications[member.id] = justification;
        }
      });

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return (await renderAtaForm(req, res, {
          title: "Criar Nova Ata",
          formData,
          errors,
          projects: (await listAccessibleProjects(req)),
        }));
      }

      const presentMemberIds = new Set(formData.presentMemberIds);
      const justificationsToSave = {};

      activeProjectMembers.forEach((member) => {
        if (!presentMemberIds.has(member.id)) {
          const justification = trimToNull(formData.justifications[member.id]);
          if (justification) {
            justificationsToSave[member.id] = justification;
          }
        }
      });

      try {
        (await database.createAta({
          projectId,
          meetingDateTime,
          notes: formData.notes.trim(),
          presentMemberIds: [...presentMemberIds],
          justifications: justificationsToSave,
        }));
        req.flash("success", "Ata criada com sucesso!");
        return res.redirect(urlFor("home"));
      } catch (error) {
        logError(req, "Erro ao criar ata:", error);
        req.flash("danger", `Erro ao criar ata: ${error.message}`);
        return (await renderAtaForm(req, res, {
          title: "Criar Nova Ata",
          formData,
          errors,
          projects: (await listAccessibleProjects(req)),
        }));
      }
    },
  );

  // DETALHE: Rota GET /atas/download/:id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/atas/download/:id", requireAuth, async (req, res) => {
    const ata = (await database.getAtaById(parseId(req.params.id)));
    if (!ata) {
      return notFound(res);
    }

    try {
      const pdf = await generateAtaPdf(ata);
      const datePart = formatDatePt(ata.meeting_datetime).replace(/\//g, "");
      const safeProjectName = ata.project.name.replace(/\s+/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Ata_${safeProjectName}_${datePart}.pdf"`,
      );
      return res.send(pdf);
    } catch (error) {
      logError(req, "Erro ao gerar PDF:", error);
      req.flash(
        "danger",
        `Ocorreu um erro ao gerar o PDF da ata: ${error.message}`,
      );
      return res.redirect(urlFor("home"));
    }
  });

  // DETALHE: Rota POST /atas/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/atas/delete/:id", requireAuth, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const ataId = parseId(req.params.id);
    const ata = (await database.getAtaById(ataId));
    if (!ata) {
      return notFound(res);
    }

    if (!(await canManageProject(req, ata.project))) {
      req.flash(
        "warning",
        "Somente coordenadores do projeto podem excluir esta ata.",
      );
      return res.redirect(urlFor("home"));
    }

    try {
      (await database.deleteAta(ataId));
      req.flash("success", "Ata excluída com sucesso!");
    } catch (error) {
      logError(req, "Erro ao excluir ata:", error);
      req.flash("danger", `Erro ao excluir a ata: ${error.message}`);
    }

    return res.redirect(urlFor("home"));
  });
}

module.exports = { registerAtaRoutes };
