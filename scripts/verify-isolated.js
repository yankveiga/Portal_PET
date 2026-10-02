const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
process.env.NODE_ENV = "test";
require("../src/config");
const { Client } = require("pg");

async function main() {
  const schema = `verify_async_${randomBytes(8).toString("hex")}`;
  const target = new URL(process.env.DATABASE_URL);
  target.hostname = target.hostname.replace(/-pooler(?=\.)/, "");
  const connectionString = target.toString();
  process.env.DATABASE_URL = connectionString;
  const admin = new Client({ connectionString, ssl: connectionString?.includes("sslmode=") ? undefined : { rejectUnauthorized: false } });
  await admin.connect();
  let server;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    process.env.PGOPTIONS = `-c search_path=${schema} -c timezone=America/Sao_Paulo`;
    process.env.PORTAL_TEST_SCHEMA = schema;
    process.env.NODE_ENV = "test";
    const database = require("../src/database");
    const postgres = require("../src/postgres");
    await database.ensureSchema();
    const member = await database.createMember("Membro de teste isolado");
    const project = await database.createProject({ name: "Projeto isolado", memberIds: [member.id] });
    await database.createAta({ projectId: project.id, meetingDateTime: "2026-09-01 12:00:00", notes: "Ata inicial de teste isolado", presentMemberIds: [member.id], justifications: {} });
    const child = spawn(process.execPath, ["scripts/verify-app.js"], { env: process.env, stdio: "inherit" });
    const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(exit, 0, "Verificacao funcional falhou");

    await assert.rejects(postgres.withTransaction(async () => {
      await database.createMember("rollback-verification");
      throw new Error("rollback esperado");
    }), /rollback esperado/);
    assert.equal(await database.getMemberByName("rollback-verification"), null);

    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 25);
    await postgres.query("SELECT pg_sleep(0.15)");
    clearTimeout(timer);
    assert.equal(timerRan, true, "Consulta nao pode bloquear event loop");

    const bcrypt = require("bcryptjs");
    const adminUser = await database.createUser("isolated_admin", await bcrypt.hash("isolated-password", 4), { name: "Admin isolado", role: "admin", memberId: member.id });
    const common = await database.createUser("isolated_common", await bcrypt.hash("isolated-password", 4), { role: "common" });
    const item = await database.createInventoryItem({ name: "Concorrencia", quantity: 1, description: "Teste", itemType: "stock" });
    const withdrawals = await Promise.all([1, 2].map(() => database.withdrawInventoryItem({ nameOrCode: String(item.id), quantity: 1, userId: adminUser.id })));
    assert.equal(withdrawals.filter(result => result.success).length, 1);
    assert.equal((await database.getInventoryItemById(item.id)).amount, 0);

    await database.createProject({ name: "Administrativo", memberIds: [member.id] });
    await assert.rejects(database.mutateMemberWarning({ memberId: member.id, actorUserId: common.id, action: "add" }), /Administrativo/);
    const warnings = await Promise.allSettled([1, 2, 3, 4].map(() => database.mutateMemberWarning({ memberId: member.id, actorUserId: adminUser.id, action: "add", note: "Isolado" })));
    assert.equal(warnings.filter(result => result.status === "fulfilled").length, 3);
    assert.equal((await database.getMemberWarningState(member.id)).warning_count, 3);

    const task = await database.createPlannerTask({ projectId: project.id, assignedMemberId: member.id, createdByUserId: adminUser.id, title: "Tarefa isolada", dueAt: "2026-10-10 12:00:00" });
    await database.syncReportWeekGoalFromPlannerTask(task, { createdByUserId: adminUser.id });
    assert.ok(await database.getReportWeekGoalByPlannerTaskId(task.id));
    await database.updatePlannerTaskCompletion({ id: task.id, isCompleted: true, actorUserId: adminUser.id });
    assert.equal((await database.getPlannerTaskById(task.id)).is_completed, true);
    assert.equal(database.isReportDueOverdue("2026-06-15 12:00:00", "2026-06-15 23:59:59"), false);
    assert.equal(database.isReportDueOverdue("2026-06-15 12:00:00", "2026-06-16 00:00:00"), true);
    assert.equal(database.isReportDueOverdue("2026-06-30 12:00:00", "2026-06-30 23:59:59"), false);
    assert.equal(database.isReportDueOverdue("2026-06-30 12:00:00", "2026-07-01 00:00:00"), true);
    const missedTask = await database.createPlannerTask({ projectId: project.id, assignedMemberId: member.id, createdByUserId: adminUser.id, title: "Relatorio sem entrega", dueAt: "2026-06-30 12:00:00" });
    await database.syncReportWeekGoalFromPlannerTask(missedTask, { createdByUserId: adminUser.id });
    await database.refreshPlannerTaskLifecycle({ now: new Date("2026-07-01T03:00:00Z"), graceDays: 0 });
    assert.equal((await database.getPlannerTaskById(missedTask.id)).workflow_state, "missed");
    const missedGoal = await database.getReportWeekGoalByPlannerTaskId(missedTask.id);
    assert.equal(missedGoal.task_state, "missed");
    assert.equal(missedGoal.description, "Relatório não foi entregue nessa quinzena");
    const directGoal = await database.createReportWeekGoal({ memberId: member.id, projectId: project.id, createdByUserId: adminUser.id, weekStart: "2026-06-01", dueAt: "2026-06-15 12:00:00", activity: "Meta direta sem entrega" });
    await database.refreshPlannerTaskLifecycle({ now: new Date("2026-06-16T03:00:00Z"), graceDays: 0 });
    assert.equal((await database.getReportWeekGoalById(directGoal.id)).description, "Relatório não foi entregue nessa quinzena");

    const conversation = await database.createChatConversation({ createdByUserId: adminUser.id, participantUserIds: [common.id] });
    await database.createChatMessage({ conversationId: conversation.id, authorUserId: adminUser.id, text: "Mensagem isolada" });
    assert.equal((await database.listChatMessagesForConversation(conversation.id)).length, 1);
    const event = await database.createEvent({ name: "Evento isolado" });
    const attendee = await database.createAttendee({ name: "Ouvinte isolado", badgeCode: "isolated-badge" });
    await database.attachAttendeeToEvent({ eventId: event.id, attendeeId: attendee.id });
    assert.equal((await database.registerEventAttendance({ eventId: event.id, badgeCode: "isolated-badge", checkedInByUserId: adminUser.id })).success, true);
    assert.equal((await database.registerEventAttendance({ eventId: event.id, badgeCode: "isolated-badge", checkedInByUserId: adminUser.id })).success, false);
    await database.upsertReportFortnightMemberNote({ memberId: member.id, authorUserId: adminUser.id, weekStart: "2026-10-01", content: "Complemento de teste" });
    assert.equal((await database.getReportFortnightMemberNote({ memberId: member.id, weekStart: "2026-10-01" })).content, "Complemento de teste");
    const { generateMonthlyReportPdf } = require("../src/pdf");
    const monthlyPdf = await generateMonthlyReportPdf({
      member,
      monthKey: "2026-10",
      goals: await database.listReportMonthGoalsForMember(member.id, { monthKey: "2026-10" }),
      memberFortnightNotes: await database.listReportMonthMemberNotesForPdf(member.id, { monthKey: "2026-10" }),
      generatedByName: "Verificacao isolada",
    });
    assert.ok(Buffer.isBuffer(monthlyPdf), "PDF mensal nao foi gerado como Buffer.");
    assert.ok(monthlyPdf.length > 1000, "PDF mensal gerado parece invalido.");
    const { createApp } = require("../src/app");
    const app = await createApp();
    server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const cookies = new Map();
    async function request(path, options = {}) {
      const response = await fetch(origin + path, { ...options, redirect: "manual", headers: { ...options.headers, cookie: [...cookies].map(([k,v])=>`${k}=${v}`).join("; ") } });
      for (const cookie of response.headers.getSetCookie()) { const entry = cookie.split(";")[0]; const split = entry.indexOf("="); cookies.set(entry.slice(0,split),entry.slice(split+1)); }
      return response;
    }
    const login = await request("/login");
    const html = await login.text();
    const csrf = html.match(/name="csrf_token"[^>]*value="([^"]+)"/)?.[1];
    assert.ok(csrf, "Token CSRF ausente");
    const loggedIn = await request("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "isolated_admin", password: "isolated-password", csrf_token: csrf }) });
    assert.equal(loggedIn.status, 302);
    for (const path of ["/home", "/members", "/projects", "/planner", "/relatorios", "/almoxarifado", "/almoxarifado?tab=manage", "/almoxarifado/api/dashboard", "/manutencao-usuarios", "/mensagens", "/presenca/eventos", "/presenca/ouvintes", "/espacos-escrita"]) {
      const response = await request(path);
      const content = await response.text();
      assert.equal(response.status, 200, `${path}: ${content.slice(0,180)}`);
      assert.ok(!content.includes("[object Promise]"), `${path}: Promise no HTML`);
    }
    console.log("Transacoes, event loop e paginas autenticadas: OK");
  } finally {
    if (server) await new Promise(resolve=>server.close(resolve));
    await require("../src/postgres").closePool();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    console.log("Schema temporario removido.");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
