/*
 * ARQUIVO: src/routes/chat.js
 * FUNCAO: rotas do chat privado entre usuarios.
 */
function registerChatRoutes(ctx) {
  const {
    app,
    database,
    render,
    requireAuth,
    ensureValidCsrf,
    parseId,
    urlFor,
    notificationService,
    logError,
    invalidateUnreadChatConversationCache,
  } = ctx;

  async function renderInbox(req, res, data = {}) {
    const selectedConversationId = parseId(data.selectedConversationId || req.params.id);
    if (
      selectedConversationId
      && (await database.isChatConversationParticipant(selectedConversationId, req.currentUser.id))
    ) {
      (await database.markChatConversationAsRead(selectedConversationId, req.currentUser.id));
      invalidateUnreadChatConversationCache?.(req.currentUser.id);
    }

    const conversations = (await database.listChatConversationsForUser(req.currentUser.id));
    const selectedConversation = selectedConversationId
      ? conversations.find((item) => item.id === selectedConversationId) || null
      : null;

    const canAccessSelected = Boolean(selectedConversation);

    const selectedParticipants = canAccessSelected
      ? (await database.listChatConversationParticipants(selectedConversation.id))
      : [];
    const selectedParticipantsLabel = selectedParticipants
      .map((participant) => participant.name)
      .join(", ");
    const selectedMessages = canAccessSelected
      ? (await database.listChatMessagesForConversation(selectedConversation.id))
      : [];

    res.locals.unreadMessageConversations = (await database.countUnreadChatConversationsForUser(
      req.currentUser.id,
    ));

    return render(res, "chat/index.html", {
      title: "Caixa de Mensagens",
      activeSection: "messages",
      conversations,
      users: (await database.listUsers()),
      selectedConversation,
      selectedParticipants,
      selectedParticipantsLabel,
      selectedMessages,
      conversationFormData: {
        participantId: "",
        ...(data.conversationFormData || {}),
      },
      conversationErrors: data.conversationErrors || {},
      messageFormData: {
        text: "",
        ...(data.messageFormData || {}),
      },
      messageErrors: data.messageErrors || {},
      tutorPrivateEntries: req.currentUser.role === "tutor"
        ? (await database.listWritingTutorPrivateEntries(req.currentUser.id))
        : [],
    });
  }

  app.get("/mensagens", requireAuth, async (req, res) => {
    return (await renderInbox(req, res));
  });

  app.get("/mensagens/conversas/:id", requireAuth, async (req, res) => {
    const conversationId = parseId(req.params.id);
    if (!conversationId) {
      req.flash("warning", "Conversa inválida.");
      return res.redirect(urlFor("messages_home"));
    }

    if (!(await database.isChatConversationParticipant(conversationId, req.currentUser.id))) {
      req.flash("warning", "Você não tem acesso a esta conversa.");
      return res.redirect(urlFor("messages_home"));
    }

    return (await renderInbox(req, res, { selectedConversationId: conversationId }));
  });

  app.get("/mensagens/unread-summary", requireAuth, async (req, res) => {
    const openConversationId = parseId(req.query.open_conversation_id);
    if (
      openConversationId
      && (await database.isChatConversationParticipant(openConversationId, req.currentUser.id))
    ) {
      (await database.markChatConversationAsRead(openConversationId, req.currentUser.id));
      invalidateUnreadChatConversationCache?.(req.currentUser.id);
    }

    const unreadTotal = (await database.countUnreadChatConversationsForUser(req.currentUser.id));
    const unreadByConversation = {};
    (await database.listUnreadChatConversationCountsForUser(req.currentUser.id)).forEach((item) => {
      unreadByConversation[String(item.conversation_id)] = item.unread_count;
    });

    return res.json({
      ok: true,
      total: unreadTotal,
      byConversation: unreadByConversation,
    });
  });

  app.post("/mensagens/conversas/create", requireAuth, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const conversationFormData = {
      participantId: String(req.body.participant_id || "").trim(),
    };
    const conversationErrors = {};

    const otherUserId = parseId(conversationFormData.participantId);
    if (!otherUserId || Number(otherUserId) === Number(req.currentUser.id)) {
      conversationErrors.participantId = ["Selecione uma pessoa válida para conversar."];
    }

    if (Object.keys(conversationErrors).length) {
      return (await renderInbox(req, res, { conversationFormData, conversationErrors }));
    }

    try {
      const created = (await database.createChatConversation({
        title: null,
        createdByUserId: req.currentUser.id,
        participantUserIds: [req.currentUser.id, otherUserId],
      }));
      req.flash("success", "Conversa criada com sucesso.");
      return res.redirect(urlFor("message_conversation", { id: created.id }));
    } catch (error) {
      conversationErrors.form = [error.message || "Erro ao criar conversa."];
      return (await renderInbox(req, res, { conversationFormData, conversationErrors }));
    }
  });

  app.post("/mensagens/conversas/:id/mensagens/create", requireAuth, async (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const conversationId = parseId(req.params.id);
    if (!conversationId) {
      req.flash("warning", "Conversa inválida.");
      return res.redirect(urlFor("messages_home"));
    }

    if (!(await database.isChatConversationParticipant(conversationId, req.currentUser.id))) {
      req.flash("warning", "Você não tem acesso a esta conversa.");
      return res.redirect(urlFor("messages_home"));
    }
    const conversation = (await database.getChatConversationById(conversationId));
    if (conversation?.is_read_only && Number(conversation.created_by_user_id) !== Number(req.currentUser.id)) {
      req.flash("warning", "Esta conversa é somente para recebimento.");
      return res.redirect(urlFor("message_conversation", { id: conversationId }));
    }

    const messageFormData = {
      text: String(req.body.text || "").trim(),
    };
    const messageErrors = {};
    if (!messageFormData.text) {
      messageErrors.text = ["Digite uma mensagem antes de enviar."];
    } else if (messageFormData.text.length > 10000) {
      messageErrors.text = ["A mensagem deve ter no máximo 10000 caracteres."];
    }

    if (Object.keys(messageErrors).length) {
      return (await renderInbox(req, res, {
        selectedConversationId: conversationId,
        messageFormData,
        messageErrors,
      }));
    }

    try {
      const createdMessage = (await database.createChatMessage({
        conversationId,
        authorUserId: req.currentUser.id,
        text: messageFormData.text,
      }));
      (await database.listChatConversationParticipants(conversationId)).forEach((participant) => {
        invalidateUnreadChatConversationCache?.(participant.id);
      });
      if (notificationService) {
        (await notificationService.sendChatNewMessageNotification({
          conversationId,
          messageText: createdMessage?.text || messageFormData.text,
          authorUserId: req.currentUser.id,
          sentAt: createdMessage?.sent_at || null,
        })).catch((error) => {
          logError(req, "Erro ao enviar notificação por e-mail de nova mensagem:", error);
        });
      }
      return res.redirect(urlFor("message_conversation", { id: conversationId }));
    } catch (error) {
      messageErrors.form = [error.message || "Erro ao enviar mensagem."];
      return (await renderInbox(req, res, {
        selectedConversationId: conversationId,
        messageFormData,
        messageErrors,
      }));
    }
  });
}

module.exports = { registerChatRoutes };
