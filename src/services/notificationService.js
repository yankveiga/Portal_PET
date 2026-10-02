/*
 * ARQUIVO: src/services/notificationService.js
 * FUNCAO: notificacoes externas por e-mail (chat e lembretes de prazo).
 */
const { createEmailService } = require("./emailService");

const DEFAULT_TIMEZONE = "America/Sao_Paulo";

function datePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const valueByType = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== "literal") {
      valueByType[part.type] = part.value;
    }
  });
  return {
    year: Number(valueByType.year),
    month: Number(valueByType.month),
    day: Number(valueByType.day),
    hour: Number(valueByType.hour),
    minute: Number(valueByType.minute),
  };
}

function toDateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function toDateTimePtBr(sqlDateTime) {
  const raw = String(sqlDateTime || "").trim();
  if (!raw) {
    return "sem horário";
  }
  const datePart = raw.slice(0, 10);
  const timePart = raw.slice(11, 16) || "00:00";
  const [year, month, day] = datePart.split("-");
  if (!year || !month || !day) {
    return raw;
  }
  return `${day}/${month}/${year} ${timePart}`;
}

function nextDayParts(now, timeZone) {
  const ahead = new Date(now.getTime() + (24 * 60 * 60 * 1000));
  return datePartsInTimeZone(ahead, timeZone);
}

function isFortnightDeadlineDay(parts) {
  return parts.day === 1 || parts.day === 16;
}

function formatUserLabel(user) {
  return user?.name || user?.username || "Usuário";
}

function trimMessagePreview(text, maxLength = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function createNotificationService({ database, config, logger = console }) {
  const emailService = createEmailService(config);
  const baseUrl = String(config?.appBaseUrl || "http://localhost:3000").replace(/\/+$/, "");
  const timeZone = String(config?.reportsTimeZone || config?.appTimeZone || DEFAULT_TIMEZONE).trim()
    || DEFAULT_TIMEZONE;

  async function sendChatNewMessageNotification({
    conversationId,
    messageText,
    authorUserId,
    sentAt,
  }) {
    if (!emailService.enabled) {
      logger.warn?.("[notify] Chat e-mail desativado: provider/chave/remetente invalidos.");
      return { sent: 0, skipped: "email_disabled" };
    }

    const author = (await database.getUserById(authorUserId));
    const participants = (await database.listChatConversationParticipants(conversationId)) || [];
    let sent = 0;

    for (const participant of participants) {
      if (!participant?.id || Number(participant.id) === Number(authorUserId)) {
        continue;
      }

      const targetUser = (await database.getUserById(participant.id));
      const email = emailService.normalizeEmail(targetUser?.email);
      if (!email) {
        logger.info?.(
          `[notify] Chat e-mail pulado: destinatario sem e-mail (user_id=${participant.id}).`,
        );
        continue;
      }

      const text = [
        `Olá, ${formatUserLabel(targetUser)}!`,
        "",
        `${formatUserLabel(author)} enviou uma nova mensagem para você no chat.`,
        "",
        `Mensagem: ${trimMessagePreview(messageText)}`,
        `Enviada em: ${toDateTimePtBr(sentAt)}`,
        "",
        `Abrir conversa: ${baseUrl}/mensagens/conversas/${conversationId}`,
      ].join("\n");

      const result = await emailService.sendEmail({
        to: email,
        subject: "Nova mensagem no chat",
        text,
      });
      if (result.ok) {
        sent += 1;
      } else {
        logger.warn?.(
          `[notify] Chat e-mail pulado para ${email}: ${result.reason || "motivo_desconhecido"}.`,
        );
      }
    }

    logger.info?.(`[notify] Chat e-mail: enviados=${sent} conversa=${conversationId}`);
    return { sent };
  }

  async function runDeadlineSweep({ now = new Date() } = {}) {
    if (!emailService.enabled) {
      return { sent: 0, skipped: "email_disabled" };
    }

    const tomorrow = nextDayParts(now, timeZone);
    const tomorrowDateKey = toDateKey(tomorrow);
    let sent = 0;

    const dueTasks = (await database.listPlannerTasksDueOnDateForEmail(tomorrowDateKey, { limit: 2000 }));
    for (const task of dueTasks) {
      const recipientEmail = emailService.normalizeEmail(task?.recipient_email);
      if (!recipientEmail || !task?.recipient_user_id) {
        continue;
      }

      const referenceKey = `planner_task_due_1d:${task.id}:${tomorrowDateKey}`;
      const canSend = (await database.registerNotificationEmailDelivery({
        kind: "planner_task_due_1d",
        recipientUserId: task.recipient_user_id,
        referenceKey,
        payloadJson: JSON.stringify({
          task_id: task.id,
          due_at: task.due_at,
          project_id: task.project_id,
        }),
      }));
      if (!canSend) {
        continue;
      }

      const text = [
        `Olá, ${task.recipient_name || "usuário"}!`,
        "",
        "Lembrete: uma tarefa sua vence amanhã.",
        "",
        `Projeto: ${task.project_name || "Sem projeto"}`,
        `Tarefa: ${task.title || "Sem título"}`,
        `Prazo: ${toDateTimePtBr(task.due_at)}`,
        "",
        `Abrir Planner: ${baseUrl}/planner`,
      ].join("\n");

      const result = await emailService.sendEmail({
        to: recipientEmail,
        subject: "Lembrete: tarefa vence amanhã",
        text,
      });
      if (result.ok) {
        sent += 1;
      }
    }

    if (isFortnightDeadlineDay(tomorrow)) {
      const recipients = (await database.listUsersForFortnightReportDeadlineReminder());
      for (const user of recipients) {
        const email = emailService.normalizeEmail(user?.email);
        if (!email || !user?.id) {
          continue;
        }

        const referenceKey = `report_fortnight_due_1d:${tomorrowDateKey}`;
        const canSend = (await database.registerNotificationEmailDelivery({
          kind: "report_fortnight_due_1d",
          recipientUserId: user.id,
          referenceKey,
          payloadJson: JSON.stringify({
            deadline_date: tomorrowDateKey,
          }),
        }));
        if (!canSend) {
          continue;
        }

        const text = [
          `Olá, ${formatUserLabel(user)}!`,
          "",
          "Lembrete: o prazo da quinzena para relatórios encerra amanhã.",
          "",
          `Prazo final: ${tomorrowDateKey.split("-").reverse().join("/")}`,
          "",
          `Abrir Relatórios: ${baseUrl}/relatorios`,
        ].join("\n");

        const result = await emailService.sendEmail({
          to: email,
          subject: "Lembrete: prazo do relatório encerra amanhã",
          text,
        });
        if (result.ok) {
          sent += 1;
        }
      }
    }

    return { sent, tomorrowDateKey };
  }

  let intervalHandle = null;
  let running = false;

  async function startDeadlineScheduler({
    intervalMs = 5 * 60 * 1000,
    runOnStart = true,
  } = {}) {
    if (intervalHandle) {
      return intervalHandle;
    }
    if (!emailService.enabled) {
      logger.info?.("[notify] E-mail desativado. Scheduler de notificações não iniciado.");
      return null;
    }

    const runSweepSafely = async () => {
      if (running) {
        return;
      }
      running = true;
      try {
        const result = await runDeadlineSweep();
        if (result?.sent) {
          logger.info?.(`[notify] Notificações enviadas: ${result.sent}`);
        }
      } catch (error) {
        logger.error?.("[notify] Erro no sweep de notificações:", error);
      } finally {
        running = false;
      }
    };

    if (runOnStart) {
      (await runSweepSafely());
    }
    intervalHandle = setInterval(runSweepSafely, Math.max(30_000, Number(intervalMs || 0)));
    if (typeof intervalHandle.unref === "function") {
      intervalHandle.unref();
    }
    return intervalHandle;
  }

  return {
    sendChatNewMessageNotification,
    runDeadlineSweep,
    startDeadlineScheduler,
  };
}

module.exports = { createNotificationService };
