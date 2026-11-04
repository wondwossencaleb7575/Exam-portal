-- Direct (individual) exam enrollment. Class-based access via exam_classes is unchanged.
-- Enrollment is NOT an attempt: no attempt row or timer is created by enrolling.
CREATE TABLE exam_students(
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  enrolled_by INTEGER REFERENCES users(id),
  enrolled_at INTEGER NOT NULL,
  PRIMARY KEY(exam_id, student_id)
);
CREATE INDEX idx_exam_students_student ON exam_students(student_id);
-- Defence in depth: only student accounts can be enrolled, even if application code is bypassed.
CREATE TRIGGER exam_students_role BEFORE INSERT ON exam_students
WHEN COALESCE((SELECT role FROM users WHERE id=NEW.student_id),'') != 'student'
BEGIN SELECT RAISE(ABORT,'only student accounts can be enrolled'); END;
