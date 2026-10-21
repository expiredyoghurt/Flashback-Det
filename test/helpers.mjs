// Shared test harness: a real SQLite database behind the D1 interface, and helpers to call the Worker.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { resetMigrationState } from '../src/migrate.js';

export const file = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

// Statements are compiled when they run, like D1 does (a batch may create a table and use it in a later statement).
export function d1(db) {
  const wrap = (sql) => {
    let args = [];
    const st = () => db.prepare(sql);
    const o = {
      bind: (...a) => ((args = a), o),
      first: async () => st().get(...args) ?? null,
      all: async () => ({ results: st().all(...args) }),
      run: async () => { const r = st().run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
    };
    return o;
  };
  return {
    prepare: wrap,
    // D1 batches are atomic: all statements or none
    batch: async (list) => {
      db.exec('BEGIN');
      try {
        for (const s of list) await s.run();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return [];
    },
  };
}

export const SECRETS = { teacher_user: 'palpatine', teacher_password: 'correct horse battery' };

export function freshEnv(extra = {}) {
  resetMigrationState();
  const db = new DatabaseSync(':memory:');
  db.exec(file('schema.sql'));
  return { db, env: { DB: d1(db), ...SECRETS, ...extra } };
}
// A database exactly as v1.9 left it (the v1.9 schema, with the data shapes the old code wrote).
export function oldEnv(extra = {}) {
  resetMigrationState();
  const db = new DatabaseSync(':memory:');
  db.exec(file('test/schema-v1.9.sql'));
  return { db, env: { DB: d1(db), ...SECRETS, ...extra } };
}

export async function call(env, method, path, { body, token, ip = '1.1.1.1' } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await worker.fetch(new Request('https://x' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
export const teacherLogin = async (env, user = SECRETS.teacher_user, password = SECRETS.teacher_password) => (await call(env, 'POST', '/api/admin/login', { body: { user, password } })).json?.token;
