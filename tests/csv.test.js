const test = require('node:test'), assert = require('node:assert/strict');
const CSV = require('../lib/csv');

test('parser: quoted commas, escaped quotes, Unicode and embedded newlines', () => {
  const text = 'name,note\r\n"Kebede, Abebe","He said ""hi"""\r\n"አበበ በቀለ","line one\nline two"\r\nplain,x\r\n';
  const { records } = CSV.parse(text);
  assert.deepEqual(records.map(r => r.cells), [['name', 'note'], ['Kebede, Abebe', 'He said "hi"'], ['አበበ በቀለ', 'line one\nline two'], ['plain', 'x']]);
  assert.deepEqual(records.map(r => r.line), [1, 2, 3, 5]); // line numbers stay correct after a multi-line value
});
test('parser: BOM, LF/CR endings, blank lines, trailing newline, semicolon and tab delimiters', () => {
  assert.deepEqual(CSV.parse('\ufeffa,b\n1,2\n\n3,4').records.map(r => r.cells), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(CSV.parse('a,b\r1,2\r').records.map(r => r.cells), [['a', 'b'], ['1', '2']]);
  const sc = CSV.parse('name;email\n"A; B";a@x.org\n'); assert.equal(sc.delimiter, ';'); assert.deepEqual(sc.records[1].cells, ['A; B', 'a@x.org']);
  assert.equal(CSV.parse('a\tb\n1\t2').delimiter, '\t');
  assert.deepEqual(CSV.parse('a,b,c\n1,,3\n,,').records.map(r => r.cells), [['a', 'b', 'c'], ['1', '', '3'], ['', '', '']]);
});
test('parser: malformed input is reported, not silently mangled', () => {
  assert.throws(() => CSV.parse('a,b\n"never closed,2\n'), /never closed/);
  const r = CSV.parse('a,b\nab"c,2\n"x"y,3\n').records;
  assert.match(r[1].err, /Unexpected quote/); assert.match(r[2].err, /after a closing quote/);
});
test('readTable: headers, aliases, required columns, ignored columns, extra values', () => {
  const spec = { required: ['email'], optional: ['full_name'], aliases: { name: 'full_name' } };
  const t = CSV.readTable('\ufeffE-mail Address,Name,Junk\nx@y.zz,"A, B",1\n', { ...spec, aliases: { ...spec.aliases, e_mail_address: 'email' } });
  assert.deepEqual(t.columns, ['email', 'full_name']); assert.deepEqual(t.ignored, ['junk']); assert.equal(t.rows[0].data.full_name, 'A, B'); assert.equal(t.rows[0].line, 2);
  assert.throws(() => CSV.readTable('name\nA\n', spec), /Missing required column\(s\): email/);
  assert.throws(() => CSV.readTable('email,email\na,b', spec), /more than once/);
  assert.throws(() => CSV.readTable('   ', spec), /empty/);
  assert.match(CSV.readTable('email\nA,B,C\n', spec).rows[0].parseError, /More values than header/);
});
test('limits: rows, bytes and field length', () => {
  const keep = { ...process.env };
  try {
    process.env.CSV_MAX_ROWS = '3'; assert.throws(() => CSV.parse('a\n1\n2\n3\n4\n'), /Too many rows/); assert.doesNotThrow(() => CSV.parse('a\n1\n2\n3\n'));
    delete process.env.CSV_MAX_ROWS; process.env.CSV_MAX_BYTES = '20'; assert.throws(() => CSV.readTable('email\n' + 'x'.repeat(40), { required: ['email'] }), /too large/);
    delete process.env.CSV_MAX_BYTES; assert.throws(() => CSV.parse('a\n' + 'x'.repeat(501)), /longer than 500/);
  } finally { delete process.env.CSV_MAX_ROWS; delete process.env.CSV_MAX_BYTES; }
});
test('serializer: quoting and spreadsheet-formula neutralisation', () => {
  assert.equal(CSV.cell('a,b'), '"a,b"'); assert.equal(CSV.cell('say "x"'), '"say ""x"""'); assert.equal(CSV.cell('l1\nl2'), '"l1\nl2"'); assert.equal(CSV.cell(null), ''); assert.equal(CSV.cell(7.5), '7.5'); assert.equal(CSV.cell(-3), '-3');
  for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x', '\r=x']) assert.ok(CSV.safe(bad).startsWith("'"), bad);
  assert.equal(CSV.safe('Normal -dash'), 'Normal -dash'); assert.equal(CSV.cell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
  const out = CSV.toCsv(['n', 'v'], [['Ann, "A"', '=1']]); assert.ok(out.startsWith('\ufeff')); assert.equal(out, '\ufeffn,v\r\n"Ann, ""A""",\'=1\r\n');
  // round trip: whatever we write, the parser reads back (apart from the deliberate apostrophe on formulas)
  const rows = [['Kebede, Abebe', 'q"uote', 'multi\nline', 'አበበ'], ['', ' pad ', ';semi', '']];
  assert.deepEqual(CSV.parse(CSV.toCsv(['a', 'b', 'c', 'd'], rows)).records.slice(1).map(r => r.cells), rows);
  assert.equal(CSV.safeName('../../etc/passwd; "x"'), 'etc-passwd-x.csv'); assert.ok(!/[\/"; ]/.test(CSV.safeName('a b/c"d;e')));
});
