# Grading rules

How every question type is marked. These rules are implemented in `lib/grading.js` (`gradeAnswer`, `recompute`) and pinned by tests in
`tests/api.test.js` and `tests/hardening.test.js`. Marking runs **only on the server**, against the snapshot of the question taken when the
exam was published, so editing a question in the bank later never changes how an existing exam is marked.

An unanswered question (blank, or no option selected) always scores 0 and is final: it never waits for a teacher.

| Type | Full marks when | Otherwise | Teacher needed? |
|---|---|---|---|
| **Single choice** (`mcq`, one answer) | the selected option is the correct one | 0. No negative marking | No |
| **Multiple select** (`mcq`, "multi"), all-or-nothing (default) | exactly the correct set is selected, nothing extra | 0 | No |
| **Multiple select**, partial credit | marks = `max(0, (correct picked − wrong picked) / number of correct options) × marks`, rounded to 2 decimals | 0 floor | No |
| **True / false** | the answer matches the key | 0 | No |
| **Short answer** | the answer equals one of the accepted answers after trimming, collapsing repeated spaces, ignoring trailing full stops, and (unless "case sensitive" is on) ignoring capitals | 0, **and the answer is queued for a teacher** unless the question is set to "no review" | Only for non-matching answers (so a correct spelling variant is never lost) |
| **Numeric** | the number is within the tolerance of the key (see below) | 0 | Only when the answer cannot be read, or is ambiguous (below) |
| **Written / essay** | never automatic | — | **Always**; no marks are given until a teacher grades it |

## Numeric questions

* **Key and tolerance** are explicit per question: `value`, `tol`, and `tolType` = `abs` (± `tol`) or `rel` (± `tol` percent of the key).
* If the question sets `decimals`, the *key* is rounded to that many decimal places before comparing. The student's answer is never rounded; use a tolerance to accept imprecise answers.
* Accepted input: `3.14`, `3,14` (decimal comma), `1/2`, scientific notation, surrounding spaces. Anything unreadable goes to a teacher (it is never silently marked wrong).
* **Commas that could mean either "decimal point" or "thousands"** (for example `1,000`, which is 1 or 1000) are never guessed:
  * if neither reading is within tolerance the answer is wrong either way and is marked 0 automatically;
  * if either reading would be correct, the answer is left **pending** for the teacher, who sees exactly what the student typed.
  * `1,234,567` and `1,234.5` have only one sensible reading and are marked automatically.

## Totals, rounding, pending work

* An attempt's `score` is the sum of its per-question marks; `total` is the sum of the exam's question marks. Both are rounded to 2 decimals.
* `grading_status` is `pending` while any question still needs a teacher, otherwise `graded`.
* Percentages and pass/fail use the exam's pass mark if set, otherwise the school default (Settings). A result with pending questions is never reported as pass or fail.
* A teacher may override any mark. An override of an already-marked question needs a written reason, and every change is stored in the append-only grade history and the audit log.
* **Finalize** is refused while anything is pending. **Release** is a separate, explicit teacher action (or automatic on finalize, if the exam is set that way).

## Answer keys and explanations

Students never receive the key while taking the exam. After their result is released, correct answers and explanations are shown **only if the teacher enabled "show answers" and the exam has closed for everyone with no attempt still running**. Until then the result page tells the student why they are not shown yet. This stops a finished student from handing the key to classmates who have not taken the exam.
