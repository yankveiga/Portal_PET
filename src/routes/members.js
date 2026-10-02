/*
 * ARQUIVO: src/routes/members.js
 * FUNCAO: registra rotas de membros (cadastro, edicao e desativacao).
 * IMPACTO DE MUDANCAS:
 * - Alterar validacoes afeta qualidade dos dados e integracao com usuarios/projetos.
 * - Alterar fluxo de foto pode impactar armazenamento local/remoto das imagens.
 */
const databaseAsync = require("../databaseAsync");
function registerMemberRoutes(ctx) {
  const {
    app,
    path,
    config,
    requireAuth,
    requireAdminPage,
    runMemberPhotoUpload,
    ensureValidCsrf,
    parseId,
    database,
    notFound,
    render,
    renderMemberForm,
    persistUploadedImage,
    deleteStoredImage,
    isUniqueConstraintError,
    safeUnlink,
    urlFor,
    logError,
  } = ctx;

app.get("/members", requireAuth, async (req, res, next) => {
    try {
      return render(res, "members/list.html", {
      title: "Membros Ativos",
      activeSection: "members",
      members: await databaseAsync.listActiveMembers(),
      });
    } catch (error) {
      return next(error);
    }
  });

  // DETALHE: Rota GET /members/add: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/members/add", requireAuth, requireAdminPage, (req, res) => {
    return renderMemberForm(res, {
      title: "Adicionar Membro",
      actionLabel: "Adicionar",
      formData: {
        name: "",
        photoClear: false,
      },
      errors: {},
    });
  });

  // DETALHE: Rota POST /members/add: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/members/add", requireAuth, requireAdminPage, runMemberPhotoUpload, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const formData = {
      name: String(req.body.name || "").trim(),
      photoClear: Boolean(req.body["photo-clear"]),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const errors = {};

    if (!formData.name) {
      errors.name = ["Nome é obrigatório."];
    } else if (formData.name.length < 2 || formData.name.length > 100) {
      errors.name = ["Nome deve ter entre 2 e 100 caracteres."];
    }
    if (req.uploadError) {
      errors.photo = [req.uploadError];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(errors).length > 0) {
      if (req.file?.filename) {
        safeUnlink(path.join(config.uploadDir, req.file.filename));
      }
      return renderMemberForm(res, {
        title: "Adicionar Membro",
        actionLabel: "Adicionar",
        formData,
        errors,
      });
    }

    let storedPhoto = null;
    try {
      storedPhoto = await persistUploadedImage(req, { folder: "pet-c3/members" });
      const member = (await database.createMember(formData.name, storedPhoto || null));
      req.flash("success", `Membro "${member.name}" adicionado com sucesso!`);
      return res.redirect(urlFor("list_members"));
    } catch (error) {
      if (storedPhoto) {
        await deleteStoredImage(storedPhoto);
      } else if (req.file?.path) {
        safeUnlink(req.file.path);
      }
      if (isUniqueConstraintError(error)) {
        errors.name = ["Já existe um membro com este nome."];
        return renderMemberForm(res, {
          title: "Adicionar Membro",
          actionLabel: "Adicionar",
          formData,
          errors,
        });
      }

      logError(req, "Erro ao adicionar membro:", error);
      req.flash("danger", `Erro ao adicionar membro: ${error.message}`);
      return renderMemberForm(res, {
        title: "Adicionar Membro",
        actionLabel: "Adicionar",
        formData,
        errors,
      });
    }
  });

  // DETALHE: Rota GET /members/edit/:id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/members/edit/:id", requireAuth, requireAdminPage, async (req, res) => {
    const member = (await database.getMemberById(parseId(req.params.id)));
    if (!member) {
      return notFound(res);
    }

    return renderMemberForm(res, {
      title: `Editar Membro: ${member.name} ${member.is_active ? "(Ativo)" : "(Inativo)"}`,
      actionLabel: "Salvar Alterações",
      formData: {
        name: member.name,
        photoClear: false,
      },
      errors: {},
      member,
    });
  });

  // DETALHE: Rota POST /members/edit/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/members/edit/:id", requireAuth, requireAdminPage, runMemberPhotoUpload, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const memberId = parseId(req.params.id);
    const member = (await database.getMemberById(memberId));
    if (!member) {
      return notFound(res);
    }

    const formData = {
      name: String(req.body.name || "").trim(),
      photoClear: Boolean(req.body["photo-clear"]),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const errors = {};

    if (!formData.name) {
      errors.name = ["Nome é obrigatório."];
    } else if (formData.name.length < 2 || formData.name.length > 100) {
      errors.name = ["Nome deve ter entre 2 e 100 caracteres."];
    }
    if (req.uploadError) {
      errors.photo = [req.uploadError];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(errors).length > 0) {
      if (req.file?.filename) {
        safeUnlink(path.join(config.uploadDir, req.file.filename));
      }
      return renderMemberForm(res, {
        title: `Editar Membro: ${member.name} ${member.is_active ? "(Ativo)" : "(Inativo)"}`,
        actionLabel: "Salvar Alterações",
        formData,
        errors,
        member,
      });
    }

    let uploadedPhoto = null;
    try {
      if (req.file) {
        uploadedPhoto = await persistUploadedImage(req, { folder: "pet-c3/members" });
      }
      const nextPhoto = uploadedPhoto
        ? uploadedPhoto
        : (formData.photoClear ? null : member.photo || null);
      const previousPhotoToDelete =
        nextPhoto !== (member.photo || null) && member.photo
          ? member.photo
          : null;

      (await database.updateMember(memberId, {
        name: formData.name,
        photo: nextPhoto,
      }));
      if (previousPhotoToDelete) {
        await deleteStoredImage(previousPhotoToDelete);
      }
      req.flash("success", `Membro "${formData.name}" atualizado com sucesso!`);
      return res.redirect(urlFor("list_members"));
    } catch (error) {
      if (uploadedPhoto && uploadedPhoto !== member.photo) {
        await deleteStoredImage(uploadedPhoto);
      } else if (req.file?.path) {
        safeUnlink(req.file.path);
      }
      if (isUniqueConstraintError(error)) {
        errors.name = ["Já existe um membro com este nome."];
      } else {
        logError(req, "Erro ao editar membro:", error);
        req.flash("danger", `Erro ao editar membro: ${error.message}`);
      }

      return renderMemberForm(res, {
        title: `Editar Membro: ${member.name} ${member.is_active ? "(Ativo)" : "(Inativo)"}`,
        actionLabel: "Salvar Alterações",
        formData,
        errors,
        member,
      });
    }
  });

  // DETALHE: Rota POST /members/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/members/delete/:id", requireAuth, requireAdminPage, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const memberId = parseId(req.params.id);
    const member = (await database.getMemberById(memberId));
    if (!member) {
      return notFound(res);
    }

    if (!member.is_active) {
      req.flash("info", `Membro "${member.name}" já está inativo.`);
      return res.redirect(urlFor("list_members"));
    }

    try {
      (await database.deactivateMember(memberId));
      req.flash(
        "success",
        `Membro "${member.name}" desativado com sucesso e removido dos projetos!`,
      );
    } catch (error) {
      logError(req, "Erro ao desativar membro:", error);
      req.flash("danger", `Erro ao desativar membro: ${error.message}`);
    }

    return res.redirect(urlFor("list_members"));
  });
}

module.exports = { registerMemberRoutes };
