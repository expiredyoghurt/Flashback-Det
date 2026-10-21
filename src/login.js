// Sign-in and class management (v2.0): the same method as Dialogue Dungeon.
//   Pupils: a username plus the 6-character class code. No passwords, no PINs, no self-registration. Guest play with no class.
//   Signed (HMAC) tokens: pupils 12 h, teachers 8 h. A pupil's token carries the class's `sess_ver`, so a new class code (or archiving
//   the class) signs the whole class out at once. One generic error for any failed pupil sign-in; per-IP rate limits.
//   Teachers: the super admin (Cloudflare secrets) and teacher accounts (kept from v1.4) manage classes, their code, and the pupils in them.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export const cl = (s, n) => String(s ?? '').trim().slice(0, n);
export const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';

// Per-IP throttle using a Workers rate-limit binding (RL_LOGIN / RL_GUEST in wrangler.toml). No binding = no throttle (local dev).
export async function rateLimited(env, binding, key) {
  const rl = env[binding];
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

// ---------- secrets ----------
// The super admin's secrets. teacher_user / teacher_password are the names Dialogue Dungeon uses; admin_user / admin_password (v1.4-v1.9) still work.
// There are no built-in defaults any more: with nothing set, nobody can sign in as a teacher.
export function adminCreds(env) {
  const ok = (x) => typeof x === 'string' && x.length > 0;
  if (ok(env.teacher_user) && ok(env.teacher_password)) return { user: env.teacher_user, pass: env.teacher_password };
  if (ok(env.admin_user) && ok(env.admin_password)) return { user: env.admin_user, pass: env.admin_password };
  return null;
}

// ---------- signed tokens ----------
const enc = new TextEncoder();
const b64url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
async function key(env) {
  const c = adminCreds(env);
  const secret = env.session_secret || (c ? `flashback-detectives|${c.user}|${c.pass}` : '');
  if (!secret) throw new HttpError(503, 'This app is not set up yet. Ask your teacher.');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signToken(env, payload, ttlSeconds) {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = await crypto.subtle.sign('HMAC', await key(env), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}
export async function verifyToken(env, token) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(env), unb64url(sig), enc.encode(body));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return payload.exp && payload.exp >= Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
export const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

// Teacher passwords (PBKDF2, as before)
export const hx = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function pw(p, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  return hx(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, k, 256));
}
export const sameStr = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

// Class codes: 6 characters, no 0/O/1/I/L so they are easy to read out and type.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newClassCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}
export const cleanCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Usernames: lowercase letters, digits, dot, dash, underscore; spaces ignored.
export const cleanUser = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9._-]/g, '').slice(0, 24);
export const validUser = (u) => /^[a-z0-9][a-z0-9._-]{1,23}$/.test(u);
export function suggestUsername(name, taken) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const ascii = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  let base = ascii(parts[0] || '');
  if (base) base += parts.slice(1).map((p) => ascii(p)[0] || '').join('');
  if (base.length < 2) base = 'pupil';
  base = base.slice(0, 20);
  let u = base;
  let n = 2;
  while (taken.has(u)) u = base + n++;
  return u;
}

// ---------- pupils ----------
export async function pupilLogin(req, env, body) {
  if (await rateLimited(env, 'RL_LOGIN', clientIp(req))) throw new HttpError(429, 'Too many tries. Wait a minute and try again.');
  const username = cleanUser(body.username);
  const code = cleanCode(body.code);
  const fail = new HttpError(401, 'We couldn’t find that username with that class code. Check both and try again.');
  if (!username || code.length < 4) throw fail;
  const cls = await env.DB.prepare('SELECT id, name, sess_ver FROM classes WHERE code = ?1 AND archived = 0').bind(code).first();
  if (!cls) throw fail;
  const p = await env.DB.prepare('SELECT id, name, username FROM pupils WHERE class_id = ?1 AND username = ?2').bind(cls.id, username).first();
  if (!p) throw fail;
  await env.DB.prepare('UPDATE pupils SET last_seen = ?1 WHERE id = ?2').bind(Date.now(), p.id).run();
  const token = await signToken(env, { r: 'p', pid: p.id, cid: cls.id, sv: cls.sess_ver }, 12 * 3600);
  return J({ token, username: p.username, pupil: { id: p.id, name: p.name, className: cls.name, guest: false } });
}

export async function pupilGuest(req, env) {
  if (await rateLimited(env, 'RL_GUEST', clientIp(req))) throw new HttpError(429, 'Too many guest sign-ins from here. Wait a minute and try again.');
  const row = await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('guest', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v").first();
  const username = 'guest_' + String(row.v).padStart(4, '0');
  const now = Date.now();
  const p = await env.DB.prepare('INSERT INTO pupils (class_id, name, username, is_guest, created_at, last_seen) VALUES (NULL, ?1, ?1, 1, ?2, ?2) RETURNING id').bind(username, now).first();
  const token = await signToken(env, { r: 'p', pid: p.id, cid: null, sv: 0 }, 12 * 3600);
  return J({ token, username, pupil: { id: p.id, name: username, className: 'Guest', guest: true } });
}

// Loads and checks the pupil behind a token. Returns null if the token is bad, the class was archived or its code reset since.
export async function authPupil(env, token) {
  const payload = await verifyToken(env, token);
  if (!payload || payload.r !== 'p') return null;
  const row = await env.DB
    .prepare('SELECT p.id, p.name, p.class_id, p.is_guest, c.sess_ver, c.archived, c.name AS class_name FROM pupils p LEFT JOIN classes c ON c.id = p.class_id WHERE p.id = ?1')
    .bind(payload.pid)
    .first();
  if (!row) return null;
  if (row.class_id) {
    if (row.archived || row.sess_ver !== payload.sv) return null;
  } else if (!row.is_guest) return null;
  return { pupil_id: row.id, name: row.name, class_id: row.class_id, guest: !!row.is_guest, className: row.class_name || 'Guest' };
}

// ---------- teachers and the super admin ----------
// Lockouts (kept from v1.2): 8 bad teacher logins per IP / 5 per name in 10 minutes.
async function blocked(env, k, max) { const r = await env.DB.prepare('SELECT * FROM fails WHERE k=?').bind(k).first(); return !!r && Date.now() - r.ts < 6e5 && r.n >= max; }
async function failed(env, k) { const r = await env.DB.prepare('SELECT * FROM fails WHERE k=?').bind(k).first(); const n = r && Date.now() - r.ts < 6e5 ? r.n + 1 : 1; await env.DB.prepare('INSERT OR REPLACE INTO fails(k,n,ts) VALUES(?,?,?)').bind(k, n, Date.now()).run(); }
const cleared = (env, k) => env.DB.prepare('DELETE FROM fails WHERE k=?').bind(k).run();

export async function staffLogin(req, env, b) {
  const creds = adminCreds(env);
  if (!creds) throw new HttpError(503, 'Teacher sign-in is not set up yet. Set the teacher_user and teacher_password secrets in Cloudflare.');
  const ip = clientIp(req), un = cl(b.user, 30).toLowerCase();
  if (await rateLimited(env, 'RL_LOGIN', ip)) throw new HttpError(429, 'Too many tries. Wait a minute and try again.');
  if ((await blocked(env, 'a:' + ip, 20)) || (await blocked(env, 'ua:' + un, 5))) throw new HttpError(429, 'Too many tries. Wait 10 minutes.');
  const [u, p] = await Promise.all([safeEqual(cl(b.user, 100), creds.user), safeEqual(cl(b.password, 100), creds.pass)]);
  if (u && p) {
    await cleared(env, 'ua:' + un);
    return J({ token: await signToken(env, { r: 'a' }, 8 * 3600), role: 'admin', name: cl(b.user, 100) });
  }
  const t = await env.DB.prepare('SELECT * FROM teachers WHERE username=?').bind(un).first();
  if (t && sameStr(t.hash, await pw(cl(b.password, 100), t.salt))) {
    await cleared(env, 'ua:' + un);
    return J({ token: await teacherToken(env, t), role: 'teacher', name: t.username });
  }
  await failed(env, 'a:' + ip);
  await failed(env, 'ua:' + un);
  throw new HttpError(401, 'Wrong teacher login');
}
// A teacher's token carries the start of their password hash, so resetting the password or deleting the account signs them out.
export const teacherToken = (env, t) => signToken(env, { r: 't', tid: t.id, hv: t.hash.slice(0, 12) }, 8 * 3600);

// Returns { role: 'admin' | 'teacher', pupil_id: <teacher id or null> } or null.
export async function staffAuth(env, token) {
  const p = await verifyToken(env, token);
  if (!p) return null;
  if (p.r === 'a') return { role: 'admin', pupil_id: null };
  if (p.r === 't') {
    const t = await env.DB.prepare('SELECT id, hash FROM teachers WHERE id=?').bind(p.tid).first();
    return t && t.hash.slice(0, 12) === p.hv ? { role: 'teacher', pupil_id: t.id } : null;
  }
  return null;
}

// ---------- classes and pupils (teacher dashboard) ----------
// ctx = { env, su: super admin?, cls: null (all classes) or an array of class ids the teacher may manage, tid }
export const PUPIL_TABLES = ['picks', 'runs', 'completions', 'writings', 'sorts', 'skill_log', 'xp_log', 'ai_checks', 'transfer_log'];
const okC = (ctx, id) => ctx.cls === null || ctx.cls.includes(id);
const getSetting = async (DB, k, d) => { const r = await DB.prepare('SELECT value FROM settings WHERE key=?').bind(k).first(); return r ? r.value : d; };

async function classOf(ctx, id) {
  if (!okC(ctx, id)) throw new HttpError(403, 'That is not one of your classes.');
  const c = await ctx.env.DB.prepare('SELECT id, name, code, archived FROM classes WHERE id = ?1').bind(id).first();
  if (!c) throw new HttpError(404, 'Class not found.');
  return c;
}
async function pupilIn(ctx, id) {
  const p = await ctx.env.DB.prepare('SELECT id, class_id, is_guest FROM pupils WHERE id = ?1').bind(id).first();
  if (!p || (p.class_id == null ? !ctx.su : !okC(ctx, p.class_id))) throw new HttpError(404, 'No such pupil in your classes.');
  return p;
}
const wipePupil = (env, id) => PUPIL_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE pupil_id = ?1`).bind(id));

async function listClasses(ctx) {
  const { env } = ctx;
  const where = ctx.cls === null ? '' : ctx.cls.length ? `WHERE c.id IN (${ctx.cls.map(() => '?').join(',')})` : 'WHERE 0';
  const rows = (await env.DB.prepare(`SELECT c.id, c.name, c.code, c.archived, c.created_at, (SELECT COUNT(*) FROM pupils p WHERE p.class_id = c.id) AS pupils FROM classes c ${where} ORDER BY c.archived, c.name COLLATE NOCASE`).bind(...(ctx.cls || [])).all()).results;
  const guests = ctx.su ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM pupils WHERE is_guest = 1').first()).n : null;
  return J({ classes: rows, guests, canCreate: ctx.su || (await getSetting(env.DB, 'teacher_class_create', '1')) !== '0', teacherCreate: (await getSetting(env.DB, 'teacher_class_create', '1')) !== '0' });
}

async function createClass(ctx, b) {
  const { env } = ctx;
  if (!ctx.su && (await getSetting(env.DB, 'teacher_class_create', '1')) === '0') throw new HttpError(403, 'Only the super admin can create classes.');
  const name = cl(b.name, 60);
  if (!name) throw new HttpError(400, 'Give the class a name.');
  for (let i = 0; i < 12; i++) {
    try {
      const row = await env.DB.prepare('INSERT INTO classes (name, code, created_at) VALUES (?1, ?2, ?3) RETURNING id, name, code').bind(name, newClassCode(), Date.now()).first();
      if (!ctx.su) await env.DB.prepare('INSERT OR IGNORE INTO teacher_classes (teacher_id, class_id) VALUES (?1, ?2)').bind(ctx.tid, row.id).run();
      return J({ class: row });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e;
    }
  }
  throw new HttpError(500, 'Could not create a unique class code. Try again.');
}

async function updateClass(ctx, id, b) {
  await classOf(ctx, id);
  if (b.name !== undefined) {
    const name = cl(b.name, 60);
    if (!name) throw new HttpError(400, 'Give the class a name.');
    await ctx.env.DB.prepare('UPDATE classes SET name = ?1 WHERE id = ?2').bind(name, id).run();
  }
  if (b.archived !== undefined) await ctx.env.DB.prepare('UPDATE classes SET archived = ?1, sess_ver = sess_ver + 1 WHERE id = ?2').bind(b.archived ? 1 : 0, id).run();
  return J({ ok: 1 });
}

async function regenCode(ctx, id, b) {
  await classOf(ctx, id);
  for (let i = 0; i < 12; i++) {
    try {
      const row = await ctx.env.DB.prepare(`UPDATE classes SET code = ?1${b.signOut ? ', sess_ver = sess_ver + 1' : ''} WHERE id = ?2 RETURNING code`).bind(newClassCode(), id).first();
      return J({ code: row.code, signedOut: !!b.signOut });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e;
    }
  }
  throw new HttpError(500, 'Could not create a unique class code. Try again.');
}

async function deleteClass(ctx, id) {
  await classOf(ctx, id);
  const { env } = ctx;
  const ids = (await env.DB.prepare('SELECT id FROM pupils WHERE class_id = ?1').bind(id).all()).results.map((r) => r.id);
  const stmts = ids.flatMap((pid) => wipePupil(env, pid));
  stmts.push(env.DB.prepare('DELETE FROM pupils WHERE class_id = ?1').bind(id), env.DB.prepare('DELETE FROM assignments WHERE class_id = ?1').bind(id), env.DB.prepare('DELETE FROM teacher_classes WHERE class_id = ?1').bind(id), env.DB.prepare('DELETE FROM classes WHERE id = ?1').bind(id));
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return J({ ok: 1 });
}

async function listPupils(ctx, classId) {
  await classOf(ctx, classId);
  const rows = (await ctx.env.DB.prepare(`SELECT p.id, p.name, p.username, p.last_seen,
      (SELECT COUNT(*) FROM picks k WHERE k.pupil_id = p.id) AS answers,
      (SELECT COUNT(DISTINCT story) FROM completions c WHERE c.pupil_id = p.id) AS stories,
      (SELECT COALESCE(SUM(xp), 0) FROM xp_log x WHERE x.pupil_id = p.id) AS xp,
      (SELECT MAX(ts) FROM picks k WHERE k.pupil_id = p.id) AS last_active
    FROM pupils p WHERE p.class_id = ?1 ORDER BY p.name COLLATE NOCASE`).bind(classId).all()).results;
  return J({ pupils: rows });
}

// Turns pasted lines ("Raj Tan" or "Raj Tan, rajt") into proposed pupils, checking for clashes.
async function previewPupils(ctx, classId, b) {
  await classOf(ctx, classId);
  const lines = String(b.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const taken = new Set((await ctx.env.DB.prepare('SELECT username FROM pupils WHERE class_id = ?1').bind(classId).all()).results.map((r) => r.username));
  const out = [];
  for (const line of lines) {
    if (/^(name|pupil|student)\b.*,\s*(username|user)/i.test(line)) continue; // header row
    const [rawName, rawUser] = line.split(/[,\t;]/).map((s) => s.trim());
    const name = cl(rawName, 60);
    if (!name) continue;
    let username = cleanUser(rawUser || '');
    let status = 'ok';
    if (username) {
      if (!validUser(username)) status = 'invalid';
      else if (taken.has(username)) status = 'duplicate';
    } else username = suggestUsername(name, taken);
    if (status === 'ok') taken.add(username);
    out.push({ name, username, status });
  }
  return J({ rows: out });
}

async function addPupils(ctx, classId, b) {
  await classOf(ctx, classId);
  const { env } = ctx;
  const list = Array.isArray(b.pupils) ? b.pupils.slice(0, 200) : [];
  const existing = new Set((await env.DB.prepare('SELECT username FROM pupils WHERE class_id = ?1').bind(classId).all()).results.map((r) => r.username));
  const stmts = [], skipped = [];
  let added = 0;
  for (const p of list) {
    const name = cl(p.name, 60), username = cleanUser(p.username);
    if (!name || !validUser(username)) { skipped.push({ name: name || '(blank)', reason: 'invalid username' }); continue; }
    if (existing.has(username)) { skipped.push({ name, reason: 'username already used in this class' }); continue; }
    existing.add(username);
    stmts.push(env.DB.prepare('INSERT INTO pupils (class_id, name, username, is_guest, created_at) VALUES (?1, ?2, ?3, 0, ?4)').bind(classId, name, username, Date.now()));
    added++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return J({ added, skipped });
}

async function updatePupil(ctx, id, b) {
  const p = await pupilIn(ctx, id);
  if (p.is_guest) throw new HttpError(404, 'Pupil not found.');
  const { env } = ctx;
  const cur = await env.DB.prepare('SELECT name, username, class_id FROM pupils WHERE id = ?1').bind(id).first();
  const next = { ...cur };
  if (b.name !== undefined) {
    next.name = cl(b.name, 60);
    if (!next.name) throw new HttpError(400, 'Name can’t be blank.');
  }
  if (b.username !== undefined) {
    next.username = cleanUser(b.username);
    if (!validUser(next.username)) throw new HttpError(400, 'Usernames use 2–24 letters, numbers, dots, dashes or underscores.');
  }
  // moving a pupil to another of your classes (for example out of "Unassigned") keeps all their results
  if (b.class_id !== undefined && Number(b.class_id) !== cur.class_id) next.class_id = (await classOf(ctx, Number(b.class_id))).id;
  try {
    await env.DB.prepare('UPDATE pupils SET name = ?1, username = ?2, class_id = ?3 WHERE id = ?4').bind(next.name, next.username, next.class_id, id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'Another pupil in that class already has that username. Change the username first.');
    throw e;
  }
  return J({ ok: 1 });
}

async function deletePupil(ctx, id) {
  await pupilIn(ctx, id);
  await ctx.env.DB.batch([...wipePupil(ctx.env, id), ctx.env.DB.prepare('DELETE FROM pupils WHERE id = ?1').bind(id)]);
  return J({ ok: 1 });
}
async function resetPupil(ctx, id) {
  await pupilIn(ctx, id);
  await ctx.env.DB.batch(wipePupil(ctx.env, id));
  return J({ ok: 1 });
}

// Routes under /api/admin/. Returns a Response, or null if the path is not one of these.
export async function classRoute(ctx, path, m, b) {
  let x;
  if (path === '/classes') return m === 'GET' ? listClasses(ctx) : m === 'POST' ? createClass(ctx, b) : null;
  if ((x = path.match(/^\/classes\/(\d+)$/))) return m === 'PATCH' ? updateClass(ctx, +x[1], b) : m === 'DELETE' ? deleteClass(ctx, +x[1]) : null;
  if ((x = path.match(/^\/classes\/(\d+)\/regen$/)) && m === 'POST') return regenCode(ctx, +x[1], b);
  if ((x = path.match(/^\/classes\/(\d+)\/pupils$/))) return m === 'GET' ? listPupils(ctx, +x[1]) : m === 'POST' ? addPupils(ctx, +x[1], b) : null;
  if ((x = path.match(/^\/classes\/(\d+)\/pupils\/preview$/)) && m === 'POST') return previewPupils(ctx, +x[1], b);
  if ((x = path.match(/^\/pupils\/(\d+)$/))) return m === 'PATCH' ? updatePupil(ctx, +x[1], b) : m === 'DELETE' ? deletePupil(ctx, +x[1]) : null;
  if ((x = path.match(/^\/pupils\/(\d+)\/reset$/)) && m === 'POST') return resetPupil(ctx, +x[1]);
  if (path === '/class-settings' && m === 'POST') {
    if (!ctx.su) throw new HttpError(403, 'Super admin only');
    await ctx.env.DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind('teacher_class_create', b.teacherCreate ? '1' : '0').run();
    return J({ ok: 1 });
  }
  return null;
}

// Daily clean-up of old guest accounts (cron in wrangler.toml).
export async function purgeGuests(env) {
  const days = parseInt(env.GUEST_RETENTION_DAYS || '30', 10);
  const cutoff = Date.now() - days * 86_400_000;
  const old = '(SELECT id FROM pupils WHERE is_guest = 1 AND created_at < ?1)';
  await env.DB.batch([...PUPIL_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE pupil_id IN ${old}`).bind(cutoff)), env.DB.prepare('DELETE FROM pupils WHERE is_guest = 1 AND created_at < ?1').bind(cutoff)]);
}
