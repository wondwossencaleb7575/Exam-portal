-- Eagle Labs Exam Portal: initial schema
CREATE TABLE users(
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')),
  student_number TEXT,
  pw_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  must_change INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE subjects(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
INSERT INTO subjects(name) VALUES('Mathematics');

CREATE TABLE classes(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  grade TEXT,
  academic_year TEXT,
  subject_id INTEGER REFERENCES subjects(id),
  created_by INTEGER REFERENCES users(id),
  created INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE class_members(
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('teacher','student')),
  PRIMARY KEY(class_id, user_id)
);
CREATE INDEX idx_members_user ON class_members(user_id);

CREATE TABLE images(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created INTEGER NOT NULL
);

-- Reusable question bank
CREATE TABLE questions(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  subject_id INTEGER REFERENCES subjects(id),
  type TEXT NOT NULL,
  stem TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  key TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT '{}',
  marks REAL NOT NULL DEFAULT 1,
  topic TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  explanation TEXT NOT NULL DEFAULT '',
  image_id INTEGER REFERENCES images(id),
  version INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_questions_owner ON questions(owner_id, archived, topic);

CREATE TABLE exams(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  subject_id INTEGER REFERENCES subjects(id),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 30,
  opens INTEGER,
  closes INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed','archived')),
  max_attempts INTEGER NOT NULL DEFAULT 1,
  shuffle_q INTEGER NOT NULL DEFAULT 0,
  shuffle_o INTEGER NOT NULL DEFAULT 0,
  release_mode TEXT NOT NULL DEFAULT 'manual' CHECK(release_mode IN ('manual','on_finalize','immediate')),
  show_answers INTEGER NOT NULL DEFAULT 0,
  grace_s INTEGER NOT NULL DEFAULT 15,
  declared_total REAL,
  version INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX idx_exams_owner ON exams(owner_id, status);
CREATE TABLE exam_classes(
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  PRIMARY KEY(exam_id, class_id)
);
-- Exam-specific snapshots of question content (never rewritten by bank edits)
CREATE TABLE exam_questions(
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  source_qid INTEGER REFERENCES questions(id),
  source_version INTEGER,
  type TEXT NOT NULL,
  stem TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  key TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT '{}',
  marks REAL NOT NULL DEFAULT 1,
  topic TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  explanation TEXT NOT NULL DEFAULT '',
  image_id INTEGER REFERENCES images(id)
);
CREATE INDEX idx_eq_exam ON exam_questions(exam_id, pos);

CREATE TABLE accommodations(
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  extra_minutes INTEGER NOT NULL DEFAULT 0,
  extra_attempts INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(exam_id, student_id)
);

CREATE TABLE attempts(
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  attempt_no INTEGER NOT NULL,
  started INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  extra_s INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','submitted','auto_submitted')),
  submitted_at INTEGER,
  receipt TEXT,
  seed INTEGER NOT NULL,
  score REAL,
  total REAL,
  grading_status TEXT CHECK(grading_status IN ('pending','graded')),
  finalized_at INTEGER,
  finalized_by INTEGER REFERENCES users(id),
  released_at INTEGER,
  UNIQUE(exam_id, student_id, attempt_no)
);
CREATE UNIQUE INDEX one_active_attempt ON attempts(exam_id, student_id) WHERE status='in_progress';
CREATE INDEX idx_attempts_exam ON attempts(exam_id, status);
CREATE INDEX idx_attempts_student ON attempts(student_id);

CREATE TABLE answers(
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  eq_id INTEGER NOT NULL REFERENCES exam_questions(id),
  value TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  PRIMARY KEY(attempt_id, eq_id)
);
CREATE TABLE grades(
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  eq_id INTEGER NOT NULL REFERENCES exam_questions(id),
  marks REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('auto','pending','graded')),
  feedback TEXT NOT NULL DEFAULT '',
  graded_by INTEGER REFERENCES users(id),
  graded_at INTEGER,
  PRIMARY KEY(attempt_id, eq_id)
);
CREATE TABLE grade_history(
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL,
  eq_id INTEGER NOT NULL,
  old_marks REAL,
  new_marks REAL NOT NULL,
  old_status TEXT,
  by_user INTEGER NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE attempt_events(
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX idx_events_attempt ON attempt_events(attempt_id);

-- Append-only audit trail
CREATE TABLE audit(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_id INTEGER,
  actor_email TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  resource_id INTEGER,
  detail TEXT
);
CREATE INDEX idx_audit_ts ON audit(ts);
CREATE INDEX idx_audit_actor ON audit(actor_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER gh_no_update BEFORE UPDATE ON grade_history BEGIN SELECT RAISE(ABORT,'grade history is append-only'); END;
CREATE TRIGGER gh_no_delete BEFORE DELETE ON grade_history BEGIN SELECT RAISE(ABORT,'grade history is append-only'); END;
