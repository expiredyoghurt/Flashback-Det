// The two pages, run in a simulated browser (jsdom) against the real Worker and a real SQLite database.
// Skipped automatically when jsdom is not installed (`npm i -D jsdom` to run it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { freshEnv, SECRETS } from './helpers.mjs';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch {}
const maybe = JSDOM ? test : test.skip;

const page = (name) => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function open(name, env, { confirms = [], prompts = [] } = {}) {
  const dialogs = [];
  const dom = new JSDOM(page(name), {
    url: 'https://flashback.test/' + name, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (url, opts = {}) => worker.fetch(new Request(new URL(url, 'https://flashback.test/'), { ...opts, headers: { ...(opts.headers || {}), 'cf-connecting-ip': '3.3.3.3' } }), env);
      w.alert = (m) => dialogs.push(['alert', m]);
      w.confirm = (m) => { dialogs.push(['confirm', m]); return confirms.length ? confirms.shift() : true; };
      w.prompt = (m) => { dialogs.push(['prompt', m]); return prompts.length ? prompts.shift() : null; };
      w.print = () => dialogs.push(['print', w.document.body.className]);
    },
  });
  await tick();
  return { w: dom.window, d: dom.window.document, dialogs };
}
const $ = (ui, id) => ui.d.getElementById(id);
const ev = (ui, code) => ui.w.eval(code); // page-level const/let are not window properties

maybe('teacher dashboard: log in, create a class, add pupils from a list, print cards, manage a pupil', async () => {
  const { env, db } = freshEnv();
  const ui = await open('teacher.html', env, { prompts: [], confirms: [true] });
  $(ui, 'u').value = SECRETS.teacher_user; $(ui, 'p').value = 'wrong';
  await ev(ui, `go()`); await tick();
  assert.match($(ui, 'e').textContent, /Wrong teacher login/);
  $(ui, 'p').value = SECRETS.teacher_password;
  await ev(ui, `go()`); await tick(60);
  assert.ok($(ui, 'cc'), 'the Classes panel is on the dashboard');
  assert.match($(ui, 'cc').textContent, /username and the class code/);
  assert.doesNotMatch(ui.d.body.textContent, /Reset PIN|new PIN|PIN \(/, 'no PIN tools on the dashboard');
  // create a class
  $(ui, 'cn').value = '4A';
  await ev(ui, `ccNew()`); await tick(60);
  const code = $(ui, 'cc').querySelector('h3 .code').textContent;
  assert.match(code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
  assert.equal(db.prepare('SELECT code FROM classes').get().code, code);
  // paste a list, check it, add it
  $(ui, 'pvt').value = 'Raj Tan\nMei Lin, meilin\nRaj Tan';
  const id = db.prepare('SELECT id FROM classes').get().id;
  await ev(ui, `pvCheck(${id})`); await tick(60);
  const rows = [...$(ui, 'cc').querySelectorAll('input[id^=pvu]')].map((i) => i.value);
  assert.deepEqual(rows, ['rajt', 'meilin', 'rajt2']);
  assert.match($(ui, 'cc').textContent, /new pupil/);
  assert.match($(ui, 'cc').textContent, /Add 3 pupils/);
  $(ui, 'pvu2').value = 'tanr'; // fix a username by hand
  await ev(ui, `pvAdd(${id})`); await tick(80);
  assert.deepEqual(db.prepare('SELECT username FROM pupils ORDER BY id').all().map((r) => r.username), ['rajt', 'meilin', 'tanr']);
  assert.match($(ui, 'cc').textContent, /Added 3 pupils/);
  assert.equal($(ui, 'cc').querySelectorAll('input[id^=pn]').length, 3, 'the pupil table is editable');
  // login cards
  await ev(ui, `printCards(${id})`);
  const sheet = $(ui, 'sheet').innerHTML;
  assert.ok(ui.dialogs.some((x) => x[0] === 'print' && /printing/.test(x[1])));
  assert.ok(sheet.includes(code) && sheet.includes('rajt') && sheet.includes('Mei Lin') && sheet.includes('flashback.test'));
  await tick(500);
  assert.equal(ui.d.body.classList.contains('printing'), false, 'print mode is switched off again');
  // edit, reset and delete a pupil
  const raj = db.prepare("SELECT id FROM pupils WHERE username = 'rajt'").get().id;
  db.prepare("INSERT INTO xp_log(pupil_id, xp) VALUES (?, 9)").run(raj);
  $(ui, 'pn' + raj).value = 'Rajan Tan'; $(ui, 'pu' + raj).value = 'rajan';
  await ev(ui, `pupSave(${raj})`); await tick(80);
  assert.deepEqual({ ...db.prepare('SELECT name, username FROM pupils WHERE id = ?').get(raj) }, { name: 'Rajan Tan', username: 'rajan' });
  await ev(ui, `pupReset(${raj})`); await tick(80);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM xp_log WHERE pupil_id = ?').get(raj).n, 0);
  await ev(ui, `pupDel(${raj})`); await tick(80);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE id = ?').get(raj).n, 0);
  // the class filter and the pupil table work by class id; no pupil is lost from the list
  assert.equal(ev(ui, 'S.pupils.length'), 2);
  assert.equal(ev(ui, 'S.classes[0].id'), id);
  ev(ui, `F = '${id}'; draw()`);
  assert.match(ui.d.body.textContent, /Mei Lin/);
  // new code with sign-out, then archive
  const tokBefore = await (await worker.fetch(new Request('https://flashback.test/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, username: 'meilin' }) }), env)).json();
  await ev(ui, `ccRegen(${id})`); await tick(80); // both confirms answered "OK": new code + sign everyone out
  const code2 = db.prepare('SELECT code FROM classes').get().code;
  assert.notEqual(code2, code);
  assert.match($(ui, 'cmsg').textContent, new RegExp(code2));
  assert.equal((await worker.fetch(new Request('https://flashback.test/api/me', { headers: { authorization: 'Bearer ' + tokBefore.token } }), env)).status, 401, 'signed out');
  await ev(ui, `ccArchive(${id}, 1)`); await tick(80);
  assert.equal(db.prepare('SELECT archived FROM classes').get().archived, 1);
  assert.match($(ui, 'cc').textContent, /archived/);
});

maybe('teacher dashboard: deleting a class needs its name typed; teachers get class checkboxes', async () => {
  const { env, db } = freshEnv();
  const ui = await open('teacher.html', env, { prompts: ['wrong name', '5C'] });
  $(ui, 'u').value = SECRETS.teacher_user; $(ui, 'p').value = SECRETS.teacher_password;
  await ev(ui, `go()`); await tick(60);
  $(ui, 'cn').value = '5C'; await ev(ui, `ccNew()`); await tick(60);
  const id = db.prepare('SELECT id FROM classes').get().id;
  await ev(ui, `ccDelete(${id})`); await tick(40);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM classes').get().n, 1, 'a wrong name deletes nothing');
  assert.ok(ui.dialogs.some((x) => x[0] === 'alert' && /nothing was deleted/.test(x[1])));
  // a teacher account, with the class ticked
  $(ui, 'tn').value = 'ms.lee'; $(ui, 'tp').value = 'a long password';
  await ev(ui, `tnew()`); await tick(80);
  const box = ui.d.querySelector('input[data-t="ms.lee"]');
  assert.ok(box, 'one checkbox per class');
  box.checked = true;
  await ev(ui, `tcls('ms.lee')`); await tick(80);
  assert.deepEqual(db.prepare('SELECT class_id FROM teacher_classes').all().map((r) => r.class_id), [id]);
  await ev(ui, `ccDelete(${id})`); await tick(80);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM classes').get().n, 0, 'the right name deletes it');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM teacher_classes').get().n, 0);
});

maybe('pupil page: class code + username, guest play, one message for every failure', async () => {
  const { env, db } = freshEnv();
  const t = (await (await worker.fetch(new Request('https://flashback.test/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: SECRETS.teacher_user, password: SECRETS.teacher_password }) }), env)).json()).token;
  const post = async (path, body) => (await worker.fetch(new Request('https://flashback.test/api/admin/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify(body) }), env)).json();
  const { class: c } = await post('classes', { name: '4A' });
  await post(`classes/${c.id}/pupils`, { pupils: [{ name: 'Raj Tan', username: 'rajt' }] });
  const ui = await open('index.html', env);
  assert.ok($(ui, 'c') && $(ui, 'u'), 'class code and username fields');
  assert.equal($(ui, 'p'), null, 'no PIN field');
  assert.doesNotMatch($(ui, 'main').textContent, /create my account|new pupils only/i, 'no self-registration');
  assert.match($(ui, 'main').textContent, /Play as a guest/);
  assert.equal($(ui, 'c').getAttribute('autocapitalize'), 'characters');
  // wrong, then right
  $(ui, 'c').value = 'ZZZZZZ'; $(ui, 'u').value = 'rajt';
  await ev(ui, `auth()`); await tick(40);
  const err1 = $(ui, 'e').textContent;
  assert.match(err1, /couldn’t find that username with that class code/);
  $(ui, 'c').value = c.code.toLowerCase(); $(ui, 'u').value = 'nobody';
  await ev(ui, `auth()`); await tick(40);
  assert.equal($(ui, 'e').textContent, err1, 'the same message whether the code or the username is wrong');
  assert.equal(ui.w.sessionStorage.getItem('tok'), null);
  $(ui, 'c').value = c.code.toLowerCase(); $(ui, 'u').value = 'Rajt';
  await ev(ui, `auth()`); await tick(120);
  await tick(250);
  assert.ok(ui.w.sessionStorage.getItem('tok'), 'a sign-in lasts for the tab');
  assert.equal(ui.w.localStorage.getItem('tok'), null, 'and is not kept in localStorage');
  assert.equal(ui.w.sessionStorage.getItem('usr'), 'rajt');
  assert.doesNotMatch($(ui, 'main').textContent, /Log in to practise/, 'past the login screen');
  // log out clears it
  ev(ui, 'logout()'); await tick(20);
  assert.equal(ui.w.sessionStorage.getItem('tok'), null);
  // guest
  await ev(ui, `auth(1)`); await tick(120);
  assert.ok(ui.w.sessionStorage.getItem('tok'));
  assert.match(ui.w.sessionStorage.getItem('usr'), /^guest_\d{4}$/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pupils WHERE is_guest = 1').get().n, 1);
});

maybe('pupil page: a v1.9 sign-in left in localStorage is dropped', async () => {
  const { env } = freshEnv();
  const dom = new JSDOM(page('index.html'), {
    url: 'https://flashback.test/index.html', runScripts: 'dangerously',
    beforeParse(w) { w.localStorage.setItem('tok', 'old-v1.9-token'); w.localStorage.setItem('usr', 'raj'); w.fetch = () => worker.fetch(new Request('https://flashback.test/api/me'), env); },
  });
  await tick();
  assert.equal(dom.window.localStorage.getItem('tok'), null);
  assert.equal(dom.window.localStorage.getItem('usr'), null);
  assert.match(dom.window.document.getElementById('main').textContent, /Class code/);
});
