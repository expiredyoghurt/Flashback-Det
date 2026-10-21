// One-time upgrade from v1.9 (username + PIN, free-text classes) to v2.0 (class codes, real classes).
// It runs by itself on the first request after a deploy, as ONE atomic D1 batch, so no manual SQL step is needed and a half-finished
// upgrade can't happen. It is safe on every database: a v2.0 database (fresh or already upgraded) is detected and left alone.
//
// What it does: every free-text class name becomes a class with its own code; pupils keep their ids (so every result, writing and XP
// row stays attached to the right pupil) and get a class_id; usernames are tidied to the new rules (lowercase, 2-24 of a-z 0-9 . _ -);
// pupils with no class go into a class called "Unassigned"; teacher class rights and assigned stories are re-pointed at class ids.
// PIN hashes, old sessions and the old tables are then dropped.

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const pick = () => `substr('${CODE_CHARS}', 1 + abs(random()) % ${CODE_CHARS.length}, 1)`;
const CODE_SQL = Array.from({ length: 6 }, pick).join(' || ');

// A pupil's old username, tidied: lowercase, no spaces; if that is not a valid new username it becomes pupil<id>.
const NORM = "lower(replace(replace(replace(replace(trim(o.username), ' ', ''), char(9), ''), char(10), ''), char(13), ''))";
const VALID = (x) => `(${x} GLOB '[a-z0-9]*' AND ${x} NOT GLOB '*[^a-z0-9._-]*' AND length(${x}) BETWEEN 2 AND 24)`;

export const NEW_TABLES = [
  `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS classes(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, sess_ver INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
];

export function migrationStatements(now = Date.now()) {
  return [
    ...NEW_TABLES,
    // 1. a class for every class name ever used by a pupil, a teacher or an assignment (names were matched ignoring case and spaces)
    `INSERT INTO classes(name, code, sess_ver, archived, created_at)
       SELECT n, ${CODE_SQL}, 1, 0, ${now} FROM (
         SELECT UPPER(TRIM(class)) AS n FROM pupils WHERE TRIM(COALESCE(class, '')) <> ''
         UNION SELECT UPPER(TRIM(class)) FROM teacher_classes WHERE TRIM(COALESCE(class, '')) <> ''
         UNION SELECT UPPER(TRIM(class)) FROM assignments WHERE TRIM(COALESCE(class, '')) <> ''
       ) ORDER BY n`,
    // 2. pupils who had no class go into "Unassigned", so they can still sign in (the teacher can edit or move them)
    `INSERT INTO classes(name, code, sess_ver, archived, created_at)
       SELECT 'Unassigned', ${CODE_SQL}, 1, 0, ${now}
        WHERE EXISTS (SELECT 1 FROM pupils WHERE TRIM(COALESCE(class, '')) = '')
          AND NOT EXISTS (SELECT 1 FROM classes WHERE name = 'Unassigned')`,
    // 3. rebuild pupils: same ids, no PIN, a class_id, a display name and a tidy username
    `ALTER TABLE pupils RENAME TO pupils_old`,
    `CREATE TABLE pupils(id INTEGER PRIMARY KEY AUTOINCREMENT, class_id INTEGER, name TEXT NOT NULL, username TEXT NOT NULL, is_guest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER, UNIQUE(class_id, username))`,
    // oldest account first: when two pupils in one class tidy to the same username, the older one keeps it
    `INSERT OR IGNORE INTO pupils(id, class_id, name, username, is_guest, created_at, last_seen)
       SELECT o.id,
              (SELECT c.id FROM classes c WHERE c.name = CASE WHEN TRIM(COALESCE(o.class, '')) = '' THEN 'Unassigned' ELSE UPPER(TRIM(o.class)) END),
              o.username,
              CASE WHEN ${VALID(NORM)} THEN ${NORM} ELSE 'pupil' || o.id END,
              0,
              COALESCE(CAST(strftime('%s', o.created) AS INTEGER) * 1000, ${now}),
              NULL
         FROM pupils_old o ORDER BY o.id`,
    // anyone whose tidy username was already taken in their class (two pupils who differed only by case) gets a unique one
    `INSERT OR IGNORE INTO pupils(id, class_id, name, username, is_guest, created_at, last_seen)
       SELECT o.id,
              (SELECT c.id FROM classes c WHERE c.name = CASE WHEN TRIM(COALESCE(o.class, '')) = '' THEN 'Unassigned' ELSE UPPER(TRIM(o.class)) END),
              o.username, 'pupil' || o.id, 0,
              COALESCE(CAST(strftime('%s', o.created) AS INTEGER) * 1000, ${now}), NULL
         FROM pupils_old o WHERE o.id NOT IN (SELECT id FROM pupils)`,
    `INSERT OR IGNORE INTO pupils(id, class_id, name, username, is_guest, created_at, last_seen)
       SELECT o.id,
              (SELECT c.id FROM classes c WHERE c.name = CASE WHEN TRIM(COALESCE(o.class, '')) = '' THEN 'Unassigned' ELSE UPPER(TRIM(o.class)) END),
              o.username, 'p' || o.id || '-' || lower(hex(randomblob(4))), 0,
              COALESCE(CAST(strftime('%s', o.created) AS INTEGER) * 1000, ${now}), NULL
         FROM pupils_old o WHERE o.id NOT IN (SELECT id FROM pupils)`,
    // safety net: if any pupil failed to carry over, this raises an error and the whole upgrade is rolled back
    `SELECT CASE WHEN (SELECT COUNT(*) FROM pupils) <> (SELECT COUNT(*) FROM pupils_old) THEN abs(-9223372036854775807 - 1) END`,
    // 4. teacher class rights and assigned stories now point at class ids
    `ALTER TABLE teacher_classes RENAME TO teacher_classes_old`,
    `CREATE TABLE teacher_classes(teacher_id INTEGER, class_id INTEGER, PRIMARY KEY(teacher_id, class_id))`,
    `INSERT OR IGNORE INTO teacher_classes(teacher_id, class_id) SELECT t.teacher_id, c.id FROM teacher_classes_old t JOIN classes c ON c.name = UPPER(TRIM(t.class))`,
    `ALTER TABLE assignments RENAME TO assignments_old`,
    `CREATE TABLE assignments(class_id INTEGER, story TEXT, PRIMARY KEY(class_id, story))`,
    `INSERT OR IGNORE INTO assignments(class_id, story) SELECT c.id, a.story FROM assignments_old a JOIN classes c ON c.name = UPPER(TRIM(a.class))`,
    // 5. nothing of the old sign-in is kept: PIN hashes, session tokens, the old tables
    `DROP TABLE pupils_old`,
    `DROP TABLE teacher_classes_old`,
    `DROP TABLE assignments_old`,
    `DROP TABLE IF EXISTS sessions`,
  ];
}

// Is this a v1.9 database that still needs the upgrade? (v1.9 pupils have a pin_hash column and no class_id.)
export async function needsMigration(DB) {
  const cols = (await DB.prepare('PRAGMA table_info(pupils)').all()).results.map((c) => c.name);
  return cols.length > 0 && cols.includes('pin_hash') && !cols.includes('class_id');
}

let ready = null;
export function ensureSchema(env) {
  if (!ready) {
    ready = (async () => {
      if (!(await needsMigration(env.DB))) return;
      try {
        await env.DB.batch(migrationStatements().map((s) => env.DB.prepare(s)));
      } catch (e) {
        // another request may have finished the upgrade a moment ago: that is fine, anything else is a real problem
        if (await needsMigration(env.DB)) throw e;
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
export const resetMigrationState = () => { ready = null; }; // for tests

// The same statements as a plain .sql file (migrate-v2.0.sql), for anyone who prefers to run it by hand.
export function migrationSql(now = 0) {
  const body = migrationStatements(now).map((s) => s.replace(/\n\s+/g, '\n  ') + ';').join('\n\n');
  return `-- Flashback Detectives v2.0: classes with codes, no PINs. This is exactly what the Worker runs automatically on its first request after the
-- upgrade (src/migrate.js), so you do NOT need to run it yourself. It is here so you can read it, or run it by hand:
--   npx wrangler d1 export flashback-db --remote --output=backup-before-v2.0.sql     (back up first)
--   npx wrangler d1 execute flashback-db --remote --file=./migrate-v2.0.sql
-- Run it once, on a v1.9 database only (it fails harmlessly on a v2.0 one). The timestamp 0 below only stamps the new classes' created_at.
${body}
`;
}
