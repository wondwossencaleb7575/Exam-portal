// Creates DUMMY data for a pilot: 1 teacher, 3 students, 1 class, 6 questions, 1 published exam. Never use on production data.
const A = require('../lib/auth'), { db, tx, close } = require('../lib/db');
(async () => {
  const hash = await A.hashPw('Demo-Pass-2026'), now = Date.now();
  const mk = (email, name, role, num) => db.prepare('INSERT INTO users(email,name,role,student_number,pw_hash,created) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(email, name, role, num || null, hash, now);
  await mk('teacher@demo.local', 'Demo Teacher', 'teacher'); for (let i = 1; i <= 3; i++) await mk(`student${i}@demo.local`, `Demo Student ${i}`, 'student', `S00${i}`);
  const t = (await db.prepare("SELECT id FROM users WHERE email='teacher@demo.local'").get()).id;
  await tx(async () => {
    const cid = (await db.prepare("INSERT INTO classes(name,grade,academic_year,subject_id,created_by,created) VALUES('Grade 10A','10','2026/27',1,?,?) RETURNING id").run(t, now)).lastInsertRowid;
    await db.prepare("INSERT INTO class_members(class_id,user_id,role) VALUES(?,?,'teacher')").run(cid, t);
    for (const u of await db.prepare("SELECT id FROM users WHERE role='student' AND email LIKE '%@demo.local'").all()) await db.prepare("INSERT INTO class_members(class_id,user_id,role) VALUES(?,?,'student') ON CONFLICT DO NOTHING").run(cid, u.id);
    const eid = (await db.prepare("INSERT INTO exams(owner_id,subject_id,title,instructions,minutes,status,release_mode,show_answers,created,updated,published_at) VALUES(?,1,'Algebra quiz (demo)','Answer all questions. Written answers may use LaTeX between dollar signs.',20,'published','manual',1,?,?,?) RETURNING id").run(t, now, now, now)).lastInsertRowid;
    await db.prepare('INSERT INTO exam_classes(exam_id,class_id) VALUES(?,?)').run(eid, cid);
  const Q = [
    ['mcq', 'What is $\\frac{1}{2}+\\frac{1}{3}$?', [{ id: 'a', text: '$\\frac{2}{5}$' }, { id: 'b', text: '$\\frac{5}{6}$' }, { id: 'c', text: '$\\frac{1}{6}$' }], { correct: ['b'] }, {}, 2, 'Fractions'],
    ['tf', 'The derivative of $x^2$ is $2x$.', [], { correct: 'true' }, {}, 1, 'Calculus'],
    ['numeric', 'Solve $3x-7=11$. Enter $x$.', [], { value: 6, tol: 0, tolType: 'abs', decimals: null }, {}, 2, 'Algebra'],
    ['numeric', 'Give $\\pi$ to 2 decimal places.', [], { value: 3.14159, tol: 0.005, tolType: 'abs', decimals: null }, {}, 1, 'Numbers'],
    ['short', 'What is the name of the longest side of a right triangle?', [], { accepted: ['hypotenuse'] }, { caseSensitive: false, review: true }, 1, 'Geometry'],
    ['written', 'Prove that the sum of two even integers is even.', [], { guide: 'Write a=2m, b=2n; a+b=2(m+n). 1 mark setup, 2 marks conclusion.' }, {}, 3, 'Proof']
  ];
    for (const [i, [type, stem, options, key, settings, marks, topic]] of Q.entries()) await db.prepare('INSERT INTO exam_questions(exam_id,pos,type,stem,options,key,settings,marks,topic) VALUES(?,?,?,?,?,?,?,?,?)').run(eid, i, type, stem, JSON.stringify(type === 'tf' ? [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }] : options), JSON.stringify(key), JSON.stringify(settings), marks, topic);
  });
  console.log('Demo data created. Sign in with teacher@demo.local / student1@demo.local ... password: Demo-Pass-2026');
  await close();
})().catch(e => { console.error('Seeding failed:', e.message); process.exit(1); });
