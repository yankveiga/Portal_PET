// Isolated regression checks: never connects to the configured database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const nunjucks = require('nunjucks');
const { registerReportRoutes } = require('../src/routes/reports');
const source = fs.readFileSync(path.join(__dirname, '../src/database.js'), 'utf8');
async function main() {
const events = [];
const context = vm.createContext({
  isUserMemberOfProjectName: (id) => id === 10 || id === 11,
  getMemberWarningState: (id) => ({ warning_count: events.filter(e => e.member_id === id).at(-1)?.new_count || 0 }),
  withTransaction: (callback) => callback(context.getDb()),
  getDb: () => ({ prepare: () => ({
    get: (id) => id === 6 || id === 7 ? { id } : null,
    all: (id) => events.filter(e => e.member_id === id).slice().reverse(),
    run: (member_id, actor_user_id, previous_count, new_count, note, event_type, target_event_id, previous_note) => {
      events.push({ id: events.length + 1, member_id, actor_user_id, previous_count, new_count, note, event_type, target_event_id, previous_note });
    },
  }) }),
});
vm.runInContext(source.slice(source.indexOf('async function listMemberWarningEvents('), source.indexOf('async function setMemberWarningCount(')), context);
const mutate = (action, extra = {}) => context.mutateMemberWarning({ memberId: 6, actorUserId: 10, action, ...extra });
await assert.rejects(() => mutate('add', { actorUserId: 1 }), /Administrativo/);
await mutate('add', { note: 'Original' });
const original = { ...events[0] };
await mutate('edit', { warningId: 1, actorUserId: 11, note: 'Revised' });
assert.equal(events[1].previous_note, 'Original');
assert.equal(events[1].actor_user_id, 11);
assert.equal((await context.listMemberWarningEvents(6)).find(e => e.id === 1).current_note, 'Revised');
assert.equal(context.getMemberWarningState(6).warning_count, 1);
await assert.rejects(() => mutate('edit', { memberId: 7, warningId: 1 }), /encontrada/);
await mutate('delete', { warningId: 1 });
assert.equal(events[2].note, 'Revised');
assert.equal(events[2].event_type, 'deleted');
assert.equal(context.getMemberWarningState(6).warning_count, 0);
assert((await context.listMemberWarningEvents(6)).find(e => e.id === 1).is_deleted);
assert.deepEqual(events[0], original);
await assert.rejects(() => mutate('delete', { warningId: 1 }), /excluída/);
await assert.rejects(() => mutate('edit', { warningId: 1 }), /excluída/);
for (let i = 0; i < 3; i++) await mutate('add');
await assert.rejects(() => mutate('add'), /3 advertências/);
await assert.rejects(() => mutate('add', { note: 'x'.repeat(301) }), /300/);

// Direct POSTs cannot bypass membership or CSRF, including users flagged as admins.
let writes = 0;
let csrf = true;
let membership = false;
const routes = {};
registerReportRoutes({
  app: { get() {}, post: (route, auth, handler) => { routes[route] = handler; } },
  ensureValidCsrf: () => csrf, parseId: Number,
  database: {
    isUserMemberOfProjectName: () => membership,
    getMemberById: () => ({ id: 6 }),
    mutateMemberWarning: () => { writes++; return { warning_count: 1, previous_count: 0 }; },
  },
});
const request = { currentUser: { id: 1, is_admin: true }, params: { memberId: 6 }, body: {}, flash() {} };
const response = { redirect() {} };
const handler = routes['/relatorios/warnings/:memberId/update'];
for (const action of ['add', 'edit', 'delete']) {
  request.body.warning_action = action;
  await handler(request, response);
}
assert.equal(writes, 0);
membership = true;
csrf = false;
await handler(request, response);
assert.equal(writes, 0);
csrf = true;
await handler(request, response);
assert.equal(writes, 1);

const env = new nunjucks.Environment(null, { autoescape: true });
for (const filter of ['formatDate', 'formatDateTime']) env.addFilter(filter, v => v || '');
const template = fs.readFileSync(path.join(__dirname, '../app/templates/reports/index.html'), 'utf8').replace('{% extends "base.html" %}', '');
for (const canManageWarnings of [true, false]) {
  const html = env.renderString(template, {
    currentUser: {}, selectedMember: { id: 6, name: 'Member', warning_count: 1 },
    canManageWarnings, warningEvents: [{ id: 1, is_warning: true, current_note: '<script>unsafe</script>' }],
    urlFor: () => '/',
  });
  assert.equal(html.includes('name="warning_action" value="edit"'), canManageWarnings);
  assert.equal(html.includes('name="warning_action" value="delete"'), canManageWarnings);
  assert.equal(html.includes('name="warning_action" value="add"'), canManageWarnings);
  assert(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
}
console.log('OK: warning lifecycle, immutable history, membership, CSRF, rendering and scripts.');

}
main().catch(error => { console.error(error); process.exitCode = 1; });
