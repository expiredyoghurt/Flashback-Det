// Flashback Detectives v1.3 API. Static files come from ./public (Workers Assets).
// Secrets: admin_user, admin_password (defaults admin123 / password123 if unset).
import D from './stories.json';
import { check, LABELS, roleTexts, RULE_ROLES } from './checker.js';
import TR from './transfer.json';
import { judge, providersConfigured, RULE_TEXT } from './ai.js';
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const cl = (s, n) => String(s ?? '').trim().slice(0, n);
const pubNode = (S, k) => { const n = S.n[k]; return { id: k, q: n.q, h: n.h, o: n.o.map((o, i) => ({ i, l: o.l, t: o.x ? o.t : '' })) }; };
const RANKS = [{ n: 'Rookie', ic: '🔎', min: 0 }, { n: 'Sleuth', ic: '🕵️', min: 100 }, { n: 'Inspector', ic: '🎖️', min: 350 }, { n: 'Chief', ic: '🏅', min: 800 }];
const rankOf = xp => { let i = 0; RANKS.forEach((r, k) => { if (xp >= r.min) i = k; }); const nx = RANKS[i + 1]; return { n: RANKS[i].n, ic: RANKS[i].ic, min: RANKS[i].min, next: nx ? nx.min : null, nextName: nx ? nx.n : null }; };
const skillOf = (s, n) => D.stories[s] && D.stories[s].n[n] && D.stories[s].n[n].k;
const SKN = Object.fromEntries(Object.entries(D.stories).map(([id, s]) => [id, Object.values(s.n).map(n => n.k).filter(Boolean)]));
const MASTERY_Q = 'SELECT skill,COUNT(*) n,SUM(ok) good FROM (SELECT skill,ok,ROW_NUMBER() OVER (PARTITION BY skill ORDER BY id DESC) rn FROM skill_log WHERE pupil_id=?) WHERE rn<=20 GROUP BY skill';
// Recommend the story that practises the pupil's weakest skill (unseen skills rank just above known-weak ones)
function recommend(skills, comps) {
  const done = new Set(comps.map(c => c.story));
  const sc = Object.keys(D.skills).map(k => { const s = skills[k]; return { k, v: s && s[0] >= 3 ? s[1] / s[0] : s ? 0.5 : 0.4 }; }).sort((a, b) => a.v - b.v);
  for (const { k } of sc) {
    if (k === 'choose' || k === 'fix') return { task: k, skill: k };
    const c = Object.entries(SKN).map(([id, a]) => ({ id, n: a.filter(x => x === k).length })).filter(x => x.n).sort((a, b) => (done.has(a.id) - done.has(b.id)) || b.n - a.n);
    if (c.length) return { story: c[0].id, skill: k };
  }
  return null;
}
// One-off: build skill history and starting XP for pupils who played before v1.6
const getSet = async (DB, k, d) => { const r = await DB.prepare('SELECT value FROM settings WHERE key=?').bind(k).first(); return r ? r.value : d; };
const setSet = (DB, k, v) => DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(k, String(v)).run();
// AI helper is OFF until the super admin turns it on AND at least one provider is configured
async function aiState(env) {
  const cfg = providersConfigured(env), list = Object.keys(cfg).filter(k => cfg[k]);
  const enabled = (await getSet(env.DB, 'ai_enabled', '0')) === '1', daily = Math.max(1, Math.min(20, parseInt(await getSet(env.DB, 'ai_daily', '5'), 10) || 5));
  return { on: enabled && list.length > 0, enabled, cfg, list, daily };
}
const relHash = (rule, P) => sha(rule + '|' + RULE_ROLES[rule].map(r => P[r] || '').join('\u0001'));
async function applyAI(res, P, aiMap) {
  for (const r of res.results) if (!r.ok && !r.na && aiMap && aiMap[r.id] && aiMap[r.id] === await relHash(r.id, P)) { r.ok = true; r.ai = true; }
  res.passed = res.results.filter(x => !x.na && x.ok).length; return res;
}
async function backfill(DB, pid) {
  const h = await DB.prepare('SELECT (SELECT COUNT(*) FROM skill_log WHERE pupil_id=?) a,(SELECT COUNT(*) FROM xp_log WHERE pupil_id=?) b').bind(pid, pid).first();
  if (h.a || h.b) return;
  const rows = (await DB.prepare('SELECT story,node,r,tries FROM picks WHERE pupil_id=? ORDER BY id').bind(pid).all()).results;
  let xp = 0; const st = [];
  for (const x of rows) { xp += x.r === 'g' ? (x.tries ? 5 : 10) : (x.tries ? 0 : 2); const k = skillOf(x.story, x.node); if (!x.tries && k) st.push(DB.prepare('INSERT INTO skill_log(pupil_id,skill,ok) VALUES(?,?,?)').bind(pid, k, x.r === 'g' ? 1 : 0)); }
  const c = await DB.prepare('SELECT COUNT(*) n,COALESCE(SUM(perfect),0) p FROM completions WHERE pupil_id=?').bind(pid).first();
  const wr = await DB.prepare('SELECT COUNT(*) n FROM writings WHERE pupil_id=?').bind(pid).first();
  xp += c.n * 25 + c.p * 15 + wr.n * 10;
  st.push(DB.prepare("INSERT INTO xp_log(pupil_id,kind,xp,ref) SELECT ?,'backfill',?,'history before v1.6' WHERE NOT EXISTS (SELECT 1 FROM xp_log WHERE pupil_id=? AND kind='backfill')").bind(pid, xp, pid));
  await DB.batch(st);
}
const TYPES = Object.fromEntries(Object.entries(D.types).map(([k, v]) => [k, { kind: v.kind, checks: v.checks, rq: v.rq, scaf: v.scaf, frame: v.frame, nudge: v.nudge, map: v.map }]));

async function auth(req, env, role) {
  const t = (req.headers.get('authorization') || '').replace('Bearer ', '');
  if (!t) return null;
  return env.DB.prepare("SELECT * FROM sessions WHERE token=? AND role=? AND created>datetime('now',?)").bind(t, role, role === 'admin' ? '-4 hours' : '-12 hours').first();
}
async function mk(env, role, pid) {
  await env.DB.prepare("DELETE FROM sessions WHERE created<datetime('now','-1 day')").run();
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions(token,role,pupil_id) VALUES(?,?,?)').bind(token, role, pid).run();
  return token;
}
// Rate limiting: 5 bad logins per username, 40 per IP, 8 per IP for teacher login, in 10 minutes
async function blocked(env, k, max) { const r = await env.DB.prepare('SELECT * FROM fails WHERE k=?').bind(k).first(); return !!r && Date.now() - r.ts < 6e5 && r.n >= max; }
async function fail(env, k) { const r = await env.DB.prepare('SELECT * FROM fails WHERE k=?').bind(k).first(); const n = r && Date.now() - r.ts < 6e5 ? r.n + 1 : 1; await env.DB.prepare('INSERT OR REPLACE INTO fails(k,n,ts) VALUES(?,?,?)').bind(k, n, Date.now()).run(); }
const clear = (env, k) => env.DB.prepare('DELETE FROM fails WHERE k=?').bind(k).run();
async function getRun(env, s, id) { const r = await env.DB.prepare('SELECT * FROM runs WHERE id=? AND pupil_id=? AND done=0').bind(id | 0, s.pupil_id).first(); if (r) r.st = JSON.parse(r.state); return r; }
const hx = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function pw(p, salt) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(p), 'PBKDF2', false, ['deriveBits']); return hx(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, k, 256)); }
const staff = async (req, env) => { const t = (req.headers.get('authorization') || '').replace('Bearer ', ''); return t ? env.DB.prepare("SELECT * FROM sessions WHERE token=? AND role IN ('admin','teacher') AND created>datetime('now','-4 hours')").bind(t).first() : null; };
// Shows the pupil's story with the flashback where THEY placed it
const view = st => { const a = st.story.map(t => ({ t })); if (st.fb) { const f = { t: st.fb, fb: 1 }; if (st.pl === 'start') a.unshift(f); else if (st.pl === 'end') a.push(f); else a.splice(st.fbAt, 0, f); } return a; };
const saveRun = (env, r) => env.DB.prepare('UPDATE runs SET state=? WHERE id=?').bind(JSON.stringify(r.st), r.id).run();

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname, m = req.method, ip = req.headers.get('cf-connecting-ip') || 'x';
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    const b = m === 'POST' ? await req.json().catch(() => ({})) : {};
    const DB = env.DB;
    try {
      if (m === 'POST' && path === '/api/register') {
        const u = cl(b.username, 20).toLowerCase(), pin = cl(b.pin, 8);
        if (!/^[a-z0-9_.-]{3,20}$/.test(u)) return J({ error: 'Username: 3-20 letters or numbers' }, 400);
        if (!/^\d{4,8}$/.test(pin)) return J({ error: 'PIN must be 4-8 digits' }, 400);
        if (await DB.prepare('SELECT 1 FROM pupils WHERE username=?').bind(u).first()) return J({ error: 'That name is taken' }, 409);
        const r = await DB.prepare('INSERT INTO pupils(username,class,pin_hash) VALUES(?,?,?)').bind(u, cl(b.class, 20), await sha(u + ':' + pin)).run();
        return J({ token: await mk(env, 'pupil', r.meta.last_row_id), username: u });
      }
      if (m === 'POST' && path === '/api/login') {
        const u = cl(b.username, 20).toLowerCase();
        if (await blocked(env, 'u:' + u, 5) || await blocked(env, 'i:' + ip, 40)) return J({ error: 'Too many tries. Wait 10 minutes.' }, 429);
        const p = await DB.prepare('SELECT * FROM pupils WHERE username=?').bind(u).first();
        if (!p || !same(p.pin_hash, await sha(u + ':' + cl(b.pin, 8)))) { await fail(env, 'u:' + u); await fail(env, 'i:' + ip); return J({ error: 'Wrong name or PIN' }, 401); }
        await clear(env, 'u:' + u);
        return J({ token: await mk(env, 'pupil', p.id), username: u });
      }
      if (m === 'POST' && path === '/api/admin/login') {
        const un = cl(b.user, 30).toLowerCase();
        if (await blocked(env, 'a:' + ip, 20) || await blocked(env, 'ua:' + un, 5)) return J({ error: 'Too many tries. Wait 10 minutes.' }, 429);
        const au = env.admin_user || 'admin123', ap = env.admin_password || 'password123';
        if (same(await sha(cl(b.user, 100)), await sha(au)) && same(await sha(cl(b.password, 100)), await sha(ap))) {
          await clear(env, 'ua:' + un); return J({ token: await mk(env, 'admin', null), role: 'admin', name: cl(b.user, 100) });
        }
        const t = await DB.prepare('SELECT * FROM teachers WHERE username=?').bind(un).first();
        if (t && same(t.hash, await pw(cl(b.password, 100), t.salt))) { await clear(env, 'ua:' + un); return J({ token: await mk(env, 'teacher', t.id), role: 'teacher', name: t.username }); }
        await fail(env, 'a:' + ip); await fail(env, 'ua:' + un);
        return J({ error: 'Wrong teacher login' }, 401);
      }
      /* ---------- pupil ---------- */
      if (path.startsWith('/api/') && !path.startsWith('/api/admin/')) {
        const s = await auth(req, env, 'pupil');
        if (!s) return J({ error: 'Please log in' }, 401);
        const pid = s.pupil_id;
        const me = await DB.prepare('SELECT class FROM pupils WHERE id=?').bind(pid).first();
        if (m === 'GET' && path === '/api/stories') {
          const a = await DB.prepare('SELECT story FROM assignments WHERE UPPER(TRIM(class))=UPPER(TRIM(?))').bind(me.class || '').all();
          return J({ types: TYPES, skills: D.skills, stories: Object.entries(D.stories).map(([id, s]) => ({ id, type: s.type, title: s.title, ic: s.ic, blurb: s.blurb })), assigned: a.results.map(x => x.story) });
        }
        if (m === 'GET' && path === '/api/me') {
          await backfill(DB, pid);
          const c = (await DB.prepare('SELECT story,MAX(points) points,MAX(perfect) perfect FROM completions WHERE pupil_id=? GROUP BY story').bind(pid).all()).results;
          const n = async (sql, ...a) => (await DB.prepare(sql).bind(pid, ...a).first()).n;
          const g = bt => n("SELECT COUNT(*) n FROM picks WHERE pupil_id=? AND bt=? AND r='g'", bt);
          const tries = await n('SELECT COUNT(*) n FROM picks WHERE pupil_id=? AND tries>0');
          const bg = { first: c.length >= 1, explorer: c.length >= 3, placer: await g('placer') >= 3, content: await g('content') >= 3, length: await g('length') >= 3, architect: c.some(x => x.perfect), persist: tries >= 1 };
          const w = (await DB.prepare('SELECT story,text,comment,ts FROM writings WHERE pupil_id=? ORDER BY id DESC LIMIT 20').bind(pid).all()).results;
          const so = await DB.prepare('SELECT MAX(score) s,MAX(total) t FROM sorts WHERE pupil_id=?').bind(pid).first();
          const skills = {}; (await DB.prepare(MASTERY_Q).bind(pid).all()).results.forEach(x => skills[x.skill] = [x.n, x.good]);
          const xp = (await DB.prepare('SELECT COALESCE(SUM(xp),0) x FROM xp_log WHERE pupil_id=?').bind(pid).first()).x;
          return J({ completions: c, badges: bg, writings: w, sort: so, xp, rank: rankOf(xp), skills, next: recommend(skills, c) });
        }
        if (m === 'POST' && path === '/api/run/start') {
          const S = D.stories[b.story]; if (!S) return J({ error: 'Bad story' }, 400);
          const r = await DB.prepare('INSERT INTO runs(pupil_id,story,state) VALUES(?,?,?)').bind(pid, b.story, JSON.stringify({ cur: 'open', pts: 0, perfect: true, story: [], tn: {}, pend: null })).run();
          return J({ run: r.meta.last_row_id, node: pubNode(S, 'open') });
        }
        if (path.startsWith('/api/run/')) {
          const r = await getRun(env, s, b.run); if (!r) return J({ error: 'Run not found' }, 404);
          const S = D.stories[r.story], st = r.st;
          if (path === '/api/run/choice') {
            const node = S.n[st.cur], o = node && node.o[b.idx | 0]; if (!o) return J({ error: 'Bad choice' }, 400);
            const tries = st.tn[st.cur] || 0; let p = o.p;
            if (tries > 0) p = Math.round(p / 2); // partial credit after a retry
            if (o.rt) { st.tn[st.cur] = tries + 1; st.pend = null; } else st.pend = { p, r: o.r, t: o.nt ? '' : o.t, n: o.n, fl: o.fl, pl: o.pl };
            await DB.prepare('INSERT INTO picks(pupil_id,run,story,node,idx,r,p,bt,tries,ms) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(pid, r.id, r.story, st.cur, b.idx | 0, o.r, o.rt ? 0 : p, o.b || null, tries, Math.min(b.ms | 0, 6e5)).run();
            if (tries === 0 && node.k) await DB.prepare('INSERT INTO skill_log(pupil_id,skill,ok) VALUES(?,?,?)').bind(pid, node.k, o.r === 'g' ? 1 : 0).run();
            await saveRun(env, r);
            return J({ r: o.r, p: o.rt ? 0 : p, f: o.f, tip: o.tip, retry: !!o.rt, half: tries > 0 && !o.rt && o.p > 0 });
          }
          if (path === '/api/run/retry') { st.tn[st.cur] = (st.tn[st.cur] || 0) + 1; st.pend = null; await saveRun(env, r); return J({ node: pubNode(S, st.cur) }); }
          if (path === '/api/run/advance') {
            if (!st.pend) return J({ error: 'Pick first' }, 400);
            if (st.pend.pl) st.pl = st.pend.pl;
            if (st.pend.t) { if (st.pend.fl) { st.fb = st.pend.t; st.fbAt = st.story.length; } else st.story.push(st.pend.t); }
            st.pts += st.pend.p; if (st.pend.r !== 'g' || (st.tn[st.cur] || 0) > 0) st.perfect = false;
            const tr0 = st.tn[st.cur] || 0, rep = (await DB.prepare('SELECT COUNT(*) n FROM completions WHERE pupil_id=? AND story=?').bind(pid, r.story).first()).n >= 2 ? 0.5 : 1;
            const xp = Math.floor((st.pend.r === 'g' ? (tr0 ? 5 : 10) : (tr0 ? 0 : 2)) * rep);
            if (xp) await DB.prepare('INSERT INTO xp_log(pupil_id,kind,xp,ref) VALUES(?,?,?,?)').bind(pid, 'step', xp, r.story + ':' + st.cur).run();
            st.cur = st.pend.n; st.pend = null; await saveRun(env, r);
            return J(st.cur === 'sum' ? { done: true, story: view(st), pts: st.pts, perfect: st.perfect, xp } : { node: pubNode(S, st.cur), story: view(st), pts: st.pts, xp });
          }
          const frameParts = () => { const T0 = D.types[S.type]; const parts = (Array.isArray(b.parts) ? b.parts : []).slice(0, T0.frame.length).map(x => cl(x, 1200)); return { T0, parts, P: roleTexts(T0.frame, parts) }; };
          const aiUsed = async () => (await DB.prepare("SELECT COUNT(*) n FROM ai_checks WHERE pupil_id=? AND source='pupil' AND ts>datetime('now','-1 day')").bind(pid).first()).n;
          if (path === '/api/run/check') {
            const { T0, parts, P } = frameParts(), ck = await applyAI(check(S.type, parts, T0.frame), P, st.ai), ai = await aiState(env), used = ai.on ? await aiUsed() : 0;
            return J({ results: ck.results.map(x => ({ ...x, label: LABELS[x.id], can_ask: ai.on && !x.ok && !x.na && !!RULE_TEXT[x.id] && !/^Write something/.test(x.hint) })), passed: ck.passed, total: ck.total, ai: { on: ai.on, left: Math.max(0, ai.daily - used) } });
          }
          if (path === '/api/run/ai-check') {
            // Only for a rule the quick check marked as missing, and only for rules where wording varies (not "had" or length)
            const ai = await aiState(env); if (!ai.on) return J({ error: 'The AI helper is turned off.' }, 403);
            const rule = cl(b.rule, 20); if (!RULE_TEXT[rule]) return J({ error: 'The AI helper cannot check that rule.' }, 400);
            const { T0, parts, P } = frameParts(), cr = check(S.type, parts, T0.frame).results.find(x => x.id === rule);
            if (!cr || cr.na) return J({ error: 'That rule is not part of this story.' }, 400);
            if (cr.ok) return J({ error: 'The quick check already found this one!' }, 400);
            const texts = Object.fromEntries(RULE_ROLES[rule].map(k => [k, P[k] || '']));
            if (RULE_ROLES[rule].some(k => !texts[k])) return J({ error: 'Write something in that box first.' }, 400);
            const h = await relHash(rule, P);
            const old = await DB.prepare("SELECT outcome,reason FROM ai_checks WHERE run=? AND rule=? AND text_hash=? AND source='pupil'").bind(r.id, rule, h).first();
            if (old) return J({ outcome: old.outcome, reason: old.reason, cached: true });
            const used = await aiUsed(); if (used >= ai.daily) return J({ error: 'You have used all your AI helper checks for today. Try again tomorrow!' }, 429);
            const jr = await judge(env, rule, texts, ai.list);
            await DB.prepare('INSERT INTO ai_checks(pupil_id,run,story,rule,text_hash,snippet,verdicts,outcome,reason,source) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(pid, r.id, r.story, rule, h, JSON.stringify(texts), JSON.stringify(jr.verdicts), jr.outcome, jr.reason, 'pupil').run();
            if (jr.outcome === 'met') { st.ai = st.ai || {}; st.ai[rule] = h; await saveRun(env, r); }
            return J({ outcome: jr.outcome, reason: jr.reason, left: Math.max(0, ai.daily - used - 1) });
          }
          if (path === '/api/run/finish') {
            if (st.cur !== 'sum') return J({ error: 'Story not finished' }, 400);
            const rep = (await DB.prepare('SELECT COUNT(*) n FROM completions WHERE pupil_id=? AND story=?').bind(pid, r.story).first()).n >= 2 ? 0.5 : 1;
            await DB.prepare('INSERT INTO completions(pupil_id,story,points,perfect,reflection) VALUES(?,?,?,?,?)').bind(pid, r.story, st.pts, st.perfect ? 1 : 0, JSON.stringify((b.reflection || []).slice(0, 6).map(x => cl(x, 600)))).run();
            const wc = s => cl(s, 3000).split(/\s+/).filter(Boolean).length;
            const T0 = D.types[S.type], parts = (Array.isArray(b.parts) ? b.parts : []).slice(0, T0.frame.length).map(x => cl(x, 1200));
            const ck = await applyAI(check(S.type, parts, T0.frame), roleTexts(T0.frame, parts), st.ai), wtot = parts.reduce((n, x) => n + wc(x), 0), wxp = wtot > 0 ? (wtot >= 10 ? 5 : 0) + Math.min(10, 2 * ck.passed) : 0;
            if (wtot > 0) { const wr = await DB.prepare('INSERT INTO writings(pupil_id,story,text,checks) VALUES(?,?,?,?)').bind(pid, r.story, T0.frame.map((f, i) => `[${f.l}]\n${parts[i] || ''}`).join('\n\n'), JSON.stringify(ck.results.filter(x => !x.na).map(x => [x.id, x.ok ? 1 : 0, x.ai ? 1 : 0]))).run(); await DB.prepare('UPDATE ai_checks SET writing_id=? WHERE run=?').bind(wr.meta.last_row_id, r.id).run(); }
            await DB.prepare('UPDATE runs SET done=1 WHERE id=?').bind(r.id).run();
            const xp = Math.floor((25 + (st.perfect ? 15 : 0)) * rep) + wxp + Math.min(10, 2 * (Array.isArray(b.reflection) ? b.reflection : []).filter(x => wc(x) >= 6).length);
            await DB.prepare('INSERT INTO xp_log(pupil_id,kind,xp,ref) VALUES(?,?,?,?)').bind(pid, 'finish', xp, r.story).run();
            return J({ ok: 1, points: st.pts, perfect: st.perfect, xp });
          }
        }
        if (m === 'GET' && path === '/api/sort') return J({ items: D.sort.map((x, i) => ({ i, x: x.x })) });
        if (m === 'POST' && path === '/api/sort') {
          const a = Array.isArray(b.answers) ? b.answers : [];
          const res = D.sort.map((x, i) => ({ ok: a[i] === x.a, a: x.a, e: x.e }));
          const sc = res.filter(x => x.ok).length;
          const pb = (await DB.prepare('SELECT COALESCE(MAX(score),0) m FROM sorts WHERE pupil_id=?').bind(pid).first()).m, sx = 3 * Math.max(0, sc - pb);
          if (sx) await DB.prepare('INSERT INTO xp_log(pupil_id,kind,xp,ref) VALUES(?,?,?,?)').bind(pid, 'sort', sx, 'sort').run();
          await DB.prepare('INSERT INTO sorts(pupil_id,score,total) VALUES(?,?,?)').bind(pid, sc, res.length).run();
          return J({ results: res, score: sc, total: res.length, xp: sx });
        }
        // ---------- v1.9 transfer tasks: picture prompt -> choose the type; fix the flawed flashback ----------
        const skillRow = (k, ok) => DB.prepare('INSERT INTO skill_log(pupil_id,skill,ok) VALUES(?,?,?)').bind(pid, k, ok ? 1 : 0).run();
        const award = (xp, ref) => xp > 0 ? DB.prepare("INSERT INTO xp_log(pupil_id,kind,xp,ref) VALUES(?,'transfer',?,?)").bind(pid, xp, ref).run() : null;
        const tlog = (kind, task, a, b2, c2, wrong) => DB.prepare('INSERT INTO transfer_log(pupil_id,kind,task,a,b,c,wrong) VALUES(?,?,?,?,?,?,?)').bind(pid, kind, task, a ? 1 : 0, b2 ? 1 : 0, c2 | 0, wrong || '').run();
        const prior = (kind, task) => DB.prepare('SELECT COALESCE(MAX(a),0) a,COALESCE(MAX(b),0) b,COUNT(*) n FROM transfer_log WHERE pupil_id=? AND kind=? AND task=?').bind(pid, kind, task).first();
        if (m === 'GET' && path === '/api/transfer') {
          const dn = async (kind, cond) => new Set((await DB.prepare(`SELECT task FROM transfer_log WHERE pupil_id=? AND kind=? GROUP BY task HAVING ${cond}`).bind(pid, kind).all()).results.map(x => x.task));
          const c1 = await dn('choose', 'MAX(a)=1 AND MAX(b)=1'), f1 = await dn('fix', 'MAX(a)=1');
          return J({ choose: TR.choose.map(x => ({ id: x.id, ic: x.ic, title: x.title, see: x.see, plot: x.plot, plan: x.plan.map(p => p.t), done: c1.has(x.id) })), repair: TR.repair.map(x => ({ id: x.id, type: x.type, title: x.title, done: f1.has(x.id) })) });
        }
        if (m === 'POST' && path === '/api/transfer/choose') {
          const sc = TR.choose.find(x => x.id === b.id), po = sc && sc.plan[b.plan | 0];
          if (!sc || !po || !D.types[b.type]) return J({ error: 'Bad answer' }, 400);
          const tOk = b.type === sc.type, pOk = po.tag === 'ok', pr = await prior('choose', sc.id);
          const xp = 5 * ((tOk && !pr.a ? 1 : 0) + (pOk && !pr.b ? 1 : 0));
          await tlog('choose', sc.id, tOk, pOk, 0, tOk ? '' : b.type); await skillRow('choose', tOk); await skillRow('choose', pOk); await award(xp, sc.id);
          return J({ type_ok: tOk, plan_ok: pOk, correct: sc.type, why: sc.why, plan_f: pOk ? 'Good plan!' : TR.tags[po.tag], best: sc.plan.find(p => p.tag === 'ok').t, xp });
        }
        if (m === 'GET' && path === '/api/transfer/repair') {
          const rt = TR.repair.find(x => x.id === url.searchParams.get('id')); if (!rt) return J({ error: 'Not found' }, 404);
          const T0 = D.types[rt.type];
          return J({ id: rt.id, type: rt.type, kind: T0.kind, title: rt.title, frame: T0.frame.map(f => ({ l: f.l, h: f.h })), parts: rt.parts, edit: rt.edit, diag: rt.diag.map((d, i) => ({ i, t: d.t })), targets: rt.targets.map(t => LABELS[t]) });
        }
        if (m === 'POST' && path === '/api/transfer/diagnose') {
          const rt = TR.repair.find(x => x.id === b.id), o = rt && rt.diag[b.choice | 0]; if (!o) return J({ error: 'Bad answer' }, 400);
          const pr = await prior('diag', rt.id), ok = !!o.ok;
          await tlog('diag', rt.id, ok, 0, 0, ok ? '' : String(b.choice | 0)); await skillRow('fix', ok); await award(ok && !pr.a ? 3 : 0, rt.id);
          return J({ ok, f: ok ? 'Yes! That is the main problem.' : o.f, best: rt.diag.find(d => d.ok).t });
        }
        if (m === 'POST' && path === '/api/transfer/fix') {
          const rt = TR.repair.find(x => x.id === b.id); if (!rt) return J({ error: 'Not found' }, 404);
          const text = cl(b.text, 1200), orig = rt.parts[rt.edit], norm = s => s.toLowerCase().replace(/[^a-z0-9’' ]+/g, ' ').split(/\s+/).filter(Boolean);
          const have = new Set(norm(orig)), fresh = norm(text).filter(x => !have.has(x)).length, changed = norm(text).join(' ') !== norm(orig).join(' ') && fresh >= 3;
          const parts = rt.parts.slice(); parts[rt.edit] = text;
          const res = check(rt.type, parts, D.types[rt.type].frame).results.filter(x => rt.targets.includes(x.id)).map(x => ({ label: LABELS[x.id], ok: x.ok || x.na, hint: x.hint }));
          const pass = changed && res.every(x => x.ok), pr = await prior('fix', rt.id), attempt = pr.n + 1;
          await tlog('fix', rt.id, pass, 0, attempt, ''); if (attempt === 1) await skillRow('fix', pass); await award(pass && !pr.a ? 15 : 0, rt.id);
          return J({ pass, changed, results: res, attempt, model: pass || attempt >= 3 ? rt.model : null, xp: pass && !pr.a ? 15 : 0 });
        }
        return J({ error: 'Not found' }, 404);
      }
      /* ---------- teacher ---------- */
      const sa = await staff(req, env);
      if (!sa) return J({ error: 'Teacher login required' }, 401);
      const su = sa.role === 'admin';
      const lab = (st, nd, i) => { try { return D.stories[st].n[nd].o[i].l; } catch (e) { return '?'; } };
      // Teachers only see the classes the super admin assigned to them (none by default)
      let cls = null;
      if (!su) cls = (await DB.prepare('SELECT class FROM teacher_classes WHERE teacher_id=?').bind(sa.pupil_id).all()).results.map(x => x.class);
      const sc = al => cls === null ? { q: '1', b: [] } : cls.length ? { q: `UPPER(TRIM(${al}.class)) IN (${cls.map(() => '?').join(',')})`, b: cls } : { q: '0', b: [] };
      const okC = c => cls === null || cls.includes(String(c || '').trim().toUpperCase());
      const all = async (q, ...a) => (await DB.prepare(q).bind(...a).all()).results;
      const pupilOf = async u => { const p = await DB.prepare('SELECT id,username,class,created FROM pupils WHERE username=?').bind(cl(u, 20).toLowerCase()).first(); return p && okC(p.class) ? p : null; };
      const bf = async s => { const need = await all(`SELECT p.id FROM pupils p WHERE ${s.q} AND p.id NOT IN (SELECT pupil_id FROM skill_log) AND p.id NOT IN (SELECT pupil_id FROM xp_log) AND (EXISTS (SELECT 1 FROM picks WHERE pupil_id=p.id) OR EXISTS (SELECT 1 FROM completions WHERE pupil_id=p.id)) LIMIT 40`, ...s.b); for (const x of need) await backfill(DB, x.id); };
      if (m === 'GET' && path === '/api/admin/summary') {
        const s = sc('p');
        await bf(s);
        const pupils0 = await all(`SELECT p.id,p.created,p.username,p.class,(SELECT COUNT(*) FROM picks WHERE pupil_id=p.id) npicks,
          (SELECT COUNT(DISTINCT story) FROM completions WHERE pupil_id=p.id) done,
          (SELECT COALESCE(SUM(m),0) FROM (SELECT MAX(points) m FROM completions WHERE pupil_id=p.id GROUP BY story)) points,
          (SELECT COUNT(*) FROM picks WHERE pupil_id=p.id AND tries>0) tries,
          (SELECT MAX(ts) FROM picks WHERE pupil_id=p.id) last_active FROM pupils p WHERE ${s.q} ORDER BY p.class,p.username`, ...s.b);
        // v1.6: skill mastery (last 20 first tries per skill), XP/rank and rule-based at-risk flags
        const sk = await all('SELECT pupil_id,skill,COUNT(*) n,SUM(ok) good FROM (SELECT pupil_id,skill,ok,ROW_NUMBER() OVER (PARTITION BY pupil_id,skill ORDER BY id DESC) rn FROM skill_log) WHERE rn<=20 GROUP BY pupil_id,skill');
        const l50 = Object.fromEntries((await all('SELECT pupil_id,COUNT(*) n,SUM(ok) good FROM (SELECT pupil_id,ok,ROW_NUMBER() OVER (PARTITION BY pupil_id ORDER BY id DESC) rn FROM skill_log) WHERE rn<=50 GROUP BY pupil_id')).map(x => [x.pupil_id, x]));
        const xps = Object.fromEntries((await all('SELECT pupil_id,SUM(xp) xp FROM xp_log GROUP BY pupil_id')).map(x => [x.pupil_id, x.xp]));
        const stuck = await all("SELECT DISTINCT pupil_id,story,node FROM picks WHERE tries>=3 AND ts>datetime('now','-14 days')");
        const now = Date.now(), tms = t => Date.parse(String(t).replace(' ', 'T') + 'Z');
        const pupils = pupils0.map(p => {
          const skills = {}; sk.filter(x => x.pupil_id === p.id).forEach(x => skills[x.skill] = [x.n, x.good]);
          const flags = [], a = l50[p.id];
          if (a && a.n >= 50 && a.good / a.n < 0.7) flags.push(`Low accuracy: ${Math.round(100 * a.good / a.n)}% first-try over the last 50 choices`);
          for (const [k, v] of Object.entries(skills)) if (v[0] >= 10 && v[1] / v[0] < 0.5) flags.push(`Weak skill: ${(D.skills[k] || {}).n || k} (${Math.round(100 * v[1] / v[0])}%)`);
          stuck.filter(x => x.pupil_id === p.id).forEach(x => flags.push(`Stuck: ${(D.stories[x.story] || {}).title || x.story}, step "${x.node}" (3+ retries)`));
          if (p.npicks && p.last_active && now - tms(p.last_active) > 14 * 864e5) flags.push('Inactive for 14+ days');
          if (!p.npicks && now - tms(p.created) > 7 * 864e5) flags.push('Not started (account is over 7 days old)');
          const xp = xps[p.id] || 0, { id, created, npicks, ...rest } = p;
          return { ...rest, xp, rank: rankOf(xp).n, skills, flags };
        });
        const ch = (await all(`SELECT k.story,k.node,k.idx,k.r,COUNT(*) n,CAST(AVG(k.ms)/1000 AS INT) secs FROM picks k JOIN pupils p ON p.id=k.pupil_id WHERE ${s.q} GROUP BY k.story,k.node,k.idx,k.r`, ...s.b)).map(x => ({ ...x, choice: lab(x.story, x.node, x.idx) }));
        const asg = (await all('SELECT class,story FROM assignments')).filter(x => okC(x.class));
        let classes;
        if (cls === null) { const set = new Set(); (await all('SELECT DISTINCT class FROM pupils')).forEach(x => x.class && set.add(x.class.trim().toUpperCase())); asg.forEach(x => set.add(x.class.trim().toUpperCase())); (await all('SELECT DISTINCT class FROM teacher_classes')).forEach(x => set.add(x.class)); classes = [...set].filter(Boolean).sort(); } else classes = [...cls].sort();
        return J({ pupils, choices: ch,
          completions: await all(`SELECT p.username,p.class,c.story,c.points,c.perfect,c.reflection,c.ts FROM completions c JOIN pupils p ON p.id=c.pupil_id WHERE ${s.q} ORDER BY c.ts DESC LIMIT 300`, ...s.b),
          writings: await all(`SELECT w.id,p.username,p.class,w.story,w.text,w.checks,w.comment,w.ts FROM writings w JOIN pupils p ON p.id=w.pupil_id WHERE ${s.q} ORDER BY w.id DESC LIMIT 300`, ...s.b),
          transfer: {
            choose: await all(`SELECT t.task,COUNT(*) n,SUM(t.a) a,SUM(t.b) b FROM transfer_log t JOIN pupils p ON p.id=t.pupil_id WHERE t.kind='choose' AND ${s.q} GROUP BY t.task`, ...s.b),
            wrong: await all(`SELECT t.task,t.wrong,COUNT(*) n FROM transfer_log t JOIN pupils p ON p.id=t.pupil_id WHERE t.kind='choose' AND t.wrong!='' AND ${s.q} GROUP BY t.task,t.wrong`, ...s.b),
            diag: await all(`SELECT t.task,COUNT(*) n,SUM(t.a) a FROM transfer_log t JOIN pupils p ON p.id=t.pupil_id WHERE t.kind='diag' AND ${s.q} GROUP BY t.task`, ...s.b),
            fix: await all(`SELECT t.task,COUNT(DISTINCT t.pupil_id) pupils,COUNT(DISTINCT CASE WHEN t.a=1 THEN t.pupil_id END) passed,COUNT(*) attempts FROM transfer_log t JOIN pupils p ON p.id=t.pupil_id WHERE t.kind='fix' AND ${s.q} GROUP BY t.task`, ...s.b)
          },
          transferTasks: { choose: TR.choose.map(x => ({ id: x.id, title: x.title, type: x.type })), repair: TR.repair.map(x => ({ id: x.id, title: x.title, type: x.type })) },
          assignments: asg, classes, checkLabels: LABELS,
          ai: await (async () => { const a = await aiState(env); return { enabled: a.enabled, daily: a.daily, providers: a.cfg }; })(),
          aiChecks: await all(`SELECT a.id,p.username,p.class,a.story,a.rule,a.snippet,a.verdicts,a.outcome,a.reason,a.source,a.reattempts,a.ts FROM ai_checks a JOIN pupils p ON p.id=a.pupil_id WHERE ${s.q} ORDER BY a.id DESC LIMIT 100`, ...s.b), skills: D.skills, ranks: RANKS, stories: Object.entries(D.stories).map(([id, s]) => ({ id, title: s.title, type: s.type })), types: TYPES });
      }
      if (m === 'GET' && path === '/api/admin/pupil') {
        const p = await pupilOf(url.searchParams.get('u')); if (!p) return J({ error: 'No such pupil in your classes' }, 404);
        const picks = (await all('SELECT story,node,idx,r,p,tries,ms,ts FROM picks WHERE pupil_id=? ORDER BY id DESC LIMIT 150', p.id)).map(x => ({ ...x, choice: lab(x.story, x.node, x.idx) }));
        return J({ pupil: p, picks, completions: await all('SELECT story,points,perfect,reflection,ts FROM completions WHERE pupil_id=? ORDER BY id DESC', p.id), writings: await all('SELECT id,story,text,comment,ts FROM writings WHERE pupil_id=? ORDER BY id DESC', p.id), sorts: await all('SELECT score,total,ts FROM sorts WHERE pupil_id=? ORDER BY id DESC LIMIT 10', p.id) });
      }
      if (m === 'POST' && path === '/api/admin/reset-pin') {
        const p = await pupilOf(b.username), pin = cl(b.pin, 8);
        if (!p) return J({ error: 'No such pupil in your classes' }, 404);
        if (!/^\d{4,8}$/.test(pin)) return J({ error: 'PIN must be 4-8 digits' }, 400);
        await DB.prepare('UPDATE pupils SET pin_hash=? WHERE id=?').bind(await sha(p.username + ':' + pin), p.id).run();
        return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/delete-pupil') {
        const p = await pupilOf(b.username); if (!p) return J({ error: 'No such pupil in your classes' }, 404);
        for (const t of ['picks', 'runs', 'completions', 'writings', 'sorts', 'sessions', 'skill_log', 'xp_log', 'ai_checks', 'transfer_log']) await DB.prepare(`DELETE FROM ${t} WHERE pupil_id=?`).bind(p.id).run();
        await DB.prepare('DELETE FROM pupils WHERE id=?').bind(p.id).run();
        return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/bulk') {
        const cn = cl(b.class, 20).toUpperCase(), out = [];
        if (!okC(cn)) return J({ error: 'You can only add pupils to your own classes' }, 403);
        for (const raw of (Array.isArray(b.names) ? b.names : []).slice(0, 60)) {
          let base = cl(raw, 40).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16); if (base.length < 3) continue;
          let u = base, k = 1; while (await DB.prepare('SELECT 1 FROM pupils WHERE username=?').bind(u).first()) u = base + (++k);
          const pin = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
          await DB.prepare('INSERT INTO pupils(username,class,pin_hash) VALUES(?,?,?)').bind(u, cn, await sha(u + ':' + pin)).run();
          out.push({ name: cl(raw, 40), username: u, pin, class: cn });
        }
        return J({ created: out });
      }
      if (m === 'POST' && path === '/api/admin/comment') {
        const r = await DB.prepare('SELECT p.class FROM writings w JOIN pupils p ON p.id=w.pupil_id WHERE w.id=?').bind(b.id | 0).first();
        if (!r || !okC(r.class)) return J({ error: 'Not found in your classes' }, 404);
        await DB.prepare('UPDATE writings SET comment=? WHERE id=?').bind(cl(b.comment, 500), b.id | 0).run(); return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/assign') {
        if (!D.stories[b.story]) return J({ error: 'Bad story' }, 400);
        const cn = cl(b.class, 20).toUpperCase(); if (!cn || !okC(cn)) return J({ error: 'Not one of your classes' }, 403);
        await (b.on ? DB.prepare('INSERT OR IGNORE INTO assignments(class,story) VALUES(?,?)').bind(cn, b.story) : DB.prepare('DELETE FROM assignments WHERE UPPER(TRIM(class))=? AND story=?').bind(cn, b.story)).run();
        return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/ai-settings') {
        if (!su) return J({ error: 'Super admin only' }, 403);
        await setSet(DB, 'ai_enabled', b.enabled ? '1' : '0'); await setSet(DB, 'ai_daily', Math.max(1, Math.min(20, b.daily | 0 || 5)));
        return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/ai-reattempt') {
        // Teacher re-attempt: Workers AI + Grok only
        const ai = await aiState(env); if (!ai.on) return J({ error: 'The AI helper is off (super admin setting).' }, 403);
        const a = await DB.prepare('SELECT a.*,p.class pclass FROM ai_checks a JOIN pupils p ON p.id=a.pupil_id WHERE a.id=?').bind(b.id | 0).first();
        if (!a || !okC(a.pclass)) return J({ error: 'Not found in your classes' }, 404);
        if (a.reattempts >= 3) return J({ error: 'Already re-checked 3 times.' }, 429);
        const list = ['workers', 'grok'].filter(k => ai.cfg[k]); if (!list.length) return J({ error: 'Workers AI and Grok are not set up.' }, 400);
        const jr = await judge(env, a.rule, JSON.parse(a.snippet), list);
        await DB.prepare("UPDATE ai_checks SET verdicts=?,outcome=?,reason=?,source='teacher',reattempts=reattempts+1 WHERE id=?").bind(JSON.stringify(jr.verdicts), jr.outcome, jr.reason, a.id).run();
        if (jr.outcome === 'met' && a.writing_id) {
          const w0 = await DB.prepare('SELECT checks FROM writings WHERE id=?').bind(a.writing_id).first();
          if (w0) { let arr = []; try { arr = JSON.parse(w0.checks); } catch (e) { } await DB.prepare('UPDATE writings SET checks=? WHERE id=?').bind(JSON.stringify(arr.map(x => Array.isArray(x) && x[0] === a.rule ? [x[0], 1, 1] : x)), a.writing_id).run(); }
        }
        return J({ ok: 1, outcome: jr.outcome, reason: jr.reason });
      }
      /* ---------- teacher accounts (super admin only, except own password) ---------- */
      if (m === 'GET' && path === '/api/admin/teachers') { if (!su) return J({ error: 'Super admin only' }, 403); return J({ teachers: (await all('SELECT t.username,t.created,GROUP_CONCAT(c.class) classes FROM teachers t LEFT JOIN teacher_classes c ON c.teacher_id=t.id GROUP BY t.id ORDER BY t.username')).map(t => ({ ...t, classes: t.classes ? t.classes.split(',') : [] })) }); }
      if (m === 'POST' && path === '/api/admin/teacher-classes') {
        if (!su) return J({ error: 'Super admin only' }, 403);
        const t = await DB.prepare('SELECT id FROM teachers WHERE username=?').bind(cl(b.username, 30).toLowerCase()).first(); if (!t) return J({ error: 'No such teacher' }, 404);
        const list = [...new Set((Array.isArray(b.classes) ? b.classes : []).map(x => cl(x, 20).replace(/,/g, '').toUpperCase()).filter(Boolean))].slice(0, 30);
        await DB.prepare('DELETE FROM teacher_classes WHERE teacher_id=?').bind(t.id).run();
        for (const c of list) await DB.prepare('INSERT INTO teacher_classes(teacher_id,class) VALUES(?,?)').bind(t.id, c).run();
        return J({ ok: 1, classes: list });
      }
      if (m === 'POST' && path === '/api/admin/teacher-create') {
        if (!su) return J({ error: 'Super admin only' }, 403);
        const u = cl(b.username, 30).toLowerCase(), p = cl(b.password, 100);
        if (!/^[a-z0-9_.-]{3,30}$/.test(u) || u === String(env.admin_user || 'admin123').toLowerCase()) return J({ error: 'Username: 3-30 letters or numbers (not the super admin name)' }, 400);
        if (p.length < 8) return J({ error: 'Password needs at least 8 characters' }, 400);
        if (await DB.prepare('SELECT 1 FROM teachers WHERE username=?').bind(u).first()) return J({ error: 'That teacher already exists' }, 409);
        const salt = hx(crypto.getRandomValues(new Uint8Array(16)));
        await DB.prepare('INSERT INTO teachers(username,salt,hash) VALUES(?,?,?)').bind(u, salt, await pw(p, salt)).run();
        return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/teacher-reset') {
        if (!su) return J({ error: 'Super admin only' }, 403);
        const u = cl(b.username, 30).toLowerCase(), p = cl(b.password, 100);
        if (p.length < 8) return J({ error: 'Password needs at least 8 characters' }, 400);
        const t = await DB.prepare('SELECT id FROM teachers WHERE username=?').bind(u).first(); if (!t) return J({ error: 'No such teacher' }, 404);
        const salt = hx(crypto.getRandomValues(new Uint8Array(16)));
        await DB.prepare('UPDATE teachers SET salt=?,hash=? WHERE id=?').bind(salt, await pw(p, salt), t.id).run();
        await DB.prepare("DELETE FROM sessions WHERE role='teacher' AND pupil_id=?").bind(t.id).run();
        return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/teacher-delete') {
        if (!su) return J({ error: 'Super admin only' }, 403);
        const t = await DB.prepare('SELECT id FROM teachers WHERE username=?').bind(cl(b.username, 30).toLowerCase()).first(); if (!t) return J({ error: 'No such teacher' }, 404);
        await DB.prepare("DELETE FROM sessions WHERE role='teacher' AND pupil_id=?").bind(t.id).run();
        await DB.prepare('DELETE FROM teacher_classes WHERE teacher_id=?').bind(t.id).run();
        await DB.prepare('DELETE FROM teachers WHERE id=?').bind(t.id).run();
        return J({ ok: 1 });
      }
      if (m === 'POST' && path === '/api/admin/change-password') {
        if (su) return J({ error: 'The super admin password is a Cloudflare secret' }, 400);
        const t = await DB.prepare('SELECT * FROM teachers WHERE id=?').bind(sa.pupil_id).first(), p = cl(b.password, 100);
        if (!t || !same(t.hash, await pw(cl(b.old, 100), t.salt))) return J({ error: 'Current password is wrong' }, 401);
        if (p.length < 8) return J({ error: 'Password needs at least 8 characters' }, 400);
        const salt = hx(crypto.getRandomValues(new Uint8Array(16)));
        await DB.prepare('UPDATE teachers SET salt=?,hash=? WHERE id=?').bind(salt, await pw(p, salt), t.id).run();
        return J({ ok: 1 });
      }
      return J({ error: 'Not found' }, 404);
    } catch (e) { return J({ error: 'Server error' }, 500); }
  }
};
