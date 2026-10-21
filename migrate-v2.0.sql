-- Flashback Detectives v2.0: classes with codes, no PINs. This is exactly what the Worker runs automatically on its first request after the
-- upgrade (src/migrate.js), so you do NOT need to run it yourself. It is here so you can read it, or run it by hand:
--   npx wrangler d1 export flashback-db --remote --output=backup-before-v2.0.sql     (back up first)
--   npx wrangler d1 execute flashback-db --remote --file=./migrate-v2.0.sql
-- Run it once, on a v1.9 database only (it fails harmlessly on a v2.0 one). The timestamp 0 below only stamps the new classes' created_at.
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS classes(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, sess_ver INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

INSERT INTO classes(name, code, sess_ver, archived, created_at)
  SELECT n, substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1), 1, 0, 0 FROM (
  SELECT UPPER(TRIM(class)) AS n FROM pupils WHERE TRIM(COALESCE(class, '')) <> ''
  UNION SELECT UPPER(TRIM(class)) FROM teacher_classes WHERE TRIM(COALESCE(class, '')) <> ''
  UNION SELECT UPPER(TRIM(class)) FROM assignments WHERE TRIM(COALESCE(class, '')) <> ''
  ) ORDER BY n;

INSERT INTO classes(name, code, sess_ver, archived, created_at)
  SELECT 'Unassigned', substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1) || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + abs(random()) % 31, 1), 1, 0, 0
  WHERE EXISTS (SELECT 1 FROM pupils WHERE TRIM(COALESCE(class, '')) = '')
  AND NOT EXISTS (SELECT 1 FROM classes WHERE name = 'Unassigned');

ALTER TABLE pupils RENAME TO pupils_old;

CREATE TABLE pupils(id INTEGER PRIMARY KEY AUTOINCREMENT, class_id INTEGER, name TEXT NOT NULL, username TEXT NOT NULL, is_guest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER, UNIQUE(class_id, username));

INSERT OR IGNORE INTO pupils(id, class_id, name, username, is_guest, created_at, last_seen)
  SELECT o.id,
  (SELECT c.id FROM classes c WHERE c.name = CASE WHEN TRIM(COALESCE(o.class, '')) = '' THEN 'Unassigned' ELSE UPPER(TRIM(o.class)) END),
  o.username,
  CASE WHEN (lower(replace(replace(replace(replace(trim(o.username), ' ', ''), char(9), ''), char(10), ''), char(13), '')) GLOB '[a-z0-9]*' AND lower(replace(replace(replace(replace(trim(o.username), ' ', ''), char(9), ''), char(10), ''), char(13), '')) NOT GLOB '*[^a-z0-9._-]*' AND length(lower(replace(replace(replace(replace(trim(o.username), ' ', ''), char(9), ''), char(10), ''), char(13), ''))) BETWEEN 2 AND 24) THEN lower(replace(replace(replace(replace(trim(o.username), ' ', ''), char(9), ''), char(10), ''), char(13), '')) ELSE 'pupil' || o.id END,
  0,
  COALESCE(CAST(strftime('%s', o.created) AS INTEGER) * 1000, 0),
  NULL
  FROM pupils_old o ORDER BY o.id;

INSERT OR IGNORE INTO pupils(id, class_id, name, username, is_guest, created_at, last_seen)
  SELECT o.id,
  (SELECT c.id FROM classes c WHERE c.name = CASE WHEN TRIM(COALESCE(o.class, '')) = '' THEN 'Unassigned' ELSE UPPER(TRIM(o.class)) END),
  o.username, 'pupil' || o.id, 0,
  COALESCE(CAST(strftime('%s', o.created) AS INTEGER) * 1000, 0), NULL
  FROM pupils_old o WHERE o.id NOT IN (SELECT id FROM pupils);

INSERT OR IGNORE INTO pupils(id, class_id, name, username, is_guest, created_at, last_seen)
  SELECT o.id,
  (SELECT c.id FROM classes c WHERE c.name = CASE WHEN TRIM(COALESCE(o.class, '')) = '' THEN 'Unassigned' ELSE UPPER(TRIM(o.class)) END),
  o.username, 'p' || o.id || '-' || lower(hex(randomblob(4))), 0,
  COALESCE(CAST(strftime('%s', o.created) AS INTEGER) * 1000, 0), NULL
  FROM pupils_old o WHERE o.id NOT IN (SELECT id FROM pupils);

SELECT CASE WHEN (SELECT COUNT(*) FROM pupils) <> (SELECT COUNT(*) FROM pupils_old) THEN abs(-9223372036854775807 - 1) END;

ALTER TABLE teacher_classes RENAME TO teacher_classes_old;

CREATE TABLE teacher_classes(teacher_id INTEGER, class_id INTEGER, PRIMARY KEY(teacher_id, class_id));

INSERT OR IGNORE INTO teacher_classes(teacher_id, class_id) SELECT t.teacher_id, c.id FROM teacher_classes_old t JOIN classes c ON c.name = UPPER(TRIM(t.class));

ALTER TABLE assignments RENAME TO assignments_old;

CREATE TABLE assignments(class_id INTEGER, story TEXT, PRIMARY KEY(class_id, story));

INSERT OR IGNORE INTO assignments(class_id, story) SELECT c.id, a.story FROM assignments_old a JOIN classes c ON c.name = UPPER(TRIM(a.class));

DROP TABLE pupils_old;

DROP TABLE teacher_classes_old;

DROP TABLE assignments_old;

DROP TABLE IF EXISTS sessions;
