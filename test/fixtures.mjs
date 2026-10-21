// A v1.9 database as a real school would have it: messy class spellings, odd usernames, pupils with no class, progress everywhere.
export function v19(db) {
  const pup = db.prepare("INSERT INTO pupils(username, class, pin_hash, created) VALUES (?, ?, 'pinhash', ?)");
  pup.run('Raj', '4A', '2025-03-01 09:00:00');      // 1
  pup.run('mei', ' 4a ', '2025-03-02 09:00:00');    // 2  same class, different spelling
  pup.run('Sam', '4B', '2025-03-03 09:00:00');      // 3
  pup.run('sam', '4B', '2025-03-04 09:00:00');      // 4  differs from Sam only by case
  pup.run('Samuel', '4A', '2025-03-05 09:00:00');   // 5
  pup.run("O'Brien", '4B', '2025-03-06 09:00:00');  // 6  apostrophe: not allowed any more
  pup.run('x', '4B', '2025-03-07 09:00:00');        // 7  too short
  pup.run('Anna Lee', '4a', '2025-03-08 09:00:00'); // 8  space inside
  pup.run('loner', null, '2025-03-09 09:00:00');    // 9  no class
  pup.run('empty', '  ', '2025-03-10 09:00:00');    // 10 blank class
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    db.prepare("INSERT INTO picks(pupil_id, story, node, idx, r, p) VALUES (?, 's', 'n', 0, 'x', 1)").run(id);
    db.prepare("INSERT INTO completions(pupil_id, story, points, perfect) VALUES (?, 's', 5, 1)").run(id);
    db.prepare("INSERT INTO xp_log(pupil_id, xp) VALUES (?, ?)").run(id, id * 10);
    db.prepare("INSERT INTO sessions(token, role, pupil_id) VALUES (?, 'pupil', ?)").run('tok' + id, id);
  }
  db.exec("INSERT INTO teachers(username, salt, hash) VALUES ('ms.lee', 's', 'h'), ('mr.tan', 's', 'h')");
  db.exec("INSERT INTO teacher_classes(teacher_id, class) VALUES (1, '4A'), (1, '5C'), (2, '4B')");
  db.exec("INSERT INTO assignments(class, story) VALUES ('4A', 'story-one'), ('4b', 'story-two'), ('6Z', 'story-three')");
  db.exec("INSERT INTO settings(key, value) VALUES ('ai_enabled', '1')");
}
