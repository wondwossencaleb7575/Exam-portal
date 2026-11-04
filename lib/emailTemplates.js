'use strict';
// Email templates: a branded HTML version plus a plain-text version of every message. Every dynamic value is HTML-escaped.
// Layout uses tables and inline styles because email clients ignore most modern CSS. No scripts, no tracking pixels.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAVY = '#0b1f4d', YELLOW = '#f4b431';
const safeColor = c => /^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : NAVY;
const safeBase = u => /^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u).replace(/\/+$/, '') : '';

const PURPOSE = {
  login: { subject: 'sign-in verification code', lead: 'Use this code to finish signing in to the exam portal.', ignore: 'If you did not just try to sign in, someone may know your password. Do not enter the code, and tell your administrator.' },
  code_login: { subject: 'sign-in code', lead: 'Use this code to sign in to the exam portal. You asked to sign in with a code instead of a password.', ignore: 'If you did not ask for this code, ignore this email: nobody can sign in to your account without it. Tell your teacher if you keep receiving it.' },
  password_reset: { subject: 'password reset code', lead: 'Use this code to confirm that you want to reset your password.', ignore: 'If you did not ask to reset your password, ignore this email and tell your administrator.' }
};

// otpEmail({ name, code, minutes, purpose, schoolName, brandColor, baseUrl }) -> { subject, text, html }
function otpEmail({ name, code, minutes, purpose = 'login', schoolName = 'Eagle Labs Exam Portal', brandColor, baseUrl }) {
  const P = PURPOSE[purpose] || PURPOSE.login, brand = safeColor(brandColor), base = safeBase(baseUrl), digits = String(code).split('').join(' ');
  const subject = `${schoolName}: your ${P.subject}`;
  const text = [
    `${schoolName} (Eagle Labs)`, '',
    `Hello ${name || 'there'},`, '',
    P.lead, '',
    `    Your verification code: ${code}`, '',
    `This code expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can be used only once.`, '',
    'DO NOT SHARE THIS CODE. No teacher, administrator or member of Eagle Labs will ever ask you for it.',
    P.ignore, '',
    base ? `Portal: ${base}` : '',
    'This is an automatic message. Please do not reply.'
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  const logo = base ? `<img src="${esc(base)}/img/emblem.png" width="44" height="44" alt="Eagle Labs" style="display:block;border:0;background:#fff;border-radius:10px;padding:3px">` : '';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7fa;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your ${esc(P.subject)} is inside. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fa"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #d9dfe8;border-radius:14px;overflow:hidden">
<tr><td style="background:${brand};padding:18px 24px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${logo ? `<td style="padding-right:12px">${logo}</td>` : ''}<td style="color:#ffffff;font-size:18px;font-weight:700;line-height:1.3">${esc(schoolName)}<div style="font-size:12px;font-weight:400;color:#c3d2f5">Powered by Eagle Labs</div></td></tr></table></td></tr>
<tr><td style="padding:26px 24px 8px">
<p style="margin:0 0 12px;font-size:16px">Hello ${esc(name || 'there')},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#374151">${esc(P.lead)}</p>
<div style="text-align:center;margin:0 0 8px"><div style="display:inline-block;background:#e8effd;border:1px solid #bcd0f8;border-radius:12px;padding:14px 26px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:${brand}" aria-label="Verification code ${esc(digits)}">${esc(code)}</div></div>
<p style="margin:10px 0 20px;text-align:center;font-size:14px;color:#4b5563">Expires in <b>${minutes} minute${minutes === 1 ? '' : 's'}</b>. It works once.</p>
</td></tr>
<tr><td style="padding:0 24px 24px"><div style="background:#fdf1dc;border:1px solid #f0cf93;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5;color:#92400e"><b style="color:#92400e">Never share this code.</b> No teacher, administrator or member of Eagle Labs will ever ask for it.<br>${esc(P.ignore)}</div></td></tr>
<tr><td style="border-top:1px solid #eceff4;padding:14px 24px;font-size:12px;color:#6b7280">This is an automatic message, please do not reply.${base ? ` · <a href="${esc(base)}" style="color:#6b7280">${esc(base.replace(/^https?:\/\//, ''))}</a>` : ''}<div style="height:3px;width:44px;background:${YELLOW};margin-top:10px;border-radius:2px"></div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

// Sent by the administrator's "Send test email" button. Contains no code.
function testEmail({ schoolName = 'Eagle Labs Exam Portal', brandColor, baseUrl }) {
  const brand = safeColor(brandColor), subject = `${schoolName}: email delivery test`;
  const text = `${schoolName} (Eagle Labs)\n\nThis is a test message from the exam portal. If you can read it, verification codes can reach this address.\n\nNo action is needed.`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head><body style="margin:0;background:#f6f7fa;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #d9dfe8;border-radius:14px;overflow:hidden"><tr><td style="background:${brand};padding:18px 24px;color:#fff;font-size:18px;font-weight:700">${esc(schoolName)}</td></tr><tr><td style="padding:24px"><p style="margin:0 0 10px;font-size:16px"><b>Email delivery test</b></p><p style="margin:0;font-size:15px;line-height:1.55;color:#374151">If you can read this, verification codes can reach this address. No action is needed.</p></td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}
module.exports = { otpEmail, testEmail, esc };
