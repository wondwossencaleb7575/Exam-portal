// Manual check of the REAL Gmail connection. Sends one test email; sends nothing else and prints no secrets.
//   npm run email:check                      -> only verifies the SMTP login
//   npm run email:check -- you@example.com   -> also sends a test message to that address
const mailer = require('../lib/mailer'), { testEmail } = require('../lib/emailTemplates');
(async () => {
  if (!mailer.configured()) { console.error('GMAIL_USER and GMAIL_APP_PASSWORD are not set (use .env or the environment).'); process.exit(2); }
  const v = await mailer.verify();
  if (!v.ok) { console.error(`SMTP login FAILED (${v.kind}): ${v.message}\nSee docs/EMAIL_OTP.md, "Troubleshooting".`); process.exit(1); }
  console.log(`SMTP login OK for ${mailer.senderAddress().replace(/^(.).*(@.*)$/, '$1***$2')}.`);
  const to = process.argv[2]; if (!to) return;
  try { const m = testEmail({ schoolName: 'Eagle Labs Exam Portal', baseUrl: mailer.baseUrl() }); await mailer.sendMail({ to, ...m }); console.log(`The mail server ACCEPTED a test message for ${to.replace(/^(.).*(@.*)$/, '$1***$2')}. Now check that inbox (and spam).`); }
  catch (e) { console.error(`Sending FAILED (${e.kind}): ${e.message}`); process.exit(1); }
})();
