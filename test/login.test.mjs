// v2.0: class codes, signed tokens, class management, guests, teacher scoping and the one-off v1.9 -> v2.0 migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { file, d1, freshEnv, oldEnv, call, teacherLogin, SECRETS } from './helpers.mjs';
import { signToken, verifyToken, newClassCode, cleanCode, cleanUser, validUser, suggestUsername, adminCreds, PUPIL_TABLES, purgeGuests } from '../src/login.js';
import { migrationStatements, migrationSql, needsMigration, ensureSchema, resetMigrationState } from '../src/migrate.js';

const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const rows = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));

// ---------------------------------------------------------------- helpers: code, usernames, tokens
test('class codes: 6 characters, no look-alikes, and typed codes are forgiving', () => {
  for (let i = 0; i < 200; i++) assert.match(newClassCode(), CODE_RE);
  assert.equal(cleanCode(' abc-234 '), 'ABC234');
  assert.equal(cleanCode(null), '');
});
test('usernames: lowercase, no spaces, 2-24 safe characters; suggestions avoid clashes', () => {
  assert.equal(cleanUser(' Raj Tan! '), 'rajtan');
  assert.equal(cleanUser("O'Brien"), 'obrien');
  assert.equal(cleanUser('x'.repeat(40)).length, 24);
  assert.equal(validUser('rajt'), true);
  for (const bad of ['', 'a', '.raj', '-raj', 'ra j', 'RAJ', 'x'.repeat(25)]) assert.equal(validUser(bad), false, bad);
  assert.equal(suggestUsername('Raj Tan', new Set()), 'rajt');
  assert.equal(suggestUsername('Raj Tan', new Set(['rajt'])), 'rajt2');
  assert.equal(suggestUsername('Mei', new Set(['mei', 'mei2'])), 'mei3');
  assert.equal(suggestUsername('王', new Set()), 'pupil');
  assert.equal(suggestUsername('Raj Tan Wei', new Set()), 'rajtw');
});
test('secrets: teacher_* win, admin_* still work, and there is no default login', () => {
  assert.deepEqual(adminCreds({ teacher_user: 'a', teacher_password: 'b', admin_user: 'c', admin_password: 'd' }), { user: 'a', pass: 'b' });
  assert.deepEqual(adminCreds({ admin_user: 'c', admin_password: 'd' }), { user: 'c', pass: 'd' });
  assert.equal(adminCreds({}), null);
  assert.equal(adminCreds({ teacher_user: 'a' }), null);
});
test('tokens: signed, expiring, tamper-proof', async () => {
  const env = { ...SECRETS };
  const t = await signToken(env, { r: 'p', pid: 1 }, 60);
  assert.equal((await verifyToken(env, t)).pid, 1);
  assert.equal(await verifyToken(env, t.slice(0, -2) + 'xx'), null);
  assert.equal(await verifyToken(env, await signToken(env, { r: 'p' }, -5)), null, 'expired');
  assert.equal(await verifyToken({ ...SECRETS, teacher_password: 'different' }, t), null, 'another secret');
  assert.equal(await verifyToken(env, 'nonsense'), null);
  assert.equal(await verifyToken(env, 'a'.repeat(5000)), null);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ r: 'a', exp: 9999999999 })).toString('base64url') + '.' + sig;
  assert.equal(await verifyToken(env, forged), null, 'a valid signature does not carry over to a different body');
  assert.ok(body);
});

// ---------------------------------------------------------------- setting up a class
async function classWith(env, names = ['Raj Tan', 'Mei Lin'], className = '4A') {
  const t = await teacherLogin(env);
  const c = (await call(env, 'POST', '/api/admin/classes', { token: t, body: { name: className } })).json.class;
  const prev = (await call(env, 'POST', `/api/admin/classes/${c.id}/pupils/preview`, { token: t, body: { text: names.join('\n') } })).json;
  const add = (await call(env, 'POST', `/api/admin/classes/${c.id}/pupils`, { token: t, body: { pupils: prev.rows } })).json;
  return { t, c, prev: prev.rows, add };
}
const login = (env, code, username, ip) => call(env, 'POST', '/api/login', { body: { code, username }, ip });

test('teacher sign-in: the super admin, the generic failure, and no default password', async () => {
  const { env } = freshEnv();
  assert.ok(await teacherLogin(env));
  const bad = await call(env, 'POST', '/api/admin/login', { body: { user: 'palpatine', password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal((await call(env, 'POST', '/api/admin/login', { body: { user: 'admin123', password: 'password123' } })).status, 401, 'the old default login is gone');
  const legacy = freshEnv({ teacher_user: undefined, teacher_password: undefined, admin_user: 'boss', admin_password: 'old secret' });
  assert.ok(await teacherLogin(legacy.env, 'boss', 'old secret'), 'the v1.9 secret names keep working');
  const none = freshEnv({ teacher_user: undefined, teacher_password: undefined });
  const r = await call(none.env, 'POST', '/api/admin/login', { body: { user: 'admin123', password: 'password123' } });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /teacher_user and teacher_password/);
  const p = await call(none.env, 'GET', '/api/me');
  assert.equal(p.status, 503);
  assert.match(p.json.error, /not set up/);
  assert.equal((await login(none.env, 'ABCDEF', 'raj')).status >= 400, true);
});
test('teacher sign-in lockout: repeated wrong passwords are refused for a while', async () => {
  const { env } = freshEnv();
  let last;
  for (let i = 0; i < 6; i++) last = await call(env, 'POST', '/api/admin/login', { body: { user: 'palpatine', password: 'wrong' + i } });
  assert.equal(last.status, 429);
  assert.equal((await call(env, 'POST', '/api/admin/login', { body: { user: 'palpatine', password: SECRETS.teacher_password } })).status, 429, 'even the right one, while locked');
});

test('a class: create it, add pupils from a pasted list, and they sign in with username + class code', async () => {
  const { env } = freshEnv();
  const { c, prev, add } = await classWith(env);
  assert.match(c.code, CODE_RE);
  assert.deepEqual(prev.map((r) => [r.name, r.username, r.status]), [['Raj Tan', 'rajt', 'ok'], ['Mei Lin', 'meil', 'ok']]);
  assert.equal(add.added, 2);
  const r = await login(env, c.code, 'rajt');
  assert.equal(r.status, 200);
  assert.equal(r.json.username, 'rajt');
  assert.deepEqual(r.json.pupil, { id: r.json.pupil.id, name: 'Raj Tan', className: '4A', guest: false });
  assert.equal((await call(env, 'GET', '/api/me', { token: r.json.token })).status, 200);
  const stories = await call(env, 'GET', '/api/stories', { token: r.json.token });
  assert.equal(stories.status, 200);
  assert.deepEqual(stories.json.assigned, []);
  // forgiving about case, spaces and punctuation in what is typed
  assert.equal((await login(env, ` ${c.code.toLowerCase().slice(0, 3)}-${c.code.slice(3)} `, ' Rajt ')).status, 200);
});
test('sign-in failures all look the same, and a class can’t be probed', async () => {
  const { env } = freshEnv();
  const { c } = await classWith(env);
  const wrongCode = await login(env, newClassCode() === c.code ? 'ZZZZZZ' : 'ZZZZZ2', 'rajt');
  const wrongUser = await login(env, c.code, 'nobody');
  const noInput = await login(env, '', '');
  const shortCode = await login(env, 'AB', 'rajt');
  for (const r of [wrongCode, wrongUser, noInput, shortCode]) assert.equal(r.status, 401);
  assert.equal(new Set([wrongCode, wrongUser, noInput, shortCode].map((r) => r.json.error)).size, 1, 'one message for every failure');
  assert.equal(wrongCode.json.token, undefined);
});
test('usernames are only unique within a class; the same name in two classes works', async () => {
  const { env } = freshEnv();
  const a = await classWith(env, ['Sam'], '4A');
  const b = await classWith(env, ['Sam'], '4B');
  assert.equal(a.prev[0].username, 'sam');
  assert.equal(b.prev[0].username, 'sam');
  const ra = await login(env, a.c.code, 'sam'), rb = await login(env, b.c.code, 'sam');
  assert.equal(ra.json.pupil.className, '4A');
  assert.equal(rb.json.pupil.className, '4B');
  assert.notEqual(ra.json.pupil.id, rb.json.pupil.id);
});
test('rate limits: sign-in and guest creation are throttled per IP when the bindings exist', async () => {
  const seen = [];
  const rl = (ok) => ({ limit: async ({ key }) => (seen.push(key), { success: ok }) });
  const { env } = freshEnv({ RL_LOGIN: rl(false), RL_GUEST: rl(false) });
  const r = await call(env, 'POST', '/api/login', { body: { code: 'ABCDEF', username: 'raj' }, ip: '9.9.9.9' });
  assert.equal(r.status, 429);
  assert.deepEqual(seen, ['9.9.9.9']);
  assert.equal((await call(env, 'POST', '/api/guest')).status, 429);
  assert.equal((await call(env, 'POST', '/api/admin/login', { body: { user: 'a', password: 'b' } })).status, 429);
  const ok = freshEnv({ RL_LOGIN: rl(true), RL_GUEST: rl(true) });
  assert.equal((await call(ok.env, 'POST', '/api/guest')).status, 200);
});

// ---------------------------------------------------------------- signing a class out
test('a new class code can sign the whole class out; without that, existing sign-ins carry on', async () => {
  const { env } = freshEnv();
  const { t, c } = await classWith(env);
  const first = (await login(env, c.code, 'rajt')).json.token;
  const keep = (await call(env, 'POST', `/api/admin/classes/${c.id}/regen`, { token: t, body: {} })).json;
  assert.match(keep.code, CODE_RE);
  assert.notEqual(keep.code, c.code);
  assert.equal(keep.signedOut, false);
  assert.equal((await call(env, 'GET', '/api/me', { token: first })).status, 200, 'still signed in');
  assert.equal((await login(env, c.code, 'rajt')).status, 401, 'but the old code no longer works');
  assert.equal((await login(env, keep.code, 'rajt')).status, 200);
  const out = (await call(env, 'POST', `/api/admin/classes/${c.id}/regen`, { token: t, body: { signOut: true } })).json;
  assert.equal(out.signedOut, true);
  assert.equal((await call(env, 'GET', '/api/me', { token: first })).status, 401, 'signed out');
  assert.equal((await call(env, 'GET', '/api/me', { token: (await login(env, out.code, 'rajt')).json.token })).status, 200);
});
test('archiving a class blocks sign-in and signs everyone out; restoring does not revive old tokens', async () => {
  const { env } = freshEnv();
  const { t, c } = await classWith(env);
  const tok = (await login(env, c.code, 'rajt')).json.token;
  await call(env, 'PATCH', `/api/admin/classes/${c.id}`, { token: t, body: { archived: true } });
  assert.equal((await call(env, 'GET', '/api/me', { token: tok })).status, 401);
  assert.equal((await login(env, c.code, 'rajt')).status, 401);
  const list = (await call(env, 'GET', '/api/admin/classes', { token: t })).json.classes;
  assert.equal(list.find((x) => x.id === c.id).archived, 1);
  await call(env, 'PATCH', `/api/admin/classes/${c.id}`, { token: t, body: { archived: false } });
  assert.equal((await call(env, 'GET', '/api/me', { token: tok })).status, 401, 'the old token stays dead');
  assert.equal((await login(env, c.code, 'rajt')).status, 200);
});
test('pupils can’t use a teacher’s routes, and teacher tokens can’t pose as pupils', async () => {
  const { env } = freshEnv();
  const { t, c } = await classWith(env);
  const pupil = (await login(env, c.code, 'rajt')).json.token;
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: pupil })).status, 401);
  assert.equal((await call(env, 'GET', '/api/admin/summary', { token: pupil })).status, 401);
  assert.equal((await call(env, 'GET', '/api/me', { token: t })).status, 401);
  assert.equal((await call(env, 'GET', '/api/admin/classes')).status, 401);
});

// ---------------------------------------------------------------- guests
test('guest play: numbered guests, no class, no AI helper, and old ones are cleaned up', async () => {
  const { env, db } = freshEnv({ AI_MOCK: 'gemini=met' });
  db.exec("INSERT INTO settings(key,value) VALUES('ai_enabled','1')");
  const g1 = (await call(env, 'POST', '/api/guest')).json, g2 = (await call(env, 'POST', '/api/guest')).json;
  assert.equal(g1.username, 'guest_0001');
  assert.equal(g2.username, 'guest_0002');
  assert.deepEqual(g1.pupil, { id: g1.pupil.id, name: 'guest_0001', className: 'Guest', guest: true });
  assert.equal((await call(env, 'GET', '/api/me', { token: g1.token })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { token: g1.token })).json.pupil.guest, true);
  assert.equal((await call(env, 'GET', '/api/stories', { token: g1.token })).json.assigned.length, 0);
  const story = (await call(env, 'GET', '/api/stories', { token: g1.token })).json.stories[0].id;
  const gRun = (await call(env, 'POST', '/api/run/start', { token: g1.token, body: { story } })).json.run;
  assert.equal((await call(env, 'POST', '/api/run/ai-check', { token: g1.token, body: { run: gRun, rule: 'zzz' } })).status, 403, 'guests never reach the AI helper');
  const { c } = await classWith(env);
  const pupil = (await login(env, c.code, 'rajt')).json.token;
  const pRun = (await call(env, 'POST', '/api/run/start', { token: pupil, body: { story } })).json.run;
  assert.equal((await call(env, 'POST', '/api/run/ai-check', { token: pupil, body: { run: pRun, rule: 'zzz' } })).status, 400, 'a class pupil does (this one fails later, on the unknown rule)');
  // guests can't sign back in
  assert.equal((await login(env, c.code, 'guest_0001')).status, 401);
  // clean-up
  const old = Date.now() - 40 * 86400000;
  db.prepare('UPDATE pupils SET created_at = ? WHERE id = ?').run(old, g1.pupil.id);
  db.prepare("INSERT INTO picks(pupil_id, story, node, idx, r, p) VALUES (?, 's', 'n', 0, 'x', 0)").run(g1.pupil.id);
  db.prepare('INSERT INTO sorts(pupil_id, score, total) VALUES (?, 1, 2)').run(g1.pupil.id);
  await purgeGuests({ ...env, GUEST_RETENTION_DAYS: '30' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE id = ?').get(g1.pupil.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM picks WHERE pupil_id = ?').get(g1.pupil.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE id = ?').get(g2.pupil.id).n, 1, 'a recent guest stays');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE is_guest = 0').get().n, 2, 'class pupils are never touched');
  assert.ok(PUPIL_TABLES.every((t) => db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).all() !== undefined), 'every table listed exists');
});

// ---------------------------------------------------------------- the teacher's class tools
test('previewing a pasted list: suggestions, clashes, invalid names, header rows', async () => {
  const { env } = freshEnv();
  const { t, c } = await classWith(env, ['Raj Tan'], '4A');
  const text = ['Name, Username', 'Raj Tan', 'Rajesh Tiwari', 'Mei Lin, meilin', 'Sam, s', 'Zoe, rajt', 'Ann Lee; annl', '', '   ', 'Bo\tbo.b'].join('\n');
  const r = (await call(env, 'POST', `/api/admin/classes/${c.id}/pupils/preview`, { token: t, body: { text } })).json.rows;
  const by = Object.fromEntries(r.map((x) => [x.name, x]));
  assert.equal(r.find((x) => x.name === 'Name'), undefined, 'header skipped');
  assert.deepEqual([by['Raj Tan'].username, by['Raj Tan'].status], ['rajt2', 'ok'], 'avoids the existing rajt');
  assert.equal(by['Rajesh Tiwari'].username, 'rajesht');
  assert.deepEqual([by['Mei Lin'].username, by['Mei Lin'].status], ['meilin', 'ok']);
  assert.equal(by.Sam.status, 'invalid', 'a one-letter username');
  assert.equal(by.Zoe.status, 'duplicate', 'rajt is taken in this class');
  assert.equal(by['Ann Lee'].username, 'annl');
  assert.equal(by.Bo.username, 'bo.b');
  const big = Array.from({ length: 300 }, (_, i) => 'Pupil Number' + i).join('\n');
  assert.equal((await call(env, 'POST', `/api/admin/classes/${c.id}/pupils/preview`, { token: t, body: { text: big } })).json.rows.length, 200, 'capped at 200');
  assert.deepEqual((await call(env, 'POST', `/api/admin/classes/${c.id}/pupils/preview`, { token: t, body: { text: '' } })).json.rows, []);
});
test('adding pupils skips invalid and duplicate usernames and says so', async () => {
  const { env, db } = freshEnv();
  const { t, c } = await classWith(env, ['Raj Tan'], '4A');
  const r = (await call(env, 'POST', `/api/admin/classes/${c.id}/pupils`, { token: t, body: { pupils: [{ name: 'New One', username: 'newone' }, { name: 'Dupe', username: 'rajt' }, { name: 'Bad', username: 'x' }, { name: '', username: 'noname' }, { name: 'Same Twice', username: 'newone' }] } })).json;
  assert.equal(r.added, 1);
  assert.equal(r.skipped.length, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE class_id = ?').get(c.id).n, 2);
});
test('editing a pupil: name, username, moving class; clashes are refused', async () => {
  const { env, db } = freshEnv();
  const a = await classWith(env, ['Raj Tan', 'Mei Lin'], '4A');
  const b = await classWith(env, ['Raj Wong'], '4B');
  const raj = db.prepare("SELECT id FROM pupils WHERE username = 'rajt'").get().id;
  const mei = db.prepare("SELECT id FROM pupils WHERE username = 'meil'").get().id;
  const p = (id, body) => call(env, 'PATCH', `/api/admin/pupils/${id}`, { token: a.t, body });
  assert.equal((await p(raj, { name: 'Rajan Tan' })).status, 200);
  assert.equal(db.prepare('SELECT name FROM pupils WHERE id = ?').get(raj).name, 'Rajan Tan');
  assert.equal((await p(raj, { username: 'Raj.Tan' })).status, 200);
  assert.equal(db.prepare('SELECT username FROM pupils WHERE id = ?').get(raj).username, 'raj.tan');
  assert.equal((await p(raj, { username: 'meil' })).status, 409);
  assert.equal((await p(raj, { username: 'x' })).status, 400);
  assert.equal((await p(raj, { name: '  ' })).status, 400);
  assert.equal((await p(mei, { class_id: b.c.id })).status, 200, 'the super admin can move a pupil between classes');
  assert.equal(db.prepare('SELECT class_id FROM pupils WHERE id = ?').get(mei).class_id, b.c.id);
  assert.equal((await login(env, b.c.code, 'meil')).status, 200);
  assert.equal((await p(raj, { class_id: b.c.id, username: 'rajw' })).status, 409, 'the username is taken in the class it would move to');
  assert.equal(db.prepare('SELECT class_id FROM pupils WHERE id = ?').get(raj).class_id, a.c.id, 'and nothing was half-changed');
  assert.equal((await p(raj, { class_id: b.c.id })).status, 200);
  assert.equal(db.prepare('SELECT class_id FROM pupils WHERE id = ?').get(raj).class_id, b.c.id);
  assert.equal((await p(999, { name: 'x' })).status, 404);
});
test('resetting a pupil clears their results but keeps the account; deleting removes everything', async () => {
  const { env, db } = freshEnv();
  const { t, c } = await classWith(env, ['Raj Tan', 'Mei Lin']);
  const raj = db.prepare("SELECT id FROM pupils WHERE username = 'rajt'").get().id;
  const mei = db.prepare("SELECT id FROM pupils WHERE username = 'meil'").get().id;
  for (const id of [raj, mei]) {
    db.prepare("INSERT INTO picks(pupil_id, story, node, idx, r, p) VALUES (?, 's', 'n', 0, 'x', 0)").run(id);
    db.prepare("INSERT INTO completions(pupil_id, story, points, perfect) VALUES (?, 's', 5, 1)").run(id);
    db.prepare("INSERT INTO xp_log(pupil_id, xp) VALUES (?, 7)").run(id);
  }
  assert.equal((await call(env, 'POST', `/api/admin/pupils/${raj}/reset`, { token: t })).status, 200);
  for (const tb of ['picks', 'completions', 'xp_log']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tb} WHERE pupil_id = ?`).get(raj).n, 0, tb);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tb} WHERE pupil_id = ?`).get(mei).n, 1, tb + ' of the other pupil');
  }
  assert.equal((await login(env, c.code, 'rajt')).status, 200, 'the account is still there');
  assert.equal((await call(env, 'DELETE', `/api/admin/pupils/${mei}`, { token: t })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM picks WHERE pupil_id = ?').get(mei).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE id = ?').get(mei).n, 0);
  assert.equal((await login(env, c.code, 'meil')).status, 401);
});
test('pupil list shows progress; deleting a class removes its pupils, their results and assignments', async () => {
  const { env, db } = freshEnv();
  const { t, c } = await classWith(env, ['Raj Tan'], '4A');
  const keep = await classWith(env, ['Mei Lin'], '4B');
  const raj = db.prepare("SELECT id FROM pupils WHERE username = 'rajt'").get().id;
  db.prepare("INSERT INTO picks(pupil_id, story, node, idx, r, p) VALUES (?, 's', 'n', 0, 'x', 0)").run(raj);
  db.prepare("INSERT INTO completions(pupil_id, story, points, perfect) VALUES (?, 's', 5, 1)").run(raj);
  db.prepare("INSERT INTO xp_log(pupil_id, xp) VALUES (?, 7)").run(raj);
  await call(env, 'POST', '/api/admin/assign', { token: t, body: { class_id: c.id, story: 'whatever', on: true } });
  const list = (await call(env, 'GET', `/api/admin/classes/${c.id}/pupils`, { token: t })).json.pupils;
  assert.deepEqual([list[0].username, list[0].answers, list[0].stories, list[0].xp], ['rajt', 1, 1, 7]);
  assert.equal((await call(env, 'DELETE', `/api/admin/classes/${c.id}`, { token: t })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM classes WHERE id = ?').get(c.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE class_id = ?').get(c.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM picks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments WHERE class_id = ?').get(c.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE class_id = ?').get(keep.c.id).n, 1, 'other classes untouched');
  assert.equal((await login(env, c.code, 'rajt')).status, 401);
});
test('assigning a story to a class shows up for its pupils (by class, not by name)', async () => {
  const { env } = freshEnv();
  const a = await classWith(env, ['Raj Tan'], '4A');
  const b = await classWith(env, ['Mei Lin'], '4A'); // same name, different class
  const story = Object.keys((await call(env, 'GET', '/api/stories', { token: (await login(env, a.c.code, 'rajt')).json.token })).json.stories.map((s) => s.id)).length ? (await call(env, 'GET', '/api/stories', { token: (await login(env, a.c.code, 'rajt')).json.token })).json.stories[0].id : 'x';
  assert.equal((await call(env, 'POST', '/api/admin/assign', { token: a.t, body: { class_id: a.c.id, story, on: true } })).status, 200);
  const ra = (await login(env, a.c.code, 'rajt')).json.token, rb = (await login(env, b.c.code, 'meil')).json.token;
  assert.deepEqual((await call(env, 'GET', '/api/stories', { token: ra })).json.assigned, [story]);
  assert.deepEqual((await call(env, 'GET', '/api/stories', { token: rb })).json.assigned, [], 'the other class with the same name is separate');
  await call(env, 'POST', '/api/admin/assign', { token: a.t, body: { class_id: a.c.id, story, on: false } });
  assert.deepEqual((await call(env, 'GET', '/api/stories', { token: ra })).json.assigned, []);
});

// ---------------------------------------------------------------- teachers: accounts, scoping, creating classes
async function teacher(env, su, name = 'ms.lee', password = 'a long password') {
  assert.equal((await call(env, 'POST', '/api/admin/teacher-create', { token: su, body: { username: name, password } })).status, 200);
  return teacherLogin(env, name, password);
}
test('a teacher only sees and manages their own classes', async () => {
  const { env } = freshEnv();
  const a = await classWith(env, ['Raj Tan'], '4A');
  const b = await classWith(env, ['Mei Lin'], '4B');
  const tt = await teacher(env, a.t);
  const none = (await call(env, 'GET', '/api/admin/classes', { token: tt })).json;
  assert.deepEqual(none.classes, [], 'no classes yet');
  assert.equal(none.guests, null, 'guests are for the super admin');
  await call(env, 'POST', '/api/admin/teacher-classes', { token: a.t, body: { username: 'ms.lee', classIds: [a.c.id, 9999] } });
  const mine = (await call(env, 'GET', '/api/admin/classes', { token: tt })).json.classes;
  assert.deepEqual(mine.map((c) => c.id), [a.c.id], 'unknown ids ignored');
  assert.equal((await call(env, 'GET', `/api/admin/classes/${b.c.id}/pupils`, { token: tt })).status, 403);
  assert.equal((await call(env, 'PATCH', `/api/admin/classes/${b.c.id}`, { token: tt, body: { name: 'x' } })).status, 403);
  assert.equal((await call(env, 'POST', `/api/admin/classes/${b.c.id}/regen`, { token: tt, body: {} })).status, 403);
  assert.equal((await call(env, 'DELETE', `/api/admin/classes/${b.c.id}`, { token: tt })).status, 403);
  assert.equal((await call(env, 'POST', `/api/admin/classes/${b.c.id}/pupils`, { token: tt, body: { pupils: [{ name: 'X Y', username: 'xy' }] } })).status, 403);
  const raj = (await call(env, 'GET', `/api/admin/classes/${a.c.id}/pupils`, { token: tt })).json.pupils[0].id;
  const mei = (await call(env, 'GET', `/api/admin/classes/${b.c.id}/pupils`, { token: a.t })).json.pupils[0].id;
  assert.equal((await call(env, 'PATCH', `/api/admin/pupils/${raj}`, { token: tt, body: { name: 'Raj T.' } })).status, 200);
  assert.equal((await call(env, 'PATCH', `/api/admin/pupils/${mei}`, { token: tt, body: { name: 'Hacked' } })).status, 404);
  assert.equal((await call(env, 'DELETE', `/api/admin/pupils/${mei}`, { token: tt })).status, 404);
  assert.equal((await call(env, 'POST', `/api/admin/pupils/${mei}/reset`, { token: tt })).status, 404);
  assert.equal((await call(env, 'PATCH', `/api/admin/pupils/${raj}`, { token: tt, body: { class_id: b.c.id } })).status, 403, 'can’t move a pupil into someone else’s class');
  const story = (await call(env, 'GET', '/api/stories', { token: (await call(env, 'POST', '/api/login', { body: { code: a.c.code, username: 'rajt' } })).json.token })).json.stories[0].id;
  assert.equal((await call(env, 'POST', '/api/admin/assign', { token: tt, body: { class_id: b.c.id, story, on: true } })).status, 403);
  const sum = (await call(env, 'GET', '/api/admin/summary', { token: tt })).json;
  assert.deepEqual(sum.pupils.map((p) => p.username), ['rajt']);
  assert.deepEqual(sum.classes.map((c) => c.id), [a.c.id]);
  assert.equal(sum.guests, false);
  assert.equal((await call(env, 'GET', '/api/admin/teachers', { token: tt })).status, 403, 'teacher accounts are the super admin’s');
});
test('teachers can create classes (auto-assigned to them) unless the super admin switches that off', async () => {
  const { env } = freshEnv();
  const su = await teacherLogin(env);
  const tt = await teacher(env, su);
  const made = await call(env, 'POST', '/api/admin/classes', { token: tt, body: { name: '5C' } });
  assert.equal(made.status, 200);
  assert.deepEqual((await call(env, 'GET', '/api/admin/classes', { token: tt })).json.classes.map((c) => c.name), ['5C']);
  assert.equal((await call(env, 'GET', '/api/admin/teachers', { token: su })).json.teachers[0].classIds.length, 1);
  assert.equal((await call(env, 'POST', '/api/admin/class-settings', { token: tt, body: { teacherCreate: false } })).status, 403);
  await call(env, 'POST', '/api/admin/class-settings', { token: su, body: { teacherCreate: false } });
  assert.equal((await call(env, 'POST', '/api/admin/classes', { token: tt, body: { name: '5D' } })).status, 403);
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: tt })).json.canCreate, false);
  assert.equal((await call(env, 'POST', '/api/admin/classes', { token: su, body: { name: '5D' } })).status, 200, 'the super admin still can');
  assert.equal((await call(env, 'POST', '/api/admin/classes', { token: su, body: { name: '  ' } })).status, 400);
});
test('teacher tokens stop working when the password changes, is reset, or the account is deleted', async () => {
  const { env } = freshEnv();
  const su = await teacherLogin(env);
  const tt = await teacher(env, su, 'ms.lee', 'first password');
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: tt })).status, 200);
  const ch = await call(env, 'POST', '/api/admin/change-password', { token: tt, body: { old: 'first password', password: 'second password' } });
  assert.equal(ch.status, 200);
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: tt })).status, 401, 'the old token carried the old password');
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: ch.json.token })).status, 200, 'the fresh token works');
  assert.equal((await call(env, 'POST', '/api/admin/change-password', { token: ch.json.token, body: { old: 'wrong', password: 'whatever long' } })).status, 401);
  await call(env, 'POST', '/api/admin/teacher-reset', { token: su, body: { username: 'ms.lee', password: 'reset password' } });
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: ch.json.token })).status, 401);
  const again = await teacherLogin(env, 'ms.lee', 'reset password');
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: again })).status, 200);
  await call(env, 'POST', '/api/admin/teacher-delete', { token: su, body: { username: 'ms.lee' } });
  assert.equal((await call(env, 'GET', '/api/admin/classes', { token: again })).status, 401);
  assert.equal((await call(env, 'POST', '/api/admin/teacher-create', { token: su, body: { username: 'palpatine', password: 'long enough pw' } })).status, 400, 'a teacher can’t take the super admin’s name');
});
test('the super admin sees every class, the guest count and guests in the pupil list', async () => {
  const { env } = freshEnv();
  const a = await classWith(env, ['Raj Tan'], '4A');
  await classWith(env, ['Mei Lin'], '4B');
  await call(env, 'POST', '/api/guest');
  const list = (await call(env, 'GET', '/api/admin/classes', { token: a.t })).json;
  assert.deepEqual(list.classes.map((c) => c.name), ['4A', '4B']);
  assert.equal(list.guests, 1);
  assert.equal(list.canCreate, true);
  const sum = (await call(env, 'GET', '/api/admin/summary', { token: a.t })).json;
  assert.equal(sum.pupils.length, 3);
  const g = sum.pupils.find((p) => p.username.startsWith('guest_'));
  assert.equal(g.class, '');
  assert.equal(g.class_id, null);
  const named = sum.pupils.find((p) => p.username === 'rajt');
  assert.deepEqual([named.class, named.class_id, named.name], ['4A', a.c.id, 'Raj Tan']);
  assert.equal(sum.guests, true);
  const drill = await call(env, 'GET', `/api/admin/pupil?id=${named.id}`, { token: a.t });
  assert.equal(drill.status, 200);
  assert.equal((await call(env, 'GET', '/api/admin/pupil?id=99999', { token: a.t })).status, 404);
});

// ---------------------------------------------------------------- the v1.9 -> v2.0 migration
import { v19 } from './fixtures.mjs';
test('migration: every pupil keeps their id and all their results; classes, usernames and rights are converted', async () => {
  const { env, db } = oldEnv();
  v19(db);
  assert.equal(await needsMigration(env.DB), true);
  const before = Object.fromEntries(['picks', 'completions', 'xp_log'].map((t) => [t, rows(db, `SELECT pupil_id, COUNT(*) n FROM ${t} GROUP BY pupil_id ORDER BY pupil_id`)]));
  await ensureSchema(env);
  assert.equal(await needsMigration(env.DB), false);
  // progress untouched
  for (const t of Object.keys(before)) assert.deepEqual(rows(db, `SELECT pupil_id, COUNT(*) n FROM ${t} GROUP BY pupil_id ORDER BY pupil_id`), before[t], t);
  assert.equal(db.prepare('SELECT SUM(xp) s FROM xp_log').get().s, 550);
  // classes
  const classes = rows(db, 'SELECT id, name, code, sess_ver, archived FROM classes ORDER BY name');
  assert.deepEqual(classes.map((c) => c.name), ['4A', '4B', '5C', '6Z', 'Unassigned'], 'every name ever used, once, upper-cased; plus Unassigned');
  assert.ok(classes.every((c) => CODE_RE.test(c.code) && c.sess_ver === 1 && c.archived === 0));
  assert.equal(new Set(classes.map((c) => c.code)).size, classes.length, 'codes are unique');
  const cid = Object.fromEntries(classes.map((c) => [c.name, c.id]));
  // pupils: ids kept, class_id, tidy usernames
  const p = Object.fromEntries(rows(db, 'SELECT * FROM pupils').map((x) => [x.id, x]));
  assert.equal(Object.keys(p).length, 10);
  assert.deepEqual([p[1].username, p[1].class_id, p[1].name], ['raj', cid['4A'], 'Raj'], 'lowercased; the display name keeps what it was');
  assert.deepEqual([p[2].username, p[2].class_id], ['mei', cid['4A']], 'class spelling variants are one class');
  assert.deepEqual([p[3].username, p[4].username], ['sam', 'pupil4'], 'two pupils differing by case: the older keeps the name');
  assert.equal(p[5].username, 'samuel');
  assert.equal(p[5].class_id, cid['4A']);
  assert.equal(p[6].username, 'pupil6', 'an apostrophe is not allowed any more');
  assert.equal(p[7].username, 'pupil7', 'too short');
  assert.equal(p[8].username, 'annalee', 'spaces removed');
  assert.deepEqual([p[9].class_id, p[10].class_id], [cid.Unassigned, cid.Unassigned], 'no class, or a blank one');
  assert.ok(Object.values(p).every((x) => validUserOk(x.username)), 'every username is valid under the new rules');
  assert.equal(p[1].created_at, Date.UTC(2025, 2, 1, 9, 0, 0));
  assert.ok(Object.values(p).every((x) => x.is_guest === 0));
  // teacher rights and assignments follow the class ids
  assert.deepEqual(rows(db, 'SELECT teacher_id, class_id FROM teacher_classes ORDER BY teacher_id, class_id'), [{ teacher_id: 1, class_id: cid['4A'] }, { teacher_id: 1, class_id: cid['5C'] }, { teacher_id: 2, class_id: cid['4B'] }].sort((a, b) => a.teacher_id - b.teacher_id || a.class_id - b.class_id));
  assert.deepEqual(rows(db, 'SELECT class_id, story FROM assignments ORDER BY story').map((r) => [r.class_id, r.story]), [[cid['4A'], 'story-one'], [cid['6Z'], 'story-three'], [cid['4B'], 'story-two']], 'class names matched ignoring case');
  // nothing of the old sign-in is left
  const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const gone of ['sessions', 'pupils_old', 'teacher_classes_old', 'assignments_old']) assert.ok(!tables.includes(gone), gone);
  assert.ok(!rows(db, 'PRAGMA table_info(pupils)').some((c) => c.name === 'pin_hash'));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'ai_enabled'").get().value, '1', 'settings untouched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM teachers').get().n, 2, 'teacher accounts untouched');
});
const validUserOk = (u) => /^[a-z0-9][a-z0-9._-]{1,23}$/.test(u);

test('migration: it happens by itself on the first request, and migrated pupils can sign in with their class code', async () => {
  const { env, db } = oldEnv();
  v19(db);
  const t = await teacherLogin(env); // the very first request triggers the upgrade
  assert.ok(t);
  assert.equal(await needsMigration(env.DB), false);
  const classes = (await call(env, 'GET', '/api/admin/classes', { token: t })).json.classes;
  const a = classes.find((c) => c.name === '4A');
  assert.equal(a.pupils, 4, 'Raj, mei, Sam and Anna Lee');
  const r = await login(env, a.code, 'raj');
  assert.equal(r.status, 200);
  assert.equal(r.json.pupil.className, '4A');
  const me = await call(env, 'GET', '/api/me', { token: r.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.xp, 10, 'their old XP is still theirs');
  assert.equal((await login(env, a.code, 'annalee')).status, 200);
  assert.equal((await login(env, a.code, 'pupil4')).status, 401, 'pupil4 is in 4B');
  // old session tokens do not work, and neither does the old PIN login
  assert.equal((await call(env, 'GET', '/api/me', { token: 'tok1' })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { body: { username: 'raj', pin: '1234' } })).status, 401);
  // the summary works on migrated data
  const sum = await call(env, 'GET', '/api/admin/summary', { token: t });
  assert.equal(sum.status, 200);
  assert.equal(sum.json.pupils.length, 10);
  assert.deepEqual(sum.json.assignments.map((x) => x.story).sort(), ['story-one', 'story-three', 'story-two']);
});
test('migration: a fresh v2.0 database, and one that is already migrated, are left alone', async () => {
  const { env, db } = freshEnv();
  assert.equal(await needsMigration(env.DB), false);
  await ensureSchema(env);
  const { c } = await classWith(env);
  const before = rows(db, 'SELECT * FROM pupils');
  resetMigrationState();
  await ensureSchema(env);
  assert.deepEqual(rows(db, 'SELECT * FROM pupils'), before);
  assert.equal(db.prepare('SELECT code FROM classes WHERE id = ?').get(c.id).code, c.code);
  const o = oldEnv();
  v19(o.db);
  await ensureSchema(o.env);
  const snap = rows(o.db, 'SELECT id, class_id, username FROM pupils ORDER BY id');
  resetMigrationState();
  await ensureSchema(o.env);
  assert.deepEqual(rows(o.db, 'SELECT id, class_id, username FROM pupils ORDER BY id'), snap, 'running it again changes nothing');
});
test('migration: if anything goes wrong, nothing changes at all (atomic)', async () => {
  const { env, db } = oldEnv();
  v19(db);
  db.exec('CREATE TABLE pupils_old(x)'); // makes the rename step fail part-way through
  const snap = { pupils: rows(db, 'SELECT * FROM pupils ORDER BY id'), tc: rows(db, 'SELECT * FROM teacher_classes'), asg: rows(db, 'SELECT * FROM assignments'), sessions: rows(db, 'SELECT * FROM sessions') };
  await assert.rejects(ensureSchema(env));
  assert.deepEqual(rows(db, 'SELECT * FROM pupils ORDER BY id'), snap.pupils);
  assert.deepEqual(rows(db, 'SELECT * FROM teacher_classes'), snap.tc);
  assert.deepEqual(rows(db, 'SELECT * FROM assignments'), snap.asg);
  assert.deepEqual(rows(db, 'SELECT * FROM sessions'), snap.sessions);
  assert.equal(rows(db, "SELECT name FROM sqlite_master WHERE name = 'classes'").length, 0, 'not even the new tables were left behind');
  assert.equal(await needsMigration(env.DB), true, 'so it can be tried again');
  db.exec('DROP TABLE pupils_old');
  await ensureSchema(env); // the failed attempt is not remembered
  assert.equal(await needsMigration(env.DB), false);
});
test('migration: the schema.sql the deploy runs first is harmless on a v1.9 database, and again afterwards', async () => {
  const { env, db } = oldEnv();
  v19(db);
  db.exec(file('schema.sql')); // the GitHub Action does this before the new Worker goes live
  assert.equal(await needsMigration(env.DB), true, 'still the old shape: the Worker upgrades it');
  await ensureSchema(env);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils').get().n, 10);
  assert.doesNotThrow(() => db.exec(file('schema.sql')), 'and on the next deploy');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils').get().n, 10);
});
test('migration: the standalone migrate-v2.0.sql is the same upgrade', () => {
  assert.equal(file('migrate-v2.0.sql'), migrationSql(), 'the committed file is generated from src/migrate.js');
  const db = new DatabaseSync(':memory:');
  db.exec(file('test/schema-v1.9.sql'));
  v19(db);
  db.exec(file('migrate-v2.0.sql'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils').get().n, 10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM classes').get().n, 5);
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(file('schema.sql'));
  const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).sort();
  for (const t of ['pupils', 'classes', 'teacher_classes', 'assignments']) assert.deepEqual(cols(db, t), cols(fresh, t), t);
  assert.equal(migrationStatements(1).length, migrationStatements(2).length);
});
test('migration: a larger school (300 pupils, messy names) converts quickly and completely', async () => {
  const { env, db } = oldEnv();
  const ins = db.prepare("INSERT INTO pupils(username, class, pin_hash) VALUES (?, ?, 'h')");
  for (let i = 0; i < 300; i++) ins.run(i % 7 === 0 ? `Pupil ${i}!` : i % 5 === 0 ? `P${i}` : `p${i}`, ['1A', '1B', '2A', '2b ', '3C', '', null][i % 7]);
  const t0 = Date.now();
  await ensureSchema(env);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils').get().n, 300);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT class_id || ':' || username) n FROM pupils").get().n, 300, 'every (class, username) is unique');
  assert.ok(rows(db, 'SELECT username FROM pupils').every((r) => validUserOk(r.username)));
});
