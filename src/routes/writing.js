/*
 * ARQUIVO: src/routes/writing.js
 * FUNCAO: registra rotas dos espacos de escrita geral e privado do tutor.
 * IMPACTO DE MUDANCAS:
 * - Alterar regras de permissao pode expor anotacoes privadas indevidamente.
 * - Alterar validacoes de formulario afeta criacao/edicao dos registros.
 */
function registerWritingRoutes(ctx) {
  const {
    app,
    database,
    render,
    requireAuth,
    requireAdminPage,
    ensureValidCsrf,
    parseId,
    urlFor,
  } = ctx;

  function canUseTutorPrivateSpace(req) {
    return req.currentUser?.role === "tutor";
  }

  function parseEntryFormData(source = {}) {
    return {
      title: String(source.title || "").trim(),
      content: String(source.content || "").trim(),
    };
  }

  function validateEntryFormData(formData) {
    const errors = {};
    if (!formData.title) {
      errors.title = ["O título é obrigatório."];
    } else if (formData.title.length > 160) {
      errors.title = ["O título deve ter no máximo 160 caracteres."];
    }

    if (!formData.content) {
      errors.content = ["O conteúdo é obrigatório."];
    } else if (formData.content.length > 20000) {
      errors.content = ["O conteúdo deve ter no máximo 20000 caracteres."];
    }

    return errors;
  }

  async function renderWritingPage(req, res, data = {}) {
    const isTutor = canUseTutorPrivateSpace(req);
    return render(res, "writing/index.html", {
      title: "Espaços de Escrita",
      activeSection: "writing",
      isTutor,
      generalEntries: (await database.listWritingGeneralEntries()),
      tutorEntries: isTutor
        ? (await database.listWritingTutorPrivateEntries(req.currentUser.id))
        : [],
      generalFormData: {
        title: "",
        content: "",
        ...(data.generalFormData || {}),
      },
      generalErrors: data.generalErrors || {},
      tutorFormData: {
        title: "",
        content: "",
        ...(data.tutorFormData || {}),
      },
      tutorErrors: data.tutorErrors || {},
      generalEditingId: data.generalEditingId || null,
      tutorEditingId: data.tutorEditingId || null,
    });
  }

  app.get("/espacos-escrita", requireAuth, requireAdminPage, async (req, res) => {
    return (await renderWritingPage(req, res));
  });

  app.post("/espacos-escrita/geral/create", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const generalFormData = parseEntryFormData(req.body);
    const generalErrors = validateEntryFormData(generalFormData);
    if (Object.keys(generalErrors).length) {
      return (await renderWritingPage(req, res, { generalFormData, generalErrors }));
    }

    try {
      (await database.createWritingGeneralEntry({
        title: generalFormData.title,
        content: generalFormData.content,
        authorUserId: req.currentUser.id,
      }));
      req.flash("success", "Registro geral criado com sucesso.");
      return res.redirect(urlFor("writing_spaces"));
    } catch (error) {
      req.flash("danger", `Erro ao criar registro geral: ${error.message}`);
      return (await renderWritingPage(req, res, { generalFormData, generalErrors }));
    }
  });

  app.post("/espacos-escrita/geral/edit/:id", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const entryId = parseId(req.params.id);
    if (!entryId) {
      req.flash("warning", "Registro geral inválido.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const existing = (await database.getWritingGeneralEntryById(entryId));
    if (!existing) {
      req.flash("warning", "Registro geral não encontrado.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const generalFormData = parseEntryFormData(req.body);
    const generalErrors = validateEntryFormData(generalFormData);
    if (Object.keys(generalErrors).length) {
      return (await renderWritingPage(req, res, {
        generalFormData,
        generalErrors,
        generalEditingId: entryId,
      }));
    }

    try {
      (await database.updateWritingGeneralEntry(entryId, generalFormData));
      req.flash("success", "Registro geral atualizado com sucesso.");
      return res.redirect(urlFor("writing_spaces"));
    } catch (error) {
      req.flash("danger", `Erro ao atualizar registro geral: ${error.message}`);
      return (await renderWritingPage(req, res, {
        generalFormData,
        generalErrors,
        generalEditingId: entryId,
      }));
    }
  });

  app.post("/espacos-escrita/geral/delete/:id", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const entryId = parseId(req.params.id);
    if (!entryId) {
      req.flash("warning", "Registro geral inválido.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const deleted = (await database.deleteWritingGeneralEntry(entryId));
    if (!deleted) {
      req.flash("warning", "Registro geral não encontrado.");
      return res.redirect(urlFor("writing_spaces"));
    }

    req.flash("success", "Registro geral removido com sucesso.");
    return res.redirect(urlFor("writing_spaces"));
  });

  app.post("/espacos-escrita/tutor/create", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    if (!canUseTutorPrivateSpace(req)) {
      req.flash("warning", "Apenas tutores podem criar anotações privadas.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const tutorFormData = parseEntryFormData(req.body);
    const tutorErrors = validateEntryFormData(tutorFormData);
    if (Object.keys(tutorErrors).length) {
      return (await renderWritingPage(req, res, { tutorFormData, tutorErrors }));
    }

    try {
      (await database.createWritingTutorPrivateEntry({
        title: tutorFormData.title,
        content: tutorFormData.content,
        tutorUserId: req.currentUser.id,
      }));
      req.flash("success", "Anotação privada criada com sucesso.");
      return res.redirect(urlFor("writing_spaces"));
    } catch (error) {
      req.flash("danger", `Erro ao criar anotação privada: ${error.message}`);
      return (await renderWritingPage(req, res, { tutorFormData, tutorErrors }));
    }
  });

  app.post("/espacos-escrita/tutor/edit/:id", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    if (!canUseTutorPrivateSpace(req)) {
      req.flash("warning", "Apenas tutores podem editar anotações privadas.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const entryId = parseId(req.params.id);
    if (!entryId) {
      req.flash("warning", "Anotação privada inválida.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const existing = (await database.getWritingTutorPrivateEntryById(entryId));
    if (!existing || existing.tutor_user_id !== req.currentUser.id) {
      req.flash("warning", "Anotação privada não encontrada.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const tutorFormData = parseEntryFormData(req.body);
    const tutorErrors = validateEntryFormData(tutorFormData);
    if (Object.keys(tutorErrors).length) {
      return (await renderWritingPage(req, res, {
        tutorFormData,
        tutorErrors,
        tutorEditingId: entryId,
      }));
    }

    try {
      (await database.updateWritingTutorPrivateEntry(entryId, tutorFormData));
      req.flash("success", "Anotação privada atualizada com sucesso.");
      return res.redirect(urlFor("writing_spaces"));
    } catch (error) {
      req.flash("danger", `Erro ao atualizar anotação privada: ${error.message}`);
      return (await renderWritingPage(req, res, {
        tutorFormData,
        tutorErrors,
        tutorEditingId: entryId,
      }));
    }
  });

  app.post("/espacos-escrita/tutor/delete/:id", requireAuth, requireAdminPage, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    if (!canUseTutorPrivateSpace(req)) {
      req.flash("warning", "Apenas tutores podem excluir anotações privadas.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const entryId = parseId(req.params.id);
    if (!entryId) {
      req.flash("warning", "Anotação privada inválida.");
      return res.redirect(urlFor("writing_spaces"));
    }

    const existing = (await database.getWritingTutorPrivateEntryById(entryId));
    if (!existing || existing.tutor_user_id !== req.currentUser.id) {
      req.flash("warning", "Anotação privada não encontrada.");
      return res.redirect(urlFor("writing_spaces"));
    }

    (await database.deleteWritingTutorPrivateEntry(entryId));
    req.flash("success", "Anotação privada removida com sucesso.");
    return res.redirect(urlFor("writing_spaces"));
  });
}

module.exports = { registerWritingRoutes };
