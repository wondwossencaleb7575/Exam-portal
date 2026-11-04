-- School-wide settings (single school per installation). One row, enforced.
CREATE TABLE school_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  school_name TEXT NOT NULL DEFAULT 'Eagle Labs Exam Portal',
  timezone TEXT NOT NULL DEFAULT 'Africa/Addis_Ababa',
  locale TEXT NOT NULL DEFAULT 'en' CHECK(locale IN ('en','am')),
  calendar TEXT NOT NULL DEFAULT 'gregory' CHECK(calendar IN ('gregory','ethiopic')),
  default_pass_mark REAL NOT NULL DEFAULT 50 CHECK(default_pass_mark BETWEEN 0 AND 100),
  grading_scale TEXT NOT NULL DEFAULT '[]',                      -- JSON [{"min":90,"label":"A"},...]; empty = no letter grades
  terms TEXT NOT NULL DEFAULT '["Semester 1","Semester 2"]',     -- JSON list; schools edit freely (terms, semesters, quarters)
  brand_color TEXT NOT NULL DEFAULT '#0b1f4d',
  updated INTEGER NOT NULL DEFAULT 0
);
INSERT INTO school_settings(id) VALUES(1);

-- Exam metadata. pass_mark NULL = use the school default. All nullable: existing exams are untouched.
ALTER TABLE exams ADD COLUMN pass_mark REAL;
ALTER TABLE exams ADD COLUMN academic_year TEXT;
ALTER TABLE exams ADD COLUMN term TEXT;
ALTER TABLE exams ADD COLUMN grade TEXT;

-- Search and report performance (name search, student-number lookup, analytics joins).
CREATE INDEX idx_users_role_name ON users(role, name COLLATE NOCASE);
CREATE INDEX idx_users_student_number ON users(student_number COLLATE NOCASE) WHERE student_number IS NOT NULL;
CREATE INDEX idx_exams_year ON exams(academic_year, term);
CREATE INDEX idx_attempts_grading ON attempts(exam_id, grading_status, status);

-- Student numbers must be unique. Triggers (not a UNIQUE index) so that an existing database that already holds
-- duplicate numbers can still upgrade; the rule applies to every new insert/update from now on.
CREATE TRIGGER users_student_number_ins BEFORE INSERT ON users
WHEN NEW.student_number IS NOT NULL AND NEW.student_number != '' AND EXISTS(SELECT 1 FROM users WHERE student_number = NEW.student_number COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT,'student number already in use'); END;
CREATE TRIGGER users_student_number_upd BEFORE UPDATE OF student_number ON users
WHEN NEW.student_number IS NOT NULL AND NEW.student_number != '' AND EXISTS(SELECT 1 FROM users WHERE student_number = NEW.student_number COLLATE NOCASE AND id != NEW.id)
BEGIN SELECT RAISE(ABORT,'student number already in use'); END;
